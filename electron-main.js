/**
 * Electron 主进程：内嵌 server.cjs（本地服务 + 代理到 NAS），
 * 用一个原生的 BrowserWindow 承载界面，打包后是真正的独立 exe，不依赖 Edge/浏览器。
 */
'use strict';

const { app, BrowserWindow, shell, Menu } = require('electron');

/* screen 模块必须等 app ready 之后才能用：在顶层直接解构只会拿到 undefined，
   一调 screen.on 就是「Cannot read properties of undefined」。所以走 getter。 */
function S() { return require('electron').screen; }
const path = require('path');
const fs = require('fs');

/* 蓝牙：Windows 系统媒体控制 → AVRCP（歌名/封面，可选原生桥）
   1.5.0 起投屏（投屏窗 / 接收页 / DLNA）整块删掉了 */
const bt = require('./bt-smtc.cjs');

// 数据目录指向用户数据目录（asar 只读，settings.json/device_id 要写到这）
// 注意：app.getPath 必须在 app ready 之后调用，这里先延迟到 ready 再设置
process.env.FN_MUSIC_NO_AUTOSTART = '1'; // 服务只跑，不自己开窗口

// 加载本地服务（同一进程内监听 127.0.0.1:8530）
let serverPath = path.join(__dirname, 'server.cjs');
require(serverPath);

const URL_MAIN = 'http://127.0.0.1:' + (process.env.PORT || 8530);
process.on('uncaughtException', e => { console.error('[UNCAUGHT]', (e && e.stack) || e); });
process.on('unhandledRejection', e => { console.error('[REJECT]', (e && e.stack) || e); });

let win = null;

/* ==================================================================
   全屏：把窗口死死钉在"它本来那块屏幕"上
   ------------------------------------------------------------------
   背景（Windows 上很容易踩）：
   显示器竖起来用（1080×1920）时，窗口进全屏会按显示器**未旋转**的
   1920×1080 来算，于是窗口右边多出 840px，直接压到右边那块副屏上。
   页面拿到的宽高比是 1920:1080 → 判成横屏，A± 这些右侧控件就"跑到
   第二块屏幕"了。F11、系统全屏、页面里的全屏按钮，三条路都一样。

   做法：进全屏前先记住这块窗口属于哪块显示器；进全屏后反复核对窗口
   矩形是否等于那块屏的 bounds，不等就掰回来；掰不动（有些 Windows
   版本全屏时忽略 setBounds）就退出来、摆正、再进一次。
   ================================================================== */

let anchorDisplayId = null;   // 进全屏前认定的显示器 id
let hardBusy = false;         // 正在走"退出-摆正-重进"的硬纠正

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fsLog(tag, extra) {
  try {
    const p = path.join(app.getPath('userData'), 'fullscreen.log');
    if (fs.existsSync(p) && fs.statSync(p).size > 512 * 1024) fs.unlinkSync(p);
    const d = win && !win.isDestroyed() ? S().getDisplayMatching(win.getBounds()) : null;
    const line = [
      new Date().toISOString(), tag,
      'win=' + (win && !win.isDestroyed() ? JSON.stringify(win.getBounds()) : '-'),
      'fs=' + (win && !win.isDestroyed() ? win.isFullScreen() : '-'),
      d ? ('display=' + JSON.stringify({ id: d.id, b: d.bounds, wa: d.workArea, rot: d.rotation, scale: d.scaleFactor })) : 'display=-',
      extra ? ('note=' + extra) : '',
    ].join(' ');
    fs.appendFileSync(p, line + '\n');
  } catch (e) { /* 日志失败绝不影响播放 */ }
}

/** 少数驱动会把矩形给成面板原始朝向，rotation 90/270 时宽高要交换 */
function displayRect(d) {
  const b = d.bounds;
  const rot = d.rotation || 0;
  if ((rot === 90 || rot === 270) && b.width > b.height) {
    return { x: b.x, y: b.y, width: b.height, height: b.width };
  }
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function rectsEqual(a, b) {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 &&
         Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
}

function rectInside(r, b) {
  return r.x >= b.x - 1 && r.y >= b.y - 1 &&
         r.x + r.width <= b.x + b.width + 1 && r.y + r.height <= b.y + b.height + 1;
}

/** 把矩形挪进目标屏，并缩到不超出 */
function clampInto(r, b) {
  const w = Math.min(r.width, b.width);
  const h = Math.min(r.height, b.height);
  return {
    x: Math.min(Math.max(r.x, b.x), b.x + b.width - w),
    y: Math.min(Math.max(r.y, b.y), b.y + b.height - h),
    width: w,
    height: h,
  };
}

/** 全屏时该贴合哪块屏：优先进全屏前记下的那块 */
function fsTarget() {
  if (anchorDisplayId != null) {
    const d = S().getAllDisplays().find(x => x.id === anchorDisplayId);
    if (d) return displayRect(d);
  }
  let ref = null;
  try { ref = win.getNormalBounds(); } catch (e) { /* 老版本没有 */ }
  if (!ref || ref.width < 80 || ref.height < 80) ref = win.getBounds();
  return displayRect(S().getDisplayMatching(ref));
}

/** 软纠正：直接改 bounds。全屏状态下有些 Windows 版本是生效的 */
function correctOnce(tag) {
  if (!win || win.isDestroyed() || !win.isFullScreen()) return true;
  const target = fsTarget();
  if (rectsEqual(win.getBounds(), target)) return true;
  try { win.setBounds(target); } catch (e) {}
  const ok = rectsEqual(win.getBounds(), target);
  fsLog('correct:' + tag + (ok ? ':ok' : ':fail'), 'target=' + JSON.stringify(target));
  return ok;
}

/** 硬纠正：全屏里改不动 → 退出来、摆到这块屏上、再进 */
function hardCorrect() {
  if (hardBusy || !win || win.isDestroyed() || !win.isFullScreen()) return;
  hardBusy = true;
  const target = fsTarget();
  fsLog('hard:start', 'target=' + JSON.stringify(target));

  const bail = setTimeout(() => { hardBusy = false; fsLog('hard:timeout'); }, 4000);

  win.once('leave-full-screen', async () => {
    try {
      await sleep(60);
      if (!win || win.isDestroyed()) { hardBusy = false; clearTimeout(bail); return; }
      try { win.setBounds(target); } catch (e) {}
      await sleep(220);
      if (!win || win.isDestroyed()) { hardBusy = false; clearTimeout(bail); return; }
      correctOnce('pre-enter');
      win.setFullScreen(true);
      clearTimeout(bail);
      await sleep(420);
      if (win && !win.isDestroyed() && win.isFullScreen()) correctOnce('re-enter');
      hardBusy = false;
    } catch (e) {
      hardBusy = false;
      clearTimeout(bail);
      fsLog('hard:error', String(e && e.message));
    }
  });

  try { win.setFullScreen(false); } catch (e) { hardBusy = false; clearTimeout(bail); }
}

/** 进全屏后盯一段时间：窗口尺寸是动画追上来的，早测一次不够 */
function watchFullscreen() {
  const beats = [60, 160, 320, 560, 900, 1400];
  beats.forEach((ms, i) => {
    setTimeout(() => {
      if (!win || win.isDestroyed() || !win.isFullScreen()) return;
      const ok = correctOnce('t' + ms);
      if (!ok && i === beats.length - 1) hardCorrect();
    }, ms);
  });
}

function applyFullscreen(on) {
  if (!win || win.isDestroyed()) return;
  if (on) {
    if (win.isFullScreen()) { watchFullscreen(); return; }
    // 进全屏前先认定显示器，并把窗口收进它里面（非全屏时 setBounds 一定有效）
    const d = S().getDisplayMatching(win.getBounds());
    anchorDisplayId = d.id;
    const b = displayRect(d);
    const cur = win.getBounds();
    if (!rectInside(cur, b)) {
      try { win.setBounds(clampInto(cur, b)); } catch (e) {}
    }
    fsLog('enter:request', 'anchor=' + d.id + ' rotation=' + (d.rotation || 0));
    win.setFullScreen(true);
    watchFullscreen();
  } else {
    anchorDisplayId = null;
    win.setFullScreen(false);
  }
}

function createWindow() {
  // 初始窗口不许超出屏幕：竖屏 1080 宽的主屏上开一个 1280 宽的窗口，
  // 一开机就有 200px 压在右边那块屏上，看着就像"UI 出去了"。
  const wa = S().getPrimaryDisplay().workAreaSize;
  const maxW = Math.max(480, wa.width - 60);
  const maxH = Math.max(360, wa.height - 80);
  const width = Math.min(1280, maxW);
  const height = Math.min(720, maxH);

  win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(960, maxW),
    minHeight: Math.min(600, maxH),
    backgroundColor: '#081120',
    autoHideMenuBar: true,
    title: '咔一下子音乐',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 1,
    },
  });

  win.loadURL(URL_MAIN);

  fsLog('window:created', 'workArea=' + JSON.stringify(wa) + ' size=' + width + 'x' + height);

  /* 触屏设备上双指捏合 / 双击会把整页放大（Chromium 的 visual zoom 默认是 1~3 倍），
     一放大，固定定位的 UI 就只剩中间一块，看着就是"界面跑出屏幕外"。
     桌面播放器不需要缩放，直接锁死在 1:1。 */
  const lockZoom = () => {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.setVisualZoomLevelLimits(1, 1);
      if (win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1);
    } catch (e) { /* 老版本没有这个接口，忽略 */ }
  };
  win.webContents.on('did-finish-load', lockZoom);
  win.webContents.on('zoom-changed', lockZoom);
  lockZoom();

  /* 全屏 / 最大化后，窗口尺寸是"动画追上来的"，页面那边只收到一两次 resize 容易算早；
     这里在切换完多拍几下，让页面重排歌词与画布。 */
  const kickRelayout = () => {
    [0, 120, 320, 640].forEach(ms => setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.webContents.executeJavaScript(
        'window.dispatchEvent(new Event("resize")); if(window.fnRelayout) window.fnRelayout();'
      ).catch(() => {});
    }, ms));
  };
  ['maximize', 'unmaximize'].forEach(ev => win.on(ev, kickRelayout));

  win.on('enter-full-screen', () => {
    if (anchorDisplayId == null) {
      // F11 / 系统那条路没有走 applyFullscreen，用窗口"正常状态"的位置补一个
      let ref = null;
      try { ref = win.getNormalBounds(); } catch (e) {}
      if (!ref || ref.width < 80 || ref.height < 80) ref = win.getBounds();
      try { anchorDisplayId = S().getDisplayMatching(ref).id; } catch (e) {}
    }
    fsLog('enter-full-screen', 'anchor=' + anchorDisplayId);
    kickRelayout();
    watchFullscreen();
    if (win && !win.isDestroyed()) win.webContents.send('fs:changed', true);
  });

  win.on('leave-full-screen', () => {
    fsLog('leave-full-screen');
    anchorDisplayId = null;
    kickRelayout();
    if (win && !win.isDestroyed()) win.webContents.send('fs:changed', false);
  });

  // 拔插显示器 / 改分辨率 / 转屏幕：全屏中重新贴合一次
  S().on('display-metrics-changed', () => {
    if (win && !win.isDestroyed() && win.isFullScreen()) {
      fsLog('display-metrics-changed');
      watchFullscreen();
    }
  });
  S().on('display-removed', () => {
    anchorDisplayId = null;
    if (win && !win.isDestroyed() && win.isFullScreen()) watchFullscreen();
  });

  /* 触屏没有 F11，键盘党想要：F11 切全屏，Esc 退回 */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { e.preventDefault(); applyFullscreen(!win.isFullScreen()); }
    else if (input.key === 'Escape' && win.isFullScreen()) { e.preventDefault(); applyFullscreen(false); }
  });

  // 外链用系统浏览器打开（本项目没有外链，保险起见）
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  /* 调试用：FN_FS_PROBE=1 启动时，自动进一次全屏、量一遍窗口与显示器、截张图就退出。
     正常运行时这个变量不存在，这段不执行。 */
  if (process.env.FN_FS_PROBE) {
    win.webContents.once('did-finish-load', async () => {
      await sleep(1600);
      fsLog('PROBE:before', 'target=' + JSON.stringify(fsTarget()));
      applyFullscreen(true);
      await sleep(2600);
      const d = S().getDisplayMatching(win.getBounds());
      fsLog('PROBE:after',
        'win=' + JSON.stringify(win.getBounds()) +
        ' display=' + JSON.stringify(d.bounds) +
        ' target=' + JSON.stringify(fsTarget()) +
        ' match=' + rectsEqual(win.getBounds(), displayRect(d)) +
        ' inner=' + await win.webContents.executeJavaScript('innerWidth+"x"+innerHeight') +
        ' native=' + await win.webContents.executeJavaScript('!!(window.fnNative&&window.fnNative.isElectron)'));
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'shots', 'v17', 'fs-probe.png'), img.toPNG());
      } catch (e) {}
      app.quit();
    });
  }

  win.on('closed', () => { win = null; });
}

/* ---------------- 渲染层 → 主进程：全屏开关 ----------------
   ipcMain 和 screen 一样，模块顶层拿到的是 undefined，必须等 app ready 之后再挂。 */
/* ==================================================================
   macOS 应用菜单
   ------------------------------------------------------------------
   Windows 上菜单栏默认隐藏，没有菜单照样能用。Mac 上不一样：
   没有 app 菜单，⌘Q 退出、⌘W 关窗、⌘C/⌘V 复制粘贴全都失灵，
   连"关于"和"退出"都没有入口。这里补一份标准菜单。
   ================================================================== */
function setupMacMenu() {
  if (process.platform !== 'darwin') return;
  const name = app.name || '咔一下子音乐';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: name,
      submenu: [
        { role: 'about', label: '关于 ' + name },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 ' + name },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 ' + name },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
  ]));
}

function registerIpc() {
  const { ipcMain } = require('electron');
  ipcMain.on('fs:toggle', () => applyFullscreen(!(win && win.isFullScreen())));
  ipcMain.on('fs:set', (_e, on) => applyFullscreen(!!on));
  ipcMain.on('fs:query', () => {
    if (win && !win.isDestroyed()) win.webContents.send('fs:changed', win.isFullScreen());
  });
  ipcMain.on('fs:fix', () => {
    if (win && !win.isDestroyed() && win.isFullScreen()) watchFullscreen();
  });
  ipcMain.handle('fs:display', () => {
    if (!win || win.isDestroyed()) return null;
    const d = S().getDisplayMatching(win.getBounds());
    return {
      id: d.id, bounds: d.bounds, workArea: d.workArea,
      rotation: d.rotation || 0, scaleFactor: d.scaleFactor,
      window: win.getBounds(), fullscreen: win.isFullScreen(),
      target: fsTarget(),
    };
  });

  /* ================= 蓝牙（Windows SMTC → AVRCP） ================= */
  ipcMain.handle('bt:probe', () => bt.probe());
  ipcMain.on('bt:update', (_e, song) => { bt.update(song || null); });
  ipcMain.on('bt:playing', (_e, on) => { bt.setPlaying(!!on); });
}

app.whenReady().then(() => {
  // app ready 后才能取 userData 路径；设置数据目录（此时 server.cjs 已加载，但 DATA_DIR 在 server 里是延迟读取的——见下方补丁）
  process.env.FN_MUSIC_DATA_DIR = path.join(app.getPath('userData'));
  registerIpc();

  // macOS 必须自己准备菜单栏，否则 ⌘Q / ⌘C 这些全都没有
  setupMacMenu();

  // 蓝牙封面/歌名：装了 electron-media-service 才生效，没装就是个空壳，不影响别的
  try { bt.init('com.junze.fnmusic'); } catch (e) {}

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
