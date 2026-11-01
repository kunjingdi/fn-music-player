/**
 * 咔一下子音乐 · 桌面播放器（本地服务）
 * 零依赖，Node 18+ 直接跑。职责：
 *   1. 托管 index.html（同源，避免浏览器 CORS 拦截）
 *   2. 代理 /api/p/* 到飞牛 NAS 的 /music/api/v1/*，自动补 authx 签名 + music-token 会话
 *   3. 处理登录 / 登出
 * 飞牛音乐是逆向私有 API，接口签名以本机前端为准。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { exec } = require('child_process');

// —— 本地曲库（Docker 源）——
// —— 版本模式：一份代码出两个镜像 ——
// full = 完整版（自带曲库 + 播放 + 在线搜歌下载），给没有飞牛的人
// dl   = 纯下载版（只有搜歌下载页面，不给 /api/d/*），给已经有飞牛音乐的人
// 客户端自动发现靠 /api/health 里的 libEnabled，纯下载版必须是 false，否则会被扫到连空库
const MODE = (process.env.MODE || 'full').toLowerCase() === 'dl' ? 'dl' : 'full';
const isFull = MODE === 'full';

// 这个进程是「桌面应用里跑的服务」还是「容器里的服务」。
// 桌面版只是客户端，不能在自动发现里冒充 Docker 服务器 —— 否则电视会搜到
// 一台电脑和一台 NAS，连错就一片「加载失败」。
const IS_DESKTOP = !!process.versions.electron || String(process.env.FN_ROLE || '') === 'desktop';

// 曲库根目录：支持多个，用逗号分隔。MUSIC_DIRS 优先，MUSIC_DIR 兼容老配置
const musicRoots = () => String(process.env.MUSIC_DIRS || process.env.MUSIC_DIR || '')
  .split(/[,;]/).map((x) => x.trim()).filter(Boolean);

// 容器里 MUSIC_DIR 有值 → 用本模块；桌面版没有 → 只走远程反代（见 dockerBase）
// 纯下载版压根不加载曲库：既不扫目录，也不对外提供 /api/d/*
let lib = null;
if (isFull) {
  try { lib = require('./library.cjs'); }
  catch (e) { console.warn('[曲库] library.cjs 加载失败：' + e.message + '（/api/d 将不可用）'); }
}

// —— 下载器（在线搜歌 + 下歌），指向同 compose 里的 go-music-dl ——
// 两个版本都要：完整版给播放器页面用，纯下载版就是它的全部功能
let dl = null;
try { dl = require('./downloader.cjs'); }
catch (e) { console.warn('[下载] downloader.cjs 加载失败：' + e.message + '（搜索/下载不可用）'); }

const PORT = Number(process.env.PORT) || 8530;
const HOST = process.env.FN_HOST || '127.0.0.1';   // 桌面版只听本机；容器里设 0.0.0.0
const VERSION = '2.1.2';
const ROOT = __dirname;
// 数据目录：Electron 打包后 asar 只读，数据要写到用户目录；独立 node 运行时写回 ROOT
// 用函数延迟读取，因为 Electron 主进程在 app ready 后才设置 FN_MUSIC_DATA_DIR
function getDataDir() { return process.env.FN_MUSIC_DATA_DIR || ROOT; }
// 由 .vbs 启动时传 --no-autostart：node 只跑服务、不自己开窗口（开窗交给 .vbs，避开 360 拦截「后台进程唤浏览器」）
const NO_AUTOSTART = process.argv.includes('--no-autostart') || !!process.env.FN_MUSIC_NO_AUTOSTART;

// —— 签名常量 ——
// 来自飞牛音乐前端（前缀明文 + clientKey 异或解码）。开源版本不内置这两个值，
// 改为运行时从本机 config.local.json 或环境变量读取，避免把逆向成果直接公开。
// 取值优先级：环境变量 > 用户数据目录 > 源码目录 > exe 同级 > resources 目录
function loadLocalConfig() {
  const cands = [
    path.join(getDataDir(), 'config.local.json'),                            // 打包后用户自己放这里
    path.join(__dirname, 'config.local.json'),                               // 源码目录（开发时）
    path.join(path.dirname(process.execPath || ''), 'config.local.json'),    // exe 所在目录
  ];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'config.local.json'));
  for (const p of cands) {
    try {
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
        if (j.authxPrefix || j.clientKey) return j;
      }
    } catch (e) { /* 读坏了就当没有，继续找下一个 */ }
  }
  return {};
}
const _localCfg = loadLocalConfig();
const AUTHX_PREFIX = process.env.FN_AUTHX_PREFIX || _localCfg.authxPrefix || '';
const CLIENT_KEY = process.env.FN_CLIENT_KEY || _localCfg.clientKey || '';
const HAS_SIGN_KEY = !!(AUTHX_PREFIX && CLIENT_KEY);
if (!HAS_SIGN_KEY) {
  console.warn('[签名常量] 未配置 authxPrefix / clientKey，连接飞牛服务会失败。');
  console.warn('[签名常量] 把 config.local.example.json 复制为 config.local.json 并填入你自己的值。');
}
const API_BASE = '/music/api/v1';

// —— 会话状态（token 仅存内存；凭据/进度持久化到 settings.json）——
const session = { base: '', token: '', username: '', password: '' };

// —— 本地持久化：记住密码 + 上次播放进度 ——
const SETTINGS_FILE = () => path.join(getDataDir(), 'settings.json');
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE())) {
      const j = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
      if (j && typeof j === 'object') return j;
    }
  } catch (e) {}
  return {};
}
function saveSettings(patch) {
  try {
    const cur = loadSettings();
    const next = Object.assign({}, cur, patch);
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2));
  } catch (e) {}
}
function b64enc(s) { try { return Buffer.from(String(s), 'utf8').toString('base64'); } catch (e) { return ''; } }
function b64dec(s) { try { return Buffer.from(String(s), 'base64').toString('utf8'); } catch (e) { return ''; } }

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// 与前端 dk 一致：key 排序 + URLSearchParams + '+'→'%20'
function canonicalQuery(obj) {
  const u = new URLSearchParams();
  for (const k of Object.keys(obj || {}).sort()) {
    const v = obj[k];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) { for (const x of v) u.append(k, String(x)); }
    else u.append(k, String(v));
  }
  return u.toString().replace(/\+/g, '%20');
}

// 与前端 pk 一致：处理孤立 % 后 decode 再 md5，异常则退回原文
function hashPayload(str) {
  try {
    const t = str.replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
    return md5(decodeURIComponent(t));
  } catch (e) {
    return md5(str);
  }
}

// 生成 authx 头
function makeAuthx(method, pathname, queryObj, bodyStr) {
  if (!HAS_SIGN_KEY) {
    const e = new Error('缺少签名常量：请把 config.local.example.json 复制为 config.local.json，填入 authxPrefix 与 clientKey 后重启');
    e.code = 'NO_SIGN_KEY';
    throw e;
  }
  const isGet = method.toUpperCase() === 'GET';
  const nonce = String(Math.floor(Math.random() * 9e5) + 1e5);
  const ts = String(Date.now());
  const payloadHash = isGet ? hashPayload(canonicalQuery(queryObj)) : md5(bodyStr == null ? '' : bodyStr);
  const src = [AUTHX_PREFIX, pathname, nonce, ts, payloadHash, CLIENT_KEY].join('_');
  return `nonce=${nonce}&timestamp=${ts}&sign=${md5(src)}`;
}

// 持久化一个稳定的 deviceId（32 位 hex），登录要用
function deviceId() {
  const fp = path.join(getDataDir(), '.device_id');
  try {
    if (fs.existsSync(fp)) {
      const v = fs.readFileSync(fp, 'utf8').trim();
      if (/^[a-f0-9]{32}$/i.test(v)) return v;
    }
  } catch (e) {}
  const v = crypto.randomBytes(16).toString('hex');
  try { fs.writeFileSync(fp, v); } catch (e) {}
  return v;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function normalizeBase(raw) {
  let b = (raw || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (!/^https?:\/\//i.test(b)) b = 'http://' + b;
  return b;
}

// —— 桌面版连远程曲库：/api/d/* 反代到 NAS 上的容器 ——
// 跟代理飞牛一个思路，但对方是自己的容器，不需要 authx 签名
/* 存地址之前先问一句「你到底是不是曲库」。
   TV 端 1.2.7 就吃过这个亏：填什么存什么，填成投影仪自己的 IP 也照样显示
   「已连接」，之后所有 /api/d/* 全 503，用户完全看不出问题在哪。
   这里补上同样的校验，四条都要过：能应答 / 是咔一下子 / 带曲库 / 曲库不空。 */
async function checkDockerBase(base) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(base + '/api/health', {
      signal: ctl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'fnmusic-desktop-player' },
    });
    if (!r.ok) return { ok: false, msg: '这台没应答（HTTP ' + r.status + '），地址可能不对' };
    const j = await r.json();
    if (!j || j.app !== 'fnmusic') return { ok: false, msg: '这台不是咔一下子音乐服务' };
    if (!j.libEnabled) return { ok: false, msg: '这台是「仅下载」版，没有曲库' };
    const n = j.libCount || 0;
    if (n === 0) {
      return { ok: false, msg: j.libReady === false ? '曲库还在索引中，等一会儿再试' : '这台曲库是空的，还没导歌' };
    }
    return { ok: true, libCount: n, name: j.name || '', libReady: j.libReady !== false, mode: j.mode || 'full' };
  } catch (e) {
    return { ok: false, msg: '连不上这台（' + (e && e.message ? e.message : '超时') + '）' };
  } finally {
    clearTimeout(t);
  }
}

function dockerBase() {
  const s = loadSettings();
  return normalizeBase(s.dockerBase || process.env.FN_DOCKER_BASE || '');
}

// —————————————— 局域网自动发现（协议 v1）——————————————
// 客户端扫本网段 → GET http://<ip>:<port>/api/health
// 命中条件：code===0 && app==='fnmusic' && libEnabled===true
// Docker 端只要在 /api/health 里吐这两个字段，两边就能自动认出来。
const DISCOVER_PORTS = [8530, 8580];   // 容器内默认 8530，推荐映射 8580
const DISCOVER_TIMEOUT = 450;          // 单个探测超时（毫秒）。局域网内端口关闭会立刻 RST，
                                       // 只有「IP 不存在」才会等满超时，所以这个值越小扫得越快
const DISCOVER_BATCH = 96;             // 并发上限，别把路由器打崩

// 本机所在的 /24 网段（多个网卡会有多个；跳过虚拟网卡与链路本地）
function localSubnets() {
  const subs = new Set();
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    if (/^(vEthernet|VMware|VirtualBox|Loopback|vboxnet|docker|br-|utun|tun|tap)/i.test(name)) continue;
    for (const it of ifs[name] || []) {
      if (it.family !== 'IPv4' && it.family !== 4) continue;
      if (it.internal) continue;
      if (/^169\.254\./.test(it.address)) continue;   // 链路本地，说明没拿到 DHCP
      if (/^127\./.test(it.address)) continue;
      // /32 点对点隧道（企业 VPN、Tailscale、ZeroTier 这类），不是局域网，扫了纯浪费时间
      if (it.netmask === '255.255.255.255') continue;
      subs.add(it.address.split('.').slice(0, 3).join('.'));
    }
  }
  // 家庭/办公局域网 99% 在 192.168.x，排前面先扫，命中即停
  return [...subs].sort((a, b) => {
    const w = (s) => (s.startsWith('192.168.') ? 0 : s.startsWith('10.') ? 1 : 2);
    return w(a) - w(b);
  });
}

// 探测单个 host:port 是不是 咔一下子音乐 Docker 服务
async function probeHealth(host, port) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), DISCOVER_TIMEOUT);
  try {
    const r = await fetch('http://' + host + ':' + port + '/api/health', {
      signal: ctl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'fnmusic-discover/1' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    // 只认真正的服务器：桌面版（role=desktop）不参与自动发现
    if (!j || j.app !== 'fnmusic' || !j.libEnabled) return null;   // 不是，或者没挂曲库
    if (j.role === 'desktop') return null;                          // 别人的电脑，不是服务器
    return {
      base: 'http://' + host + ':' + port,
      name: j.name || '咔一下子音乐',
      version: j.version || '',
      libCount: j.libCount || 0,
      // 曲库还没索引完的容器也要能出现在列表里，但要标出来，
      // 否则用户以为「部署成功了怎么 0 首」
      libReady: j.libReady !== false,
      mode: j.mode || 'full',
      host, port,
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// 扫整个网段，返回命中的服务器列表（已去重、已排除自己）
async function discoverServers() {
  const subnets = localSubnets();
  if (!subnets.length) return { servers: [], reason: '没找到可用的局域网地址（可能没连网络）' };

  const selfPorts = new Set([PORT]);
  const selfIps = new Set(['127.0.0.1', 'localhost']);
  for (const name of Object.keys(os.networkInterfaces())) {
    for (const it of os.networkInterfaces()[name] || []) {
      if (it.family === 'IPv4' || it.family === 4) selfIps.add(it.address);
    }
  }

  const targets = [];
  for (const sub of subnets) {
    for (let i = 1; i <= 254; i++) {
      const host = sub + '.' + i;
      for (const port of DISCOVER_PORTS) {
        // 排除自己：同一台机器 + 同一端口，一定不是别的服务器
        if (selfIps.has(host) && selfPorts.has(port)) continue;
        targets.push([host, port]);
      }
    }
  }

  const found = [];
  for (let i = 0; i < targets.length; i += DISCOVER_BATCH) {
    const batch = targets.slice(i, i + DISCOVER_BATCH);
    const rs = await Promise.all(batch.map(([h, p]) => probeHealth(h, p)));
    for (const r of rs) if (r) found.push(r);
    // 这里原来有一句「已经找到就不必扫完，省时间」—— 那是错的。
    // targets 是 254 个 IP × 2 个端口，按 96 一批切，第三批（i=192）就退出，
    // 实际只覆盖到 x.1 ~ x.96，**97 以后的机器永远扫不到**。
    // 用户那台要是落在 171，exe 怎么点都只能说「没搜到」。
    // 现在老老实实扫完整轮，多花两秒，换一个不漏。
  }

  // 去重：同一台机器如果 8530 和 8580 都通（端口映射重复），只留一个
  const uniq = new Map();
  for (const f of found) {
    const k = f.host;
    if (!uniq.has(k) || (uniq.get(k).port !== 8530 && f.port === 8530)) uniq.set(k, f);
  }
  /* 排序规则和 TV 端 1.2.9 保持一致：
     曲库 >=20 首算有效节点，组内按 IP 数值升序（.90 排在 .171 前面），
     个位数曲库的空壳一律垫底。
     原来按 libCount 降序排，看着也「对」，但默认选中的是谁完全取决于歌多的那台，
     用户没法预期；现在默认那台就是「地址数值最小的有效节点」，说得出道理。 */
  const ipNum = (host) => {
    const m = String(host || '').match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
    if (!m) return 1e15;
    return (+m[1]) * 16777216 + (+m[2]) * 65536 + (+m[3]) * 256 + (+m[4]);
  };
  const byIp = (a, b) => (ipNum(a.host) - ipNum(b.host)) || ((a.port || 0) - (b.port || 0));
  const good = [], junk = [];
  for (const f of uniq.values()) ((f.libCount || 0) >= 20 ? good : junk).push(f);
  good.sort(byIp);
  junk.sort(byIp);
  const servers = good.concat(junk);
  return {
    servers,
    scanned: targets.length,
    subnets,
    reason: servers.length ? '' : '同网段内没搜到 Docker 曲库。请确认容器已启动、端口已映射（推荐 8580），或手动填写地址。',
  };
}

async function proxyLocalApi(req, res, subPath) {
  const base = dockerBase();
  if (!base) {
    return json(res, 503, { code: -1, msg: '本地曲库未启用（既没有 MUSIC_DIR，也没填 Docker 曲库地址）' });
  }
  const u = new URL(req.url, 'http://local');
  const target = base + '/api/d' + subPath + (u.search || '');
  const isStream = /(?:track\/stream|static\/cover)/.test(subPath);
  const headers = { 'Accept': '*/*', 'User-Agent': 'fnmusic-desktop-player/' + VERSION };
  if (req.headers.range) headers['Range'] = req.headers.range;

  let up;
  try {
    up = await fetch(target, {
      method: req.method,
      headers,
      signal: isStream ? undefined : AbortSignal.timeout(20000),
    });
  } catch (e) {
    return json(res, 502, { code: -1, msg: '无法连接 Docker 曲库：' + (e.cause?.message || e.message) });
  }

  const rh = collectRespHeaders(up.headers);
  if (!rh['content-type']) rh['content-type'] = isStream ? 'application/octet-stream' : 'application/json; charset=utf-8';
  res.writeHead(up.status, rh);
  if (!up.body) return res.end();
  const rs = Readable.fromWeb(up.body);
  rs.on('error', () => { try { res.destroy(); } catch (e) {} });
  res.on('close', () => { try { rs.destroy(); } catch (e) {} });
  rs.pipe(res);
}

// —— 在线搜歌 / 下载：给网页用的薄封装 ——
// 后端是 go-music-dl（同 compose 里的另一个容器），我们只做 HTML→JSON 和错误包装
// ——————————————————————————— 播放控制（服务端状态）———————————————————————————
// 为什么放服务端：网页里的 audio 元素只负责出声，真正的「现在放什么、播到哪、音量多少」
// 由这里说了算。CLI、AI、手机改的都是它，所有页面跟着变。
const ctl = { seq: 0, guid: '', paused: true, positionMs: 0, volume: 1, at: Date.now() };

function ctlTracks() {
  try { return (lib && lib._tracks ? lib._tracks() : []) || []; }
  catch (e) { return []; }
}

function ctlState() {
  const t = ctl.guid ? ctlTracks().find((x) => x.guid === ctl.guid) : null;
  return {
    seq: ctl.seq,
    guid: ctl.guid,
    paused: ctl.paused,
    playing: !!ctl.guid && !ctl.paused,
    positionMs: Math.round(ctl.positionMs || 0),
    volume: Number(ctl.volume),
    title: t ? t.title : '',
    artist: t ? (t.artist || '') : '',
    album: t ? (t.album || '') : '',
    coverId: t ? (t.coverId || '') : '',
    duration: t ? Math.round(t.duration || 0) : 0,
    format: t ? (t.format || '') : '',
    total: ctlTracks().length,
  };
}

function ctlBump() { ctl.seq++; ctl.at = Date.now(); return ctlState(); }

/** 按歌名/歌手模糊找一首；找不到返回 null */
function ctlFind(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const list = ctlTracks();
  return list.find((t) => String(t.title || '').toLowerCase() === q) ||
         list.find((t) => (String(t.title || '') + ' ' + (t.artist || '') + ' ' + (t.album || '')).toLowerCase().includes(q)) ||
         null;
}

/** 在全部曲目里前后挪一首 */
function ctlMove(step) {
  const list = ctlTracks();
  if (!list.length) return null;
  const i = list.findIndex((t) => t.guid === ctl.guid);
  const next = i === -1 ? 0 : (i + step + list.length) % list.length;
  return list[next];
}

async function handleCtlApi(req, res, subPath) {
  try {
    if (subPath === '/state') {
      return json(res, 200, { code: 0, data: ctlState() });
    }

    // 网页上报播放进度：只更新，不递增 seq（否则每秒都在「下命令」）
    if (subPath === '/tick' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (b.guid) {
        // 用户自己在网页上换了歌 → 当成一次操作，让别的终端也跟着换
        if (b.guid !== ctl.guid) {
          ctl.guid = b.guid;
          ctl.positionMs = 0;
          ctl.paused = !!b.paused;
          return json(res, 200, { code: 0, data: ctlBump() });
        }
        if (typeof b.positionMs === 'number') ctl.positionMs = b.positionMs;
        if (typeof b.paused === 'boolean') ctl.paused = b.paused;
      }
      return json(res, 200, { code: 0, data: ctlState() });
    }

    if (subPath === '/command' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const a = String(b.action || '').trim();

      if (a === 'play') {
        let t = null;
        if (b.guid) t = ctlTracks().find((x) => x.guid === b.guid) || null;
        if (!t && b.query) t = ctlFind(b.query);
        if (!t && b.random) {
          const list = ctlTracks();
          if (list.length) t = list[Math.floor(Math.random() * list.length)];
        }
        if (!t) return json(res, 404, { code: -1, msg: '没找到这首歌：' + (b.query || b.guid || '') });
        ctl.guid = t.guid;
        ctl.paused = false;
        ctl.positionMs = 0;
        return json(res, 200, { code: 0, data: ctlBump() });
      }

      if (a === 'pause') { ctl.paused = true; return json(res, 200, { code: 0, data: ctlBump() }); }
      if (a === 'resume') { ctl.paused = false; return json(res, 200, { code: 0, data: ctlBump() }); }
      if (a === 'toggle') { ctl.paused = !ctl.paused; return json(res, 200, { code: 0, data: ctlBump() }); }
      if (a === 'stop') { ctl.paused = true; ctl.positionMs = 0; return json(res, 200, { code: 0, data: ctlBump() }); }

      if (a === 'next' || a === 'prev') {
        const t = ctlMove(a === 'next' ? 1 : -1);
        if (!t) return json(res, 404, { code: -1, msg: '曲库是空的' });
        const keepPlaying = !ctl.paused;
        ctl.guid = t.guid; ctl.positionMs = 0; ctl.paused = !keepPlaying;
        return json(res, 200, { code: 0, data: ctlBump() });
      }

      if (a === 'volume') {
        let v = Number(b.volume);
        if (!isFinite(v)) v = Number(b.value);
        if (v > 1) v = v / 100;                      // 允许传 0-100
        ctl.volume = Math.max(0, Math.min(1, v));
        return json(res, 200, { code: 0, data: ctlBump() });
      }

      if (a === 'seek') {
        let ms = null;
        if (typeof b.positionMs === 'number') ms = b.positionMs;
        else if (typeof b.seconds === 'number') ms = b.seconds * 1000;
        else if (typeof b.percent === 'number') {
          const t = ctlTracks().find((x) => x.guid === ctl.guid);
          ms = t ? (t.duration || 0) * (b.percent / 100) : null;
        }
        if (ms == null || !isFinite(ms)) return json(res, 400, { code: -1, msg: '缺少 positionMs / seconds / percent' });
        ctl.positionMs = Math.max(0, ms);
        return json(res, 200, { code: 0, data: ctlBump() });
      }

      return json(res, 400, { code: -1, msg: '不认识的动作：' + a + '（可用：play/pause/resume/toggle/stop/next/prev/volume/seek）' });
    }

    return json(res, 404, { code: -1, msg: '未知接口：/api/ctl' + subPath });
  } catch (e) {
    return json(res, 500, { code: -1, msg: e.message });
  }
}

async function handleDownloadApi(req, res, subPath, params) {
  const get = (k) => (params && params.get ? (params.get(k) || '') : '');
  try {
    if (subPath === '/status') {
      const online = await dl.ping();
      return json(res, 200, {
        code: 0,
        data: {
          online,
          mode: MODE,
          libEnabled: !!(lib && lib.isEnabled()),
          libCount: lib ? lib.getLibraryCount() : 0,
          musicDir: musicRoots()[0] || '',
          musicDirs: musicRoots(),
          dlBase: await dl.base(),
        },
      });
    }

    if (subPath === '/search') {
      const q = get('q').trim();
      if (!q) return json(res, 200, { code: 0, data: { songs: [], total: 0 } });
      const sources = get('sources').split(',').map((s) => s.trim()).filter(Boolean);
      const r = await dl.searchSongs(q, { sources, pageSize: Number(get('size')) || 100 });
      return json(res, 200, { code: 0, data: r });
    }

    if (subPath === '/download' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const r = await dl.enqueue(body.songs || []);
      return json(res, 200, { code: 0, data: r });
    }

    if (subPath === '/queue') {
      const q = await dl.queueStatus();
      return json(res, 200, { code: 0, data: q });
    }

    if (subPath === '/records') {
      const r = await dl.records();
      return json(res, 200, { code: 0, data: r || {} });
    }

    // 取歌词（给音乐库管家用）：固定追加 format=line，把逐字卡拉OK压成逐行
    if (subPath === '/lyric') {
      const id = get('id');
      const source = get('source');
      if (!id || !source) return json(res, 400, { code: -1, msg: '缺少 id 或 source' });
      const b = await dl.base();
      if (!b) return json(res, 503, { code: -1, msg: '下载器不在线' });
      const r = await fetch(
        b + '/music/lyric?id=' + encodeURIComponent(id) + '&source=' + encodeURIComponent(source) + '&format=line',
        { headers: { 'Accept': 'text/plain' }, signal: AbortSignal.timeout(20000) }
      );
      const txt = await r.text();
      return json(res, 200, { code: 0, data: { lrc: txt, kind: r.headers.get('x-lyric-format') || '' } });
    }

    return json(res, 404, { code: -1, msg: '未知接口：/api/dl' + subPath });
  } catch (e) {
    return json(res, 502, { code: -1, msg: e.message || '下载服务异常' });
  }
}

// 构造上游请求头
function buildUpstreamHeaders(method, pathname, queryObj, bodyStr, reqHeaders) {
  const headers = {
    'Accept': 'application/json, */*',
    'Accept-Language': 'zh-CN',
    'User-Agent': reqHeaders['user-agent'] || 'fnmusic-desktop-player/1.0',
    'authx': makeAuthx(method, pathname, queryObj, bodyStr),
  };
  if (session.token) headers['Cookie'] = 'music-token=' + encodeURIComponent(session.token);
  if (bodyStr) headers['Content-Type'] = reqHeaders['content-type'] || 'application/json';
  if (reqHeaders['range']) headers['Range'] = reqHeaders['range'];
  return headers;
}

function collectRespHeaders(h) {
  const o = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges',
                   'content-disposition', 'cache-control', 'etag', 'last-modified']) {
    const v = h.get(k);
    if (v) o[k] = v;
  }
  return o;
}

// 代理任意上游请求（list / stream / cover / lyric / search ... 通吃），token 过期自动重登重试
async function proxyUpstream(req, res, upstreamPath) {
  const u = new URL(req.url, 'http://local');
  const queryObj = {};
  u.searchParams.forEach((v, k) => { queryObj[k] = v; });

  const pathname = API_BASE + upstreamPath;
  if (!session.base) return json(res, 401, { code: -1, msg: '尚未连接服务器' });

  const target = session.base + pathname + (u.search || '');
  const bodyBuf = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : null;
  const bodyStr = bodyBuf && bodyBuf.length ? bodyBuf.toString('utf8') : null;
  const isStream = /(?:track\/stream|static\/cover)/.test(upstreamPath);

  const doFetch = () => fetch(target, {
    method: req.method,
    headers: buildUpstreamHeaders(req.method, pathname, queryObj, bodyStr, req.headers),
    body: bodyStr || undefined,
    redirect: 'follow',
    signal: isStream ? undefined : AbortSignal.timeout(20000), // 列表/搜索/歌词加 20s 超时，避免慢接口挂死
  });

  let upstream;
  try { upstream = await doFetch(); }
  catch (e) { return json(res, 502, { code: -1, msg: '无法连接 NAS：' + (e.cause?.message || e.message) }); }

  // —— 非流式：读 body 判断 token 是否过期（120001/99999），过期则重登重试 ——
  if (!isStream) {
    let buf = Buffer.from(await upstream.arrayBuffer());
    let expired = upstream.status === 401;
    if (!expired && buf.length) {
      try { const j = JSON.parse(buf.toString('utf8')); if (j && (j.code === 120001 || j.code === 99999)) expired = true; } catch (e) {}
    }
    if (expired && session.password) {
      const r = await doLogin(session.base, session.username, session.password, '');
      if (r.ok) {
        try {
          const r2 = await doFetch();
          buf = Buffer.from(await r2.arrayBuffer());
          upstream = r2;
        } catch (e) {}
      }
    }
    const respHeaders = collectRespHeaders(upstream.headers);
    if (!respHeaders['content-type']) respHeaders['content-type'] = 'application/json; charset=utf-8';
    res.writeHead(upstream.status, respHeaders);
    return res.end(buf);
  }

  // —— 流式（音频/封面）：401 则重登重试后 pipe ——
  if (upstream.status === 401 && session.password) {
    const r = await doLogin(session.base, session.username, session.password, '');
    if (r.ok) {
      try { upstream = await doFetch(); } catch (e) {}
    }
  }
  const respHeaders = collectRespHeaders(upstream.headers);
  if (!respHeaders['content-type']) respHeaders['content-type'] = 'application/octet-stream';
  res.writeHead(upstream.status, respHeaders);
  if (upstream.body) {
    const rs = Readable.fromWeb(upstream.body);
    rs.on('error', () => { try { res.destroy(); } catch (e) {} });
    res.on('error', () => { try { rs.destroy(); } catch (e) {} });
    rs.pipe(res);
  } else {
    res.end();
  }
}

// 自动静默登录：读 settings.json 里记住的凭据，尝试登录（已连接则跳过）。
// 供多处触发（listen 回调 + /api/session 轮询），保证 Electron 下数据目录就绪后也能补登。
let autoLoginStarted = false;
function tryAutoLogin() {
  if (session.token) return Promise.resolve();
  if (autoLoginStarted) return Promise.resolve();
  autoLoginStarted = true;
  const s = loadSettings();
  if (s.username && s.password && s.base) {
    return doLogin(s.base, s.username, b64dec(s.password), s.accessCode || '')
      .catch(() => {})
      .finally(() => { autoLoginStarted = false; });
  }
  autoLoginStarted = false;
  return Promise.resolve();
}

// 登录核心：POST /user/password-login，成功则写入 session。供首次登录与 token 过期自动重登共用。
async function doLogin(base, username, password, accessCode) {
  const pathname = API_BASE + '/user/password-login';
  const loginBody = JSON.stringify({
    username,
    password: sha256hex(password),
    deviceId: deviceId(),
  });
  const headers = {
    'Accept': 'application/json',
    'Accept-Language': 'zh-CN',
    'Content-Type': 'application/json',
    'User-Agent': 'fnmusic-desktop-player/1.0',
    'authx': makeAuthx('POST', pathname, null, loginBody),
  };
  if (accessCode) {
    headers['x-access-code'] = Buffer.from(accessCode, 'utf8').toString('base64');
    headers['x-access-source'] = 'app';
  }
  let resp;
  try {
    resp = await fetch(base + pathname, { method: 'POST', headers, body: loginBody });
  } catch (e) {
    return { ok: false, code: -1, msg: '无法连接 NAS：' + (e.cause?.message || e.message) };
  }
  let data;
  try { data = await resp.json(); } catch (e) { return { ok: false, code: -1, msg: '服务器响应异常（HTTP ' + resp.status + '）' }; }
  if (data && data.code === 0 && data.data && data.data.userToken) {
    session.base = base;
    session.token = data.data.userToken;
    session.username = username;
    session.password = password; // 仅存内存，用于 token 过期后自动重登
    return { ok: true, data };
  }
  return { ok: false, code: data?.code ?? -1, msg: data?.msg || '登录失败' };
}

// 登录：POST /api/connect  { base, username, password, accessCode?, remember? }
async function handleLogin(req, res) {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const base = normalizeBase(body.base);
  const username = (body.username || '').trim();
  const password = body.password || '';
  if (!base || !username || !password) {
    return json(res, 400, { code: -1, msg: '请填写服务器地址、账号、密码' });
  }

  const r = await doLogin(base, username, password, body.accessCode);
  if (r.ok) {
    // 记住密码：明文存 settings.json（本机本地文件，仅个人电脑使用）
    const patch = {};
    if (body.remember !== false) {
      Object.assign(patch, { base, username, password: b64enc(password), accessCode: body.accessCode || '' });
    } else {
      Object.assign(patch, { base, username, password: '', accessCode: '' });
    }
    if (typeof body.dockerBase === 'string') patch.dockerBase = normalizeBase(body.dockerBase);
    saveSettings(patch);
    const user = r.data.data.user || {};
    return json(res, 200, { code: 0, data: { username, name: user.name || user.username || username } });
  }
  // 120001 = 未授权/账号密码错；99999 = 无效 token 等
  return json(res, r.code === -1 ? 502 : 401, { code: r.code, msg: r.msg });
}

async function handleLogout(req, res) {
  if (session.base && session.token) {
    const pathname = API_BASE + '/user/logout';
    try {
      await fetch(session.base + pathname, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'authx': makeAuthx('POST', pathname, null, ''), 'Cookie': 'music-token=' + encodeURIComponent(session.token) },
      });
    } catch (e) {}
  }
  session.base = session.token = session.username = '';
  json(res, 200, { code: 0 });
}

const server = http.createServer(async (req, res) => {
  res.on('error', () => {});
  const u = new URL(req.url, 'http://local');
  const p = u.pathname;

  try {
    if (p === '/api/connect' && req.method === 'POST') return await handleLogin(req, res);
    if (p === '/api/logout' && req.method === 'POST') return await handleLogout(req, res);
    if (p === '/api/session') {
      tryAutoLogin(); // 未连接且存了密码则尝试静默登录（Electron 下数据目录此时已就绪）
      const s = loadSettings();
      return json(res, 200, {
        code: 0,
        data: {
          connected: !!session.token,
          username: session.username,
          hasSaved: !!(s.username && s.password),           // 是否有记住的密码
          savedUser: s.username || '',
          lastTrack: s.lastTrack || null,                     // 上次播放进度
          dockerBase: dockerBase(),                           // 桌面版填过的远程曲库地址
          version: VERSION,                                    // 页面显示用，一眼看出是不是旧页面
          libEnabled: !!(lib && lib.isEnabled()),             // 容器里自己带曲库
          libCount: lib ? lib.getLibraryCount() : 0,
          // 默认源：容器里默认 docker，桌面版默认 fnos。前端只在用户没手动选过时采用。
          defaultSrc: process.env.FN_DEFAULT_SRC || ((lib && lib.isEnabled()) ? 'docker' : 'fnos'),
        },
      });
    }
    if (p === '/api/progress' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (body && body.guid) {
        saveSettings({ lastTrack: {
          guid: body.guid,
          title: body.title || '',
          artist: body.artist || '',
          album: body.album || '',
          coverId: body.coverId || '',
          time: Math.max(0, Number(body.time) || 0),          // 秒
        }});
      }
      return json(res, 200, { code: 0 });
    }
    if (p === '/api/clear-progress' && req.method === 'POST') {
      saveSettings({ lastTrack: null });
      return json(res, 200, { code: 0 });
    }

    if (p === '/api/health') {
      return json(res, 200, {
        code: 0, ok: true,
        app: 'fnmusic',                       // ★ 发现协议标识，别改
        // 桌面版和容器必须能被区分开：桌面版只是客户端，
        // 以前它本地有曲库时自称「Docker」，导致电视上会搜到两台并连错。
        role: IS_DESKTOP ? 'desktop' : 'server',   // ★ 自动发现只认 server
        name: IS_DESKTOP ? '咔一下子音乐 · 桌面版'
              : ('咔一下子音乐' + (MODE === 'dl' ? ' · 下载版' : ' Docker')),
        mode: MODE,
        version: VERSION,
        hasSignKey: HAS_SIGN_KEY,
        musicDir: musicRoots()[0] || '',
        musicDirs: musicRoots(),
        libEnabled: !!(lib && lib.isEnabled()),
        libReady: !!(lib && lib.isReady()),
        libCount: lib ? lib.getLibraryCount() : 0,
        dockerBase: dockerBase(),          // 桌面版配了远程曲库才有值
        uptime: Math.round(process.uptime()),
      });
    }

    // —— 局域网自动发现：扫本网段的 8530/8580，返回可连的 Docker 曲库 ——
    if (p === '/api/discover') {
      try {
        const r = await discoverServers();
        return json(res, 200, { code: 0, data: r });
      } catch (e) {
        return json(res, 200, { code: -1, msg: '搜索失败：' + e.message, data: { servers: [] } });
      }
    }

    if (p === '/api/docker-base' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const base = normalizeBase(body.dockerBase || '');
      /* 填了地址就先体检；不合格当场拒绝并说清理由，不写进设置。
         传空是允许的（容器自带曲库时不需要外部地址）。 */
      if (base) {
        const chk = await checkDockerBase(base);
        if (!chk.ok) {
          console.log('[docker-base] 拒绝 ' + base + '：' + chk.msg);
          return json(res, 200, { code: -1, msg: chk.msg, data: { dockerBase: dockerBase() } });
        }
        saveSettings({ dockerBase: base });
        return json(res, 200, { code: 0, data: { dockerBase: base, libCount: chk.libCount, name: chk.name } });
      }
      saveSettings({ dockerBase: base });
      return json(res, 200, { code: 0, data: { dockerBase: base } });
    }

    // —— 音乐库管家（CLI）用的数据接口 ——
    // 只给工具用，返回真实绝对路径；不做任何写操作
    if (p === '/api/lib/files') {
      if (!isFull || !lib || !lib.isEnabled()) {
        return json(res, 503, { code: -1, msg: '本地曲库未启用' });
      }
      return json(res, 200, { code: 0, data: { files: lib.exportFiles() } });
    }

    // —— AI / 遥控控制接口 ——
    // 播放状态放在服务端，网页只是「播放终端」。这样 CLI、AI、手机都能改，
    // 所有打开的页面会跟着走。
    if (p.startsWith('/api/ctl/')) {
      if (!isFull) return json(res, 404, { code: -1, msg: '当前模式不提供播放控制' });
      return await handleCtlApi(req, res, p.slice('/api/ctl'.length));
    }

    // —— 在线搜歌 / 下载（两个版本共用）——
    // go-music-dl 的搜索只吐 HTML，downloader.cjs 负责抽成 JSON
    if (p.startsWith('/api/dl/')) {
      if (!dl) return json(res, 503, { code: -1, msg: '下载模块未加载' });
      return await handleDownloadApi(req, res, p.slice('/api/dl'.length), u.searchParams);
    }

    if (p === '/api/d/' || p === '/api/d') {
      if (!isFull) return json(res, 404, { code: -1, msg: '当前是纯下载版，不提供播放接口' });
      return json(res, 200, { code: 0, msg: '本地曲库接口，请调用 /api/d/xxx' });
    }

    if (p.startsWith('/api/d/')) {
      // 纯下载版：客户端靠 libEnabled=false 就不会连上来；
      // 万一有人手动填地址，这里也明确告诉他为什么不给播放
      if (!isFull) return json(res, 404, { code: -1, msg: '当前是纯下载版，不提供播放接口' });
      const sub = p.slice('/api/d'.length);         // e.g. '/track/list'
      // 容器里跑：自己扫目录；桌面版：反代到填的 Docker 曲库地址
      if (lib && lib.isEnabled()) return await lib.handleLocalApi(req, res, sub, u.searchParams);
      return await proxyLocalApi(req, res, sub);
    }

    if (p.startsWith('/api/p/')) {
      const upstreamPath = p.slice('/api/p'.length); // e.g. '/track/list'
      if (!session.token) return json(res, 401, { code: 120001, msg: '未登录或登录已过期' });
      return await proxyUpstream(req, res, upstreamPath);
    }

    // —— 静态文件 ——
    // 纯下载版没有播放器，根路径直接给下载页面
    // 页面一律不缓存：升级后只要刷新就是新的，不会出现「界面还是旧版」的怪事
    const sendHtml = (file) => {
      const fp = path.join(ROOT, file);
      if (!fs.existsSync(fp)) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('缺少页面文件：' + file);
      }
      const buf = fs.readFileSync(fp);
      const etag = '"' + require('crypto').createHash('md5').update(buf).digest('hex') + '"';
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'ETag': etag,
      });
      return res.end(buf);
    };
    if (p === '/' || p === '/index.html') return sendHtml(isFull ? 'index.html' : 'download.html');
    if (p === '/download.html') return sendHtml('download.html');
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    json(res, 500, { code: -1, msg: '服务器内部错误：' + e.message });
  }
});

// —— 打开独立应用窗口（优先 Edge --app 独立窗口，退回默认浏览器）——
function openAppWindow(url) {
  if (NO_AUTOSTART) return;
  if (process.platform !== 'win32') { try { exec('open "' + url + '"'); } catch (e) {} return; }
  const edgeCandidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  let edge = '';
  for (const p of edgeCandidates) { try { if (fs.existsSync(p)) { edge = p; break; } } catch (e) {} }
  try {
    if (edge) exec('"' + edge + '" --app="' + url + '" --no-first-run --no-default-browser-check');
    else exec('start "" "' + url + '"');
  } catch (e) {}
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // 服务已在跑：直接再开一个窗口，本进程退出
    openAppWindow('http://127.0.0.1:' + PORT);
    process.exit(0);
  }
  console.error('启动失败：' + (e.code || e.message));
  process.exit(1);
});

// —— 启动顺序：先把本地曲库准备好（有缓存秒回），再放行端口 ——
// 反过来的话，容器首次启动用户会打开一个空曲库
(async () => {
  if (lib && musicRoots().length) {
    try {
      const r = await lib.init({ musicDirs: musicRoots(), dataDir: getDataDir() });
      console.log('[曲库] 初始化：' + JSON.stringify(r));
    } catch (e) {
      console.error('[曲库] 初始化失败：' + e.message);
    }
  }

  server.listen(PORT, HOST, () => {
    const showHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
    const url = 'http://' + showHost + ':' + PORT;
    console.log('咔一下子音乐服务 v' + VERSION + ' 已启动：' + url);
    console.log('  模式      ：' + (MODE === 'dl' ? 'dl（纯下载版，不提供 /api/d 播放接口）' : 'full（完整版）'));
    console.log('  监听      ：' + HOST + ':' + PORT);
    console.log('  数据目录  ：' + getDataDir());
    console.log('  音乐目录  ：' + (musicRoots().join(' , ') || '(未设置，本地曲库关闭)'));
    console.log('  下载服务  ：' + (dl ? '自动发现（DL_BASE=' + (process.env.DL_BASE || '未指定，按端口探测') + '）' : '未加载'));
    console.log('  签名常量  ：' + (HAS_SIGN_KEY ? '已配置' : '未配置（只能连未开访问码的飞牛，或只用 Docker 源）'));
    if (dockerBase()) console.log('  远程曲库  ：' + dockerBase());

    openAppWindow(url);
    // 启动后：若本地存了记住的密码，自动静默登录（前端 /api/session 轮询会再兜底一次）
    tryAutoLogin();
  });
})();

// —— 保活：每 3 分钟探测一次 token，失效则自动重登（飞牛无 refresh 接口，只能重登）——
setInterval(async () => {
  if (!session.token || !session.password || !session.base) return;
  try {
    const pathname = API_BASE + '/user/me';
    const r = await fetch(session.base + pathname, {
      headers: {
        'Accept': 'application/json',
        'Cookie': 'music-token=' + encodeURIComponent(session.token),
        'authx': makeAuthx('GET', pathname, {}, null),
      },
    });
    const j = await r.json();
    if (j && j.code !== 0) await doLogin(session.base, session.username, session.password, '');
  } catch (e) {}
}, 3 * 60 * 1000);

// —— 全局兜底：避免单次异常把整个服务打崩 ——
process.on('uncaughtException', (e) => console.error('[uncaught]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message));
