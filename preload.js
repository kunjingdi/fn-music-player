/**
 * preload：把两件事接到主进程
 *   1. 全屏开关（浏览器那套在 Windows 竖屏 + 多显示器上会把窗口算到隔壁屏去）
 *   2. 蓝牙音箱元数据（歌名/封面要写给 Windows 的系统媒体控制，渲染层碰不到）
 *
 * 1.5.0 起投屏（投屏窗 / 接收页 / DLNA）整块删掉了。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let fsOn = false;
const cbs = new Set();

ipcRenderer.on('fs:changed', (_e, on) => {
  fsOn = !!on;
  cbs.forEach(fn => { try { fn(fsOn); } catch (e) { /* 页面还没准备好，忽略 */ } });
});

contextBridge.exposeInMainWorld('fnNative', {
  isElectron: true,

  toggleFullscreen() { ipcRenderer.send('fs:toggle'); },
  setFullscreen(on) { ipcRenderer.send('fs:set', !!on); },
  getFullscreen() { return fsOn; },

  /** 订阅全屏状态变化，返回退订函数 */
  onFullscreen(cb) {
    if (typeof cb !== 'function') return () => {};
    cbs.add(cb);
    try { cb(fsOn); } catch (e) {}
    ipcRenderer.send('fs:query');           // 让主进程报一次当前状态
    return () => cbs.delete(cb);
  },

  /** 当前窗口所在显示器的信息，页面可以用来判断"窗口是不是跑偏了" */
  displayInfo() { return ipcRenderer.invoke('fs:display'); },

  /** 手动纠偏：窗口被挤到别的屏上时调一下 */
  fixGeometry() { ipcRenderer.send('fs:fix'); },
});

contextBridge.exposeInMainWorld('fnBt', {
  isElectron: true,
  /* —— 蓝牙（Windows SMTC → AVRCP） —— */
  btProbe() { return ipcRenderer.invoke('bt:probe'); },
  btUpdate(song) { ipcRenderer.send('bt:update', song); },
  btPlaying(on) { ipcRenderer.send('bt:playing', !!on); },
});
