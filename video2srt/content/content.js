// video2srt 内容脚本（视频号网页）
// 职责：报告当前视频信息（标题/播放进度，用于 SRT 时间轴平移与文件命名）、
//       按需把倍速强制回 1x、监听视频播放结束（可选自动停止录制）
'use strict';

var endedWatch = false;

function findVideo() {
  var vs = Array.from(document.querySelectorAll('video'));
  return vs.find(function (v) { return !v.paused; }) || vs[0] || null;
}

function findTitle() {
  var sels = ['.video-title', '[class*="video-title"]', '[class*="title"]', 'h1', '[class*="desc"]'];
  for (var i = 0; i < sels.length; i++) {
    var el = document.querySelector(sels[i]);
    var t = (el && el.textContent || '').trim();
    if (t && t.length > 1 && t.length < 120) return t;
  }
  var m = document.querySelector('meta[property="og:title"]');
  if (m && m.content) return m.content;
  return (document.title || '').trim().slice(0, 80);
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.target !== 'content') return;
  if (msg.type === 'get-video-info') {
    var v = findVideo();
    sendResponse({
      found: !!v,
      title: findTitle(),
      currentTime: v ? v.currentTime : 0,
      duration: (v && isFinite(v.duration)) ? v.duration : 0
    });
  } else if (msg.type === 'force-1x') {
    document.querySelectorAll('video').forEach(function (v) {
      try { v.playbackRate = 1; } catch (e) {}
    });
    sendResponse({ ok: true });
  } else if (msg.type === 'enable-ended-watch') {
    endedWatch = true;
    sendResponse({ ok: true });
  } else {
    sendResponse({ ok: true });
  }
});

// 视频号会自动连播下一个视频，ended 只在单个视频播完时触发一次；
// 是否自动停止由后台按用户配置决定
document.addEventListener('ended', function () {
  if (!endedWatch) return;
  try {
    chrome.runtime.sendMessage({ target: 'background', type: 'video-ended' }, function () {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}, true);
