/**
 * 飞牛音乐 · 桌面播放器（本地服务）
 * 零依赖，Node 18+ 直接跑。职责：
 *   1. 托管 index.html（同源，避免浏览器 CORS 拦截）
 *   2. 代理 /api/p/* 到飞牛 NAS 的 /music/api/v1/*，自动补 authx 签名 + music-token 会话
 *   3. 处理登录 / 登出
 * 飞牛音乐是逆向私有 API，接口签名以本机前端为准。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { exec } = require('child_process');

const PORT = process.env.PORT || 8530;
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
    if (body.remember !== false) {
      saveSettings({ base, username, password: b64enc(password), accessCode: body.accessCode || '' });
    } else {
      saveSettings({ base, username, password: '', accessCode: '' });
    }
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

    if (p.startsWith('/api/p/')) {
      const upstreamPath = p.slice('/api/p'.length); // e.g. '/track/list'
      if (!session.token) return json(res, 401, { code: 120001, msg: '未登录或登录已过期' });
      return await proxyUpstream(req, res, upstreamPath);
    }

    // —— 静态文件 ——
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
    }
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

server.listen(PORT, '127.0.0.1', () => {
  openAppWindow('http://127.0.0.1:' + PORT);
  // 启动后：若本地存了记住的密码，自动静默登录（前端 /api/session 轮询会再兜底一次）
  tryAutoLogin();
});

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
