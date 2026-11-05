/**
 * 咔一下子音乐 · 下载模块（downloader.cjs）
 *
 * 职责：把 go-music-dl 的 HTML 搜索页转成 JSON，并代理它的下载队列。
 *
 * 定位说明（很重要）：
 *   下载器**不是必须依赖**。播放器单独跑也能用（扫目录、建库、播放）。
 *   只有当机器上确实跑着 go-music-dl 时，网页才会多出「下载」标签。
 *   这样把这个应用放进应用商店时，包里不含任何下载能力，审核风险最小。
 *
 * 地址怎么定（按优先级）：
 *   1. 环境变量 DL_BASE —— 显式指定，指哪打哪
 *   2. 自动探测：在常见地址上找（host.docker.internal / 127.0.0.1 × 28001/28011/8080）
 *      → 用户自己装了 go-music-dl，播放器就能直接联动，不用配置
 *
 * 为什么搜索要解析 HTML：
 *   翻过 go-music-dl 源码，/music/search 是服务端渲染 HTML（renderIndex → c.HTML），没有 JSON 版；
 *   但每首歌的 <li> 上挂了 data-id / data-source / data-name / data-artist / data-album /
 *   data-cover / data-duration，这些是它自己前端用的契约，比解析文案可靠得多。
 *   下载倒是有正经 JSON 接口：POST /music/api/downloads/queue
 */

'use strict';

const DL_PREFIX = '/music';
const EXPLICIT_BASE = (process.env.DL_BASE || '').trim().replace(/\/+$/, '');

/** 额外候选主机：连上 NAS 之后由 server.cjs 注入（桌面版下载器跑在 NAS 上，不在本机） */
let _extraHosts = [];
function setExtraHosts(list) {
  const next = Array.from(new Set((list || []).filter(Boolean)));
  if (next.join(',') !== _extraHosts.join(',')) _cache = { at: 0, base: '' };  // 换了主机就重探
  _extraHosts = next;
}

/** 候选地址：显式配置优先，否则在常见位置找 */
function candidateBases() {
  if (EXPLICIT_BASE) return [EXPLICIT_BASE];
  const ports = String(process.env.DL_PORTS || '28001,28011,8080')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // 桌面版：下载器（go-music-dl）是装在 NAS 上的，本机 127.0.0.1 永远探测不到，
  // 所以把"当前连着的这台 NAS"也加进候选，否则 Windows 端在线搜歌永远报"找不到下载器"
  const hosts = ['host.docker.internal', '127.0.0.1', 'localhost', ..._extraHosts];
  const out = [];
  for (const h of hosts) for (const p of ports) out.push('http://' + h + ':' + p);
  return out;
}

let _cache = { at: 0, base: '' };
const BASE_TTL = 60 * 1000;      // 找没找到都缓存 60 秒，别每次搜索都探一遍

async function probe(u) {
  try {
    const r = await fetch(u + DL_PREFIX + '/', { method: 'HEAD', signal: AbortSignal.timeout(900) });
    return r.ok || r.status === 404 || r.status === 405;   // 有响应就算在
  } catch (e) {
    return false;
  }
}

/** 解析出可用的下载器地址；找不到返回 '' */
async function base() {
  if (EXPLICIT_BASE) return EXPLICIT_BASE;
  if (Date.now() - _cache.at < BASE_TTL) return _cache.base;

  // 并发探，别串行等（9 个候选串行最坏 8 秒，页面会卡）
  const cands = candidateBases();
  let hit = '';
  try {
    hit = await Promise.any(
      cands.map((u) => probe(u).then((ok) => (ok ? u : Promise.reject(new Error('no')))))
    );
  } catch (e) {
    hit = '';
  }
  _cache = { at: Date.now(), base: hit };
  return hit;
}

async function needBase() {
  const b = await base();
  if (!b) throw new Error('没有找到下载器（装了 go-music-dl 会自动发现，或用 DL_BASE 指定）');
  return b;
}

// ——————————————————————————— HTML 解析 ———————————————————————————

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  if (!s) return '';
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const n = parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
      return isNaN(n) ? m : String.fromCodePoint(n);
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** 从一段 HTML 里抽出所有歌曲行 */
function parseSongsFromHtml(html) {
  if (!html) return [];
  const songs = [];
  const seen = new Set();
  const parts = String(html).split('<li class="song-card"');

  for (let i = 1; i < parts.length; i++) {
    const cut = parts[i].indexOf('>');
    const tag = cut === -1 ? parts[i] : parts[i].slice(0, cut);
    if (!tag.includes('data-id=')) continue;

    const attrs = {};
    const re = /\bdata-([a-z0-9-]+)\s*=\s*"([^"]*)"/gi;
    let m;
    while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = decodeEntities(m[2]);

    const id = (attrs['id'] || '').trim();
    const source = (attrs['source'] || '').trim();
    if (!id || !source) continue;

    const key = source + ':' + id;
    if (seen.has(key)) continue;
    seen.add(key);

    songs.push({
      id,
      source,
      name: (attrs['name'] || '').trim() || '未知曲目',
      artist: (attrs['artist'] || '').trim(),
      album: (attrs['album'] || '').trim(),
      cover: (attrs['cover'] || '').trim(),
      duration: Number(attrs['duration']) || 0,     // 秒
      albumId: (attrs['album-id'] || '').trim(),
    });
  }
  return songs;
}

/** 从页面里扒「共 N 首」这类汇总信息，拿不到就算了 */
function parseSummary(html) {
  const m = /找到\s*<span class="count">\s*(\d+)\s*<\/span>\s*首歌曲/.exec(String(html || ''));
  return m ? Number(m[1]) : null;
}

// ——————————————————————————— 搜索 ———————————————————————————

/**
 * 搜索歌曲
 * @returns {Promise<{songs: Array, total: number|null}>}
 */
async function searchSongs(keyword, opts) {
  const o = opts || {};
  const q = String(keyword || '').trim();
  if (!q) return { songs: [], total: 0 };
  const b = await needBase();

  const params = new URLSearchParams();
  params.set('q', q);
  params.set('type', o.type || 'song');
  // 服务端默认一页只渲染 30 行，这里显式要更多（实测 100 能拿到全部结果）
  params.set('page_size', String(Math.min(500, o.pageSize || 100)));
  // 不传 sources：让服务端用它自己的默认源集合，硬塞列表反而会漏源
  if (o.sources && o.sources.length) {
    for (const s of o.sources) params.append('sources', s);
  }

  const url = b + DL_PREFIX + '/search?' + params.toString();
  const r = await fetch(url, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': 'kayixiazi-music/2.1 (+local library)',
    },
    signal: AbortSignal.timeout(o.timeout || 25000),
  });

  if (!r.ok) throw new Error('搜索服务返回 HTTP ' + r.status);
  const html = await r.text();
  return { songs: parseSongsFromHtml(html), total: parseSummary(html) };
}

// ——————————————————————————— 下载队列 ———————————————————————————

/** go-music-dl 的写接口要求：必须带这个头，且同源（服务端调用天然同源） */
function writeHeaders() {
  return {
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

/**
 * 批量入队下载
 * @param {Array<{id,source,name,artist,album,cover}>} songs
 */
/**
 * 下载队列（我们自己维护）
 *
 * 为什么不用它的队列 API：这个版本的 go-music-dl **没有** /api/downloads/queue，
 * 它的下载是同步 GET —— `${API_ROOT}/download?id=&source=&name=&artist=&save_local=1`，
 * 带上 save_local=1 由它自己把文件写进下载目录，请求会一直挂到下载完成。
 * 所以这里排一个本地队列、串行触发，前端看到的进度是我们自己的状态。
 */
const TASKS = [];
const TASK_KEEP = 200;              // 只留最近 200 条，别无限涨
let pumping = false;

function pump() {
  if (pumping) return;
  pumping = true;
  (async () => {
    try {
      for (;;) {
        const t = TASKS.find((x) => x.Status === 'waiting');
        if (!t) break;
        t.Status = 'downloading';
        t.startedAt = Date.now();
        try {
          const b = await needBase();
          const q = new URLSearchParams({
            id: String(t.id),
            source: String(t.source),
            name: t.name || '',
            artist: t.artist || '',
            save_local: '1',
          });
          if (t.album) q.set('album', t.album);
          // 关键：必须 POST（GET 会 405），参数放查询串，还要带 X-Requested-With
          // —— save_local 是「写盘」操作，下载器会用这个头做同源校验，缺了直接 403
          const r = await fetch(b + DL_PREFIX + '/download?' + q.toString(), {
            method: 'POST',
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
            signal: AbortSignal.timeout(600000),      // 单首最多 10 分钟
          });
          const j = await r.json().catch(() => null);
          if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
          t.Status = 'done';
          t.Saved = (j && j.filename) || '';
          t.Skipped = !!(j && j.skipped);            // true = 库里已有同名，没重复下
        } catch (e) {
          t.Status = 'failed';
          t.Error = e.message || String(e);
        }
        t.finishedAt = Date.now();
      }
    } finally {
      pumping = false;
    }
  })();
}

async function enqueue(songs) {
  const list = (songs || []).filter((x) => x && x.id && x.source);
  if (!list.length) throw new Error('没有可下载的歌曲');
  await needBase();
  for (const x of list.slice(0, 200)) {
    TASKS.push({
      id: String(x.id),
      source: String(x.source),
      name: x.name || '',
      artist: x.artist || '',
      album: x.album || '',
      Name: (x.artist ? x.artist + ' - ' : '') + (x.name || ''),
      Status: 'waiting',
      Error: '',
      createdAt: Date.now(),
    });
  }
  if (TASKS.length > TASK_KEEP) TASKS.splice(0, TASKS.length - TASK_KEEP);
  pump();
  return { added: Math.min(list.length, 200), total: TASKS.length };
}

/** 队列状态（用于前端轮询"下完了没"） */
function queueStatus() {
  const counts = {};
  for (const t of TASKS) counts[t.Status] = (counts[t.Status] || 0) + 1;
  return {
    total: TASKS.length,
    counts,
    tasks: TASKS.slice().reverse().map((t) => ({
      Name: t.Name,
      Status: t.Status,
      Error: t.Error || '',
      Source: t.source,
      Size: t.Size || 0,
      Saved: t.Saved || '',
      Skipped: !!t.Skipped,
    })),
  };
}

/** 下载记录（完成后用它判断"该刷新曲库了"） */
async function records() {
  const b = await base();
  if (!b) return null;
  try {
    const r = await fetch(b + DL_PREFIX + '/api/downloads/records', {
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

/** 下载服务是否在线（前端据此决定显不显示「下载」入口） */
async function ping() {
  return !!(await base());
}

module.exports = {
  searchSongs,
  enqueue,
  queueStatus,
  records,
  ping,
  base,
  setExtraHosts,
  // 供测试
  _parseSongsFromHtml: parseSongsFromHtml,
  _parseSummary: parseSummary,
  _candidates: candidateBases,
};
