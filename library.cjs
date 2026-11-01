/**
 * 飞牛音乐 · 本地曲库模块（library.cjs）
 *
 * 职责：把 MUSIC_DIR 里的音频文件变成一套「飞牛形状」的接口（/api/d/*）。
 * 设计原则：
 *   1. 文件系统是最稳的接口 —— 不调任何下载器的 API，谁下的歌都认
 *   2. guid 用「相对路径的 md5」—— 文件改名才变 ID，改动 mtime 不影响
 *   3. 索引落地 JSON + 内存 Map，启动先读缓存，后台增量扫
 *   4. 封面在扫描时抽出来落盘（按 sha1 去重），列表页才能秒开
 *
 * 依赖：music-metadata（纯 ESM，所以本文件用动态 import() 加载）
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

// ——————————————————————————— 配置 ———————————————————————————

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.ape', '.dsf', '.dff', '.wma']);
const AUDIO_MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.ape': 'audio/x-ape', '.dsf': 'audio/x-dsf',
  '.dff': 'audio/x-dff', '.wma': 'audio/x-ms-wma',
};
const IMG_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

const SCAN_INTERVAL_MS = 30 * 1000;   // 增量扫描间隔
const PARSE_CONCURRENCY = 4;          // 首次扫描并发解析数
// 解析逻辑一改就要提版本号：否则老索引里文件大小/时间没变，永远不会重新解析
const INDEX_VERSION = 4;

let MUSIC_DIR = '';                 // 第一个根（兼容日志/旧代码）
let MUSIC_DIRS = [];                // 全部根目录，MUSIC_DIRS 用逗号分隔
let DATA_DIR = '';
function indexPath() { return path.join(DATA_DIR, 'library.json'); }
function coverDir() { return path.join(DATA_DIR, 'covers'); }

// ——————————————————————————— 状态 ———————————————————————————

let tracks = [];                    // 排好序的曲目数组
const byGuid = new Map();           // guid -> track
const byPath = new Map();           // relPath -> track
let dirKey = '';                    // 索引对应的 MUSIC_DIR，换了目录要重扫
let ready = false;                  // 首次扫描是否完成
let scanning = false;
let scanTimer = null;
let mm = null;                      // music-metadata 模块句柄
let dirty = false;                  // 索引是否有变动待落盘
const lyricCache = new Map();       // guid -> { at, lines }  歌词按需解析的小缓存

// ——————————————————————————— 小工具 ———————————————————————————

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function getMusicMetadata() {
  if (!mm) mm = await import('music-metadata');
  return mm;
}

function normRel(p) { return p.split(path.sep).join('/'); }

// 分轨标记：曲库里存在「歌名 - 歌手 - 专辑.accompaniment.flac / .vocals.flac」这种命名，
// 不剥掉的话同一首歌会出现三个同名条目，专辑名还会带上尾巴
const STEM_SUFFIX = /\.(accompaniment|vocals|instrumental|inst|karaoke|伴奏|人声|纯音乐)$/i;
const STEM_LABEL = { accompaniment: '伴奏', vocals: '人声', instrumental: '伴奏', inst: '伴奏', karaoke: '伴奏', '伴奏': '伴奏', '人声': '人声', '纯音乐': '纯音乐' };

/** 从文件名里剥出分轨标记，返回 { base, stem } */
function splitStem(name) {
  const m = STEM_SUFFIX.exec(name);
  if (!m) return { base: name, stem: '' };
  return { base: name.slice(0, m.index), stem: STEM_LABEL[m[1].toLowerCase()] || STEM_LABEL[m[1]] || '' };
}

/**
 * 标签清洗：有些 WAV/APE 的 ID3 是 GBK 或干脆编码坏了，
 * 解析出来是一串问号（"众妙" → "??"）。这种值当它不存在，
 * 让文件名兜底，至少歌名是对的。
 */
function cleanTag(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  let q = 0;
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 63) q++;                                  // '?'
    if (c === 0xFFFD || c < 9) bad++;                   // 替换符 / 控制符
  }
  if (bad > 0) return '';
  if (q > 0 && q / s.length >= 0.5) return '';          // 问号过半 = 解码失败
  return s;
}

/** 文件名兜底：解析不出标签时，从 "A - B - C" 猜歌名/歌手/专辑 */
function parseFromFilename(rel) {
  const raw = path.basename(rel).replace(/\.[^.]+$/, '').trim();
  const { base, stem } = splitStem(raw);
  // "给你… - 李健 - .mp3" 这种**末尾空段**要先补回来再数段数，
  // 否则滤/trim 完就只剩两段，会被当成"歌手 - 歌名"，把歌手当歌名。
  // 先剥掉时间戳后缀，再识别 "(06) [李健] 众妙" 这种中文合集常见命名
  const base2 = base.replace(/_\d{12,14}$/, '').trim();
  const mBracket = /^\(?\d{1,3}\)?[\s.]*\[([^\]]+)\]\s*(.+)$/.exec(base2);
  if (mBracket) {
    return { title: mBracket[2].trim(), artist: mBracket[1].trim(), album: '', stem };
  }

  const hasEmptyTail = /\s-\s*$/.test(base);
  const body = hasEmptyTail ? base.replace(/\s-\s*$/, '') : base;
  const segs = body.split(/\s+-\s+/).map((s) => s.trim());
  if (hasEmptyTail) segs.push('');

  if (segs.length >= 3) {
    // 中文下载器常见：歌名 - 歌手 - 专辑（专辑可能为空）
    return { title: segs[0], artist: segs[1], album: segs.slice(2).filter(Boolean).join(' / '), stem };
  }
  if (segs.length === 2 && segs[0] && segs[1]) {
    // 任务书约定：周杰伦 - 晴天.mp3 → 歌手 - 歌名
    return { title: segs[1], artist: segs[0], album: '', stem };
  }
  const one = base.replace(/[\s\-–—_]+$/, '');
  return { title: one || base || '未知曲目', artist: '', album: '', stem };
}

/** 找同名 .lrc（大小写、多级后缀都试一遍） */
function findSidecarLrc(abs) {
  const dir = path.dirname(abs);
  const base = path.basename(abs).replace(/\.[^.]+$/, '');
  for (const name of [base + '.lrc', base + '.LRC', base + '.Lrc']) {
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return '';
}

function readTextLrc(p) {
  try {
    const buf = fs.readFileSync(p);
    // 国内 .lrc 一半是 GBK，先看有没有 UTF-8 BOM / 能否无损 decode
    let txt = buf.toString('utf8');
    if (txt.includes('\uFFFD')) {
      try { txt = new TextDecoder('gbk').decode(buf); } catch (e) {}
    }
    return txt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  } catch (e) { return ''; }
}

const LRC_TS = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/;

/** syncText 的毫秒 → [mm:ss.xx] */
function msToLrcTs(ms) {
  const t = Math.max(0, Number(ms) || 0);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return '[' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0') + ']';
}

/**
 * 内嵌歌词统一成带时间戳的 LRC 文本。
 * 关键点：Vorbis LYRICS / SYLT 解析出来的 text 往往被剥掉了时间戳，
 * 真正的时间在 syncText 里 —— 不从这里补回去，前端 parseLrc 会当作"暂无歌词"。
 */
function extractEmbeddedLyric(common) {
  const l = common && common.lyrics;
  if (!l) return '';
  const arr = Array.isArray(l) ? l : [l];
  const out = [];
  for (const item of arr) {
    if (!item) continue;
    if (typeof item === 'string') { if (item.trim()) out.push(item); continue; }

    const text = typeof item.text === 'string' ? item.text
      : typeof item.lyric === 'string' ? item.lyric : '';
    const sync = Array.isArray(item.syncText) ? item.syncText : null;

    if (text && LRC_TS.test(text)) { out.push(text); continue; }   // 已经是 LRC，原样用
    if (sync && sync.length) {
      const lines = sync
        .filter((s) => s && typeof s.text === 'string' && s.text.trim())
        .map((s) => msToLrcTs(s.timestamp) + s.text.trim());
      if (lines.length) { out.push(lines.join('\n')); continue; }
    }
    if (text.trim()) out.push(text.trim());
    else if (typeof item.syncText === 'string' && item.syncText.trim()) out.push(item.syncText.trim());
  }
  return out.join('\n');
}

// ——————————————————————————— 扫目录 ———————————————————————————

/** 递归列出音频文件（只 readdir + stat，不解析，很快） */
async function walkAudioFiles(root, prefix) {
  const out = [];
  const pre = prefix ? prefix + '/' : '';
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = relDir ? path.join(root, relDir) : root;
    let ents;
    try { ents = await fsp.readdir(absDir, { withFileTypes: true }); }
    catch (e) { continue; }                       // 权限不足 / 目录消失：跳过，不炸
    for (const ent of ents) {
      if (ent.name.startsWith('.')) continue;      // @eaDir / .DS_Store 之类
      const rel = relDir ? relDir + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { stack.push(rel); continue; }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) continue;
      let st;
      try { st = await fsp.stat(path.join(root, rel)); } catch (e) { continue; }
      out.push({ rel: pre + rel, abs: path.join(root, rel), ext, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/** 并发受限的 map */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = new Array(Math.min(limit, list.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= list.length) return;
      out[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 解析单个文件 → 曲目记录。任何异常都降级成「文件名当标题」，绝不抛 */
async function parseOne(file) {
  const abs = file.abs || path.join(MUSIC_DIR, file.rel);
  const guid = md5(file.rel);
  const fallback = parseFromFilename(file.rel);

  const rec = {
    guid,
    relPath: file.rel,
    abs,
    size: file.size,
    mtimeMs: Math.round(file.mtimeMs),
    title: fallback.title,
    artist: fallback.artist,
    album: fallback.album,
    albumArtist: '',
    trackNo: 0,
    year: '',
    duration: 0,          // 毫秒
    format: file.ext.slice(1),
    coverId: '',
    hasEmbeddedLyric: false,
    parsed: false,        // 标签是否解析成功（false = 走文件名兜底）
  };

  try {
    const m = await getMusicMetadata();
    const r = await m.parseFile(abs, { duration: true, skipPostHeaders: true });
    const c = r.common || {};
    const f = r.format || {};

    rec.parsed = true;
    const tagTitle = cleanTag(c.title);
    if (tagTitle) rec.title = tagTitle;
    const artist = cleanTag(c.artist || (Array.isArray(c.artists) ? c.artists.join(' / ') : ''));
    if (artist) rec.artist = artist;
    const tagAlbum = cleanTag(c.album);
    if (tagAlbum) rec.album = tagAlbum;
    rec.albumArtist = cleanTag(c.albumartist);
    rec.trackNo = Number(c.track && c.track.no) || 0;
    rec.year = c.year ? String(c.year) : '';
    rec.duration = f.duration ? Math.round(f.duration * 1000) : 0;   // 秒 → 毫秒
    if (f.container) rec.format = String(f.container).toLowerCase();

    // —— 封面：抽出来按内容 sha1 落盘，同专辑多首歌自动共用一份 ——
    const pics = c.picture || [];
    if (pics.length) {
      const pic = m.selectCover(pics) || pics[0];
      if (pic && pic.data && pic.data.length) {
        const buf = Buffer.isBuffer(pic.data) ? pic.data : Buffer.from(pic.data);
        if (buf.length <= 12 * 1024 * 1024) {           // 12MB 以上的封面多半是内嵌整轨扫描图，跳过
          const id = sha1(buf);
          const ext = (pic.format || 'image/jpeg').includes('png') ? '.png'
            : (pic.format || '').includes('webp') ? '.webp' : '.jpg';
          const target = path.join(coverDir(), id + ext);
          if (!fs.existsSync(target)) {
            await fsp.mkdir(coverDir(), { recursive: true }).catch(() => {});
            await fsp.writeFile(target, buf).catch(() => {});
          }
          rec.coverId = id + ext;
        }
      }
    }

    if (extractEmbeddedLyric(c)) rec.hasEmbeddedLyric = true;
  } catch (e) {
    // APE / DSF / 损坏文件：解析失败是预期内的，降级用文件名，不跳过整个文件
    rec.parsed = false;
  }

  // 分轨文件（伴奏/人声）在标题上打标记，否则同一首歌在列表里三个一样名字
  if (fallback.stem) {
    rec.stem = fallback.stem;
    if (!new RegExp('（' + fallback.stem + '）$').test(rec.title)) rec.title += '（' + fallback.stem + '）';
  }
  return rec;
}

// ——————————————————————————— 索引维护 ———————————————————————————

function sortTracks() {
  tracks.sort((a, b) => {
    const t = String(a.title).localeCompare(String(b.title), 'zh-CN');
    if (t !== 0) return t;
    return String(a.relPath).localeCompare(String(b.relPath), 'zh-CN');
  });
  byGuid.clear();
  byPath.clear();
  for (const t of tracks) { byGuid.set(t.guid, t); byPath.set(t.relPath, t); }
}

function saveIndex() {
  if (!dirty || !DATA_DIR) return;
  try {
    const payload = { version: INDEX_VERSION, dir: dirKey, savedAt: Date.now(), tracks };
    const tmp = indexPath() + '.tmp';
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, indexPath());
    dirty = false;
  } catch (e) { /* 落盘失败不影响内存索引 */ }
}

function loadIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    if (!j || j.version !== INDEX_VERSION || j.dir !== dirKey || !Array.isArray(j.tracks)) return false;
    tracks = j.tracks;
    sortTracks();
    return true;
  } catch (e) { return false; }
}

/**
 * 扫描。full=true 时清空重建；增量模式只解析新增/变更的文件。
 * 返回 { added, removed, changed, total, ms }
 */
async function scan(opts) {
  const full = !!(opts && opts.full);
  if (scanning) return { skipped: true };
  scanning = true;
  const t0 = Date.now();
  try {
    if (!MUSIC_DIRS.length) return { skipped: true };

    // 多根目录：每个根扫一遍，多根时用目录名当前缀，保证 relPath 不撞
    const found = [];
    const multi = MUSIC_DIRS.length > 1;
    for (const root of MUSIC_DIRS) {
      const label = multi ? (path.basename(root) || 'root') : '';
      const items = await walkAudioFiles(root, label);
      for (const it of items) found.push(it);
    }
    if (full) { tracks = []; byGuid.clear(); byPath.clear(); }

    const seen = new Set();
    const todo = [];
    for (const f of found) {
      seen.add(f.rel);
      const old = byPath.get(f.rel);
      if (!old || old.size !== f.size || old.mtimeMs !== Math.round(f.mtimeMs)) todo.push(f);
    }

    let removed = 0;
    for (let i = tracks.length - 1; i >= 0; i--) {
      if (!seen.has(tracks[i].relPath)) { tracks.splice(i, 1); removed++; }
    }

    if (todo.length) {
      const parsed = await mapLimit(todo, PARSE_CONCURRENCY, parseOne);
      for (const rec of parsed) {
        const idx = tracks.findIndex((t) => t.relPath === rec.relPath);
        if (idx >= 0) tracks[idx] = rec; else tracks.push(rec);
      }
    }

    if (todo.length || removed || full) { sortTracks(); dirty = true; saveIndex(); }
    return { added: todo.length, removed, changed: todo.length, total: tracks.length, ms: Date.now() - t0 };
  } finally {
    scanning = false;
  }
}

/** 初始化：先读缓存秒开，再后台扫（full 由调用方决定） */
async function init(options) {
  const o = options || {};
  // 支持多目录：MUSIC_DIRS 用逗号分隔；只给一个就是单目录（老配置照样能用）
  const rawRoots = (Array.isArray(o.musicDirs) ? o.musicDirs.join(',') : '') ||
                   process.env.MUSIC_DIRS || process.env.MUSIC_DIR || '';
  MUSIC_DIRS = String(rawRoots).split(/[,;]/).map((x) => x.trim()).filter(Boolean).map((x) => path.resolve(x));
  MUSIC_DIR = MUSIC_DIRS[0] || '';
  DATA_DIR = o.dataDir || process.env.FN_MUSIC_DATA_DIR || __dirname;
  dirKey = MUSIC_DIRS.join('|');
  try { fs.mkdirSync(coverDir(), { recursive: true }); } catch (e) {}

  if (!MUSIC_DIRS.length) {
    ready = true;
    return { enabled: false, reason: '未设置 MUSIC_DIR / MUSIC_DIRS' };
  }

  const loaded = loadIndex();
  ready = loaded;                       // 有缓存先可读，没缓存等首扫完

  const doScan = async () => {
    const r = await scan({ full: !loaded });
    ready = true;
    console.log('[曲库] 扫描完成', JSON.stringify(r), '目录=' + MUSIC_DIRS.join(', '));
  };

  // 有缓存 → 立刻可用，后台增量补；没缓存 → 必须等首扫完，
  // 否则用户打开页面看到空列表会以为坏了（几千首也就几十秒，比"看起来是空的"好）
  if (o.blocking || !loaded) { await doScan(); }
  else { setTimeout(doScan, 0); }

  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(async () => {
    const r = await scan({ full: false });
    if (r && (r.added || r.removed)) console.log('[曲库] 增量更新', JSON.stringify(r));
  }, SCAN_INTERVAL_MS);
  if (scanTimer.unref) scanTimer.unref();

  return { enabled: true, fromCache: loaded };
}

function getLibraryCount() { return tracks.length; }
function isReady() { return ready; }
function isEnabled() { return MUSIC_DIRS.length > 0; }

// ——————————————————————————— 对外数据形状 ———————————————————————————

/** 内部记录 → 飞牛曲目形状（前端 normalizeTrack 直接吃） */
function toApiTrack(t) {
  const artist = t.artist || '未知歌手';
  return {
    guid: t.guid,
    title: t.title || '未知曲目',
    name: t.title || '未知曲目',
    artists: [{ guid: md5('artist:' + artist), name: artist }],
    artist,                                  // 兼容只读 t.artist 的分支
    album: {
      guid: t.album ? md5('album:' + t.album) : '',
      name: t.album || '',
      coverId: t.coverId || '',
    },
    coverId: t.coverId || '',
    duration: t.duration || 0,
    format: t.format || '',
    audioSpec: { duration: t.duration || 0, extension: t.format || '' },
    size: t.size,
    trackNo: t.trackNo || 0,
    isFavorite: false,
  };
}

function paged(list, page, size) {
  const p = Math.max(1, Number(page) || 1);
  // 上限放到 5000：本地曲库是自己扫的，一次全给也比翻页体验好
  const s = Math.max(1, Math.min(5000, Number(size) || 300));
  return { items: list.slice((p - 1) * s, p * s), total: list.length, page: p, size: s };
}

// ——————————————————————————— 歌词 ———————————————————————————

async function getLyricText(track) {
  if (!track) return '';
  const cached = lyricCache.get(track.guid);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.text;

  const abs = track.abs || path.join(MUSIC_DIR, track.relPath);
  let text = '';
  // 1) 内嵌歌词优先
  if (track.hasEmbeddedLyric) {
    try {
      const m = await getMusicMetadata();
      const r = await m.parseFile(abs, { duration: false, skipPostHeaders: true, skipCovers: true });
      text = extractEmbeddedLyric(r.common);
    } catch (e) {}
  }
  // 2) 同名 .lrc
  if (!text.trim()) {
    const lrc = findSidecarLrc(abs);
    if (lrc) text = readTextLrc(lrc);
  }
  lyricCache.set(track.guid, { at: Date.now(), text });
  if (lyricCache.size > 300) lyricCache.delete(lyricCache.keys().next().value);
  return text;
}

// ——————————————————————————— 封面 ———————————————————————————

function defaultCoverPath() {
  for (const p of [path.join(__dirname, 'icon_512.png'), path.join(DATA_DIR, 'icon_512.png')]) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return '';
}

function serveCover(res, coverId) {
  // coverId 形如 "<40位sha1>.jpg"；必须整串校验，不能逐字符过滤（会把扩展名的 j/p/g 削掉）
  const safe = String(coverId || '').trim();
  if (/^[a-f0-9]{40}\.(jpg|jpeg|png|webp|gif)$/i.test(safe)) {
    const p = path.join(coverDir(), safe);
    try {
      if (fs.existsSync(p)) {
        const ext = path.extname(p).toLowerCase();
        const data = fs.readFileSync(p);
        res.writeHead(200, {
          'Content-Type': IMG_MIME[ext] || 'image/jpeg',
          'Content-Length': data.length,
          'Cache-Control': 'public, max-age=86400',
        });
        return res.end(data);
      }
    } catch (e) {}
  }
  const d = defaultCoverPath();
  if (d) {
    try {
      const data = fs.readFileSync(d);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Cache-Control': 'public, max-age=3600' });
      return res.end(data);
    } catch (e) {}
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('no cover');
}

// ——————————————————————————— 音频流（Range 命门） ———————————————————————————

function serveStream(req, res, track) {
  const abs = track.abs || path.join(MUSIC_DIR, track.relPath);
  let st;
  try { st = fs.statSync(abs); }
  catch (e) { return json(res, 404, { code: -1, msg: '文件不存在或已被移走' }); }

  const mime = AUDIO_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const total = st.size;
  const range = req.headers.range;

  const baseHeaders = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };

  // —— 有 Range：206 Partial Content ——
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      return res.end();
    }
    let start, end;
    if (m[1] === '' && m[2] !== '') {          // bytes=-500 末尾 N 字节
      start = Math.max(0, total - Number(m[2]));
      end = total - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? total - 1 : Number(m[2]);
    }
    if (isNaN(start) || isNaN(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      return res.end();
    }
    end = Math.min(end, total - 1);
    const headers = Object.assign({}, baseHeaders, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Content-Length': end - start + 1,
    });
    res.writeHead(206, headers);
    if (req.method === 'HEAD') return res.end();
    const rs = fs.createReadStream(abs, { start, end });
    rs.on('error', () => { try { res.destroy(); } catch (e) {} });
    res.on('close', () => { try { rs.destroy(); } catch (e) {} });
    return rs.pipe(res);
  }

  // —— 无 Range：完整 200，但一定要带 Accept-Ranges，播放器才会来要分段 ——
  res.writeHead(200, Object.assign({}, baseHeaders, { 'Content-Length': total }));
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(abs);
  rs.on('error', () => { try { res.destroy(); } catch (e) {} });
  res.on('close', () => { try { rs.destroy(); } catch (e) {} });
  rs.pipe(res);
}

// ——————————————————————————— 路由 ———————————————————————————

/**
 * 处理 /api/d/* —— 路径与飞牛 /api/p/* 一一对应，只换数据源
 * @param {string} subPath 已去掉 '/api/d' 前缀，如 '/track/list'
 */
async function handleLocalApi(req, res, subPath, params) {
  if (!MUSIC_DIRS.length) {
    return json(res, 503, { code: -1, msg: '本地曲库未启用（未设置 MUSIC_DIR / MUSIC_DIRS）' });
  }
  const p = subPath.split('?')[0];
  const get = (k) => (params && params.get) ? (params.get(k) || '') : '';

  // —— 曲目列表 ——
  if (p === '/track/list') {
    const { items, total, page, size } = paged(tracks, get('page'), get('size'));
    return json(res, 200, { code: 0, data: { tracks: items.map(toApiTrack), total, page, size } });
  }

  // —— 搜索（内存索引模糊匹配，不转发给下载器）——
  if (p === '/search/track') {
    const q = get('q').trim().toLowerCase();
    if (!q) return json(res, 200, { code: 0, data: { tracks: [], total: 0 } });
    const terms = q.split(/\s+/).filter(Boolean);
    const hit = tracks.filter((t) => {
      const hay = (t.title + ' ' + t.artist + ' ' + t.album + ' ' + t.relPath).toLowerCase();
      return terms.every((w) => hay.includes(w));
    });
    const { items, total, page, size } = paged(hit, get('page'), get('size') || '100');
    return json(res, 200, { code: 0, data: { tracks: items.map(toApiTrack), total, page, size } });
  }

  // —— 音频流 ——
  if (p === '/track/stream') {
    const t = byGuid.get(get('guid'));
    if (!t) return json(res, 404, { code: -1, msg: '曲目不存在' });
    return serveStream(req, res, t);
  }

  // —— 封面 ——
  if (p === '/static/cover') return serveCover(res, get('coverId'));

  // —— 歌词 ——
  if (p === '/lyric/list') {
    const t = byGuid.get(get('trackGUID'));
    const text = t ? await getLyricText(t) : '';
    return json(res, 200, { code: 0, data: { list: text ? [{ content: text }] : [], total: text ? 1 : 0 } });
  }

  // —— 专辑列表 ——
  if (p === '/album/list') {
    const map = new Map();
    for (const t of tracks) {
      const name = t.album || '未知专辑';
      let a = map.get(name);
      if (!a) {
        a = { guid: md5('album:' + name), name, title: name, coverId: '', artists: [], trackCount: 0, _ar: new Map() };
        map.set(name, a);
      }
      a.trackCount++;
      if (!a.coverId && t.coverId) a.coverId = t.coverId;
      if (t.artist) a._ar.set(t.artist, 1);
    }
    const albums = [...map.values()].sort((x, y) => x.name.localeCompare(y.name, 'zh-CN'));
    for (const a of albums) { a.artists = [...a._ar.keys()].map((n) => ({ name: n })); delete a._ar; }
    const { items, total, page, size } = paged(albums, get('page'), get('size') || '100');
    return json(res, 200, { code: 0, data: { albums: items, total, page, size } });
  }

  // —— 歌手列表 ——
  if (p === '/artist/list-all') {
    const map = new Map();
    for (const t of tracks) {
      const name = t.artist || '未知歌手';
      let a = map.get(name);
      if (!a) { a = { guid: md5('artist:' + name), name, title: name, coverId: '', trackCount: 0 }; map.set(name, a); }
      a.trackCount++;
      if (!a.coverId && t.coverId) a.coverId = t.coverId;
    }
    const artists = [...map.values()].sort((x, y) => x.name.localeCompare(y.name, 'zh-CN'));
    return json(res, 200, { code: 0, data: { artists, list: artists, total: artists.length } });
  }

  // —— 专辑详情 ——
  if (p === '/track/album-detail/list') {
    const g = get('albumGUID');
    const hit = tracks.filter((t) => md5('album:' + (t.album || '未知专辑')) === g);
    const { items, total, page, size } = paged(hit, get('page'), get('size'));
    return json(res, 200, { code: 0, data: { tracks: items.map(toApiTrack), total, page, size } });
  }

  // —— 歌手详情 ——
  if (p === '/track/artist-detail/list') {
    const g = get('artistGUID');
    const hit = tracks.filter((t) => md5('artist:' + (t.artist || '未知歌手')) === g);
    const { items, total, page, size } = paged(hit, get('page'), get('size'));
    return json(res, 200, { code: 0, data: { tracks: items.map(toApiTrack), total, page, size } });
  }

  // —— 歌单 / 收藏：本地曲库不做，返回空（P1 再接，前端已能处理空态）——
  if (p === '/playlist/list') return json(res, 200, { code: 0, data: { playlists: [], list: [], total: 0 } });
  if (p === '/favorite-track/list') return json(res, 200, { code: 0, data: { tracks: [], list: [], total: 0 } });
  if (p === '/track/playlist-detail/list') return json(res, 200, { code: 0, data: { tracks: [], total: 0 } });

  return json(res, 404, { code: -1, msg: '未知接口：' + p });
}

module.exports = {
  init,
  scan,
  handleLocalApi,
  getLibraryCount,
  isReady,
  isEnabled,
  // 供调试
  _tracks: () => tracks,
  /** 给「音乐库管家」CLI 用：带真实绝对路径的完整清单 */
  exportFiles: () => tracks.map((t) => ({
    guid: t.guid,
    abs: t.abs || '',
    relPath: t.relPath,
    size: t.size,
    title: t.title,
    artist: t.artist || '',
    album: t.album || '',
    trackNo: t.trackNo || 0,
    format: t.format || '',
    duration: t.duration || 0,
    hasEmbeddedLyric: !!t.hasEmbeddedLyric,
  })),
};
