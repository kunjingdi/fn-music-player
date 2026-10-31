/**
 * 蓝牙音箱"封面 / 歌词上屏"桥（Windows SMTC → AVRCP）
 * ==================================================================
 * 原理先说清楚，免得期待错位：
 *
 *   蓝牙音频走 A2DP，屏幕上的字和封面走 **AVRCP**。AVRCP 能带的东西是：
 *     v1.3 起：歌名、歌手、专辑、总时长、播放状态
 *     v1.6 起：**封面**（通过 BIP/OBEX 传一张小图）
 *   没有任何版本能带"歌词"。所以：
 *     · 歌名/歌手——只要链路通，几乎一定能显示
 *     · 封面——必须两端都支持 AVRCP 1.6；多数音箱只到 1.5，显示不出来是协议上限
 *     · 歌词——协议里没这个字段。业界土办法是"把当前这句歌词塞进歌名"，
 *             音箱屏就跟着一句一句滚。这个我们做成了开关（歌词上屏）。
 *
 * 数据从哪来：Windows 的 SMTC（系统媒体控制）。我们的播放器只要往 SMTC 里
 * 写好 metadata，Windows 就会把它转成 AVRCP 发出去。
 * Electron 自己带的 `navigator.mediaSession` 在部分版本上不会接 SMTC，
 * 所以这里再挂一个可选的原生桥：装了 electron-media-service 就用它。
 *
 * 没装也不影响其它功能——所有调用都会安全地降级成 no-op。
 */
'use strict';

let impl = null;
let initTried = false;
let lastErr = '';
let lastSong = null;

function init(appId) {
  if (initTried) return impl;
  initTried = true;
  try {
    const MediaService = require('electron-media-service');
    impl = new MediaService({ appId: appId || 'com.junze.fnmusic' });
    if (typeof impl.startService === 'function') impl.startService();
    console.log('[smtc] electron-media-service 已启用');
  } catch (e) {
    lastErr = (e && e.message) || String(e);
    impl = null;
  }
  return impl;
}

/** 把一首歌的元数据塞进系统媒体面板（Windows 再转给蓝牙） */
function update(song) {
  if (!song) return false;
  lastSong = song;
  const svc = impl;
  if (!svc) return false;
  const payload = {
    id: song.id || 'fn',
    title: song.title || '',
    artist: song.artist || '',
    album: song.album || '',
    albumArtURL: song.artwork || '',
    currentTimeInSeconds: Math.max(0, Math.round(song.position || 0)),
    durationInSeconds: Math.max(0, Math.round(song.duration || 0)),
    playing: !!song.playing,
  };
  try {
    if (typeof svc.setCurrentSong === 'function') svc.setCurrentSong(payload);
    else if (typeof svc.setMediaState === 'function') svc.setMediaState(payload);
    else return false;
    return true;
  } catch (e) {
    lastErr = (e && e.message) || String(e);
    return false;
  }
}

/** 暂停/继续、进度这类频繁变动的只更新状态位，不重传封面 */
function setPlaying(playing) {
  if (!impl || !lastSong) return false;
  return update(Object.assign({}, lastSong, { playing: !!playing }));
}

function probe() {
  return {
    available: !!impl,
    module: 'electron-media-service',
    error: impl ? '' : (lastErr || '未安装'),
    hint: impl ? '' : '蓝牙封面/歌名需要系统媒体控制：在播放器目录执行 npm i electron-media-service 后重启即可（可选，不装也能正常听歌）',
  };
}

function bindEvents(handlers) {
  if (!impl || !handlers) return;
  const map = {
    play: 'onPlay', pause: 'onPause', playpause: 'onPlayPause',
    next: 'onNext', previous: 'onPrevious', stop: 'onStop',
    seek: 'onSeek',
  };
  for (const key of Object.keys(map)) {
    const fn = handlers[key];
    if (typeof fn !== 'function') continue;
    try {
      if (typeof impl[map[key]] === 'function') impl[map[key]](fn);
      else if (typeof impl.on === 'function') impl.on(key, fn);
    } catch (e) {}
  }
}

module.exports = { init, update, setPlaying, probe, bindEvents };
