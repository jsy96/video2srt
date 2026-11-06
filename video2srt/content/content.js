// video2srt 内容脚本（所有网页）
// 职责（无任何界面，控制入口统一在侧边栏面板与键盘快捷键）：
//   1. 报告当前视频信息（标题/播放进度，用于 SRT 时间轴平移与文件命名）
//   2. 按需把倍速强制回 1x、监听视频播放结束（可选自动停止录制）
//   3. 自动点击站点自带的「跳过广告」按钮（可在设置页关闭）
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

// 视频站常自动连播下一个视频，ended 只在单个视频播完时触发一次；
// 是否自动停止由后台按用户配置决定
document.addEventListener('ended', function () {
  if (!endedWatch) return;
  try {
    chrome.runtime.sendMessage({ target: 'background', type: 'video-ended' }, function () {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}, true);

// ============================================================================
// 自动点击「跳过广告」
// 边界：只对站点自己渲染了「跳过广告」按钮的贴片广告有效（点击站点提供的按钮，
// 属正常用户操作）；站点强制、无跳过按钮的广告无法跳过。
// ============================================================================

var skipAdOn = true;   // 默认开启，设置页可关
try {
  chrome.storage.local.get('v2s_cfg', function (o) {
    var c = o && o.v2s_cfg;
    if (c && c.autoSkipAd === false) skipAdOn = false;
  });
} catch (e) {}

// 精确匹配常见文案，避免误点正常功能的「跳过」类按钮（如引导页「跳过引导」）
var SKIP_WORDS = ['跳过广告', '跳过廣告', '跳过 ad', 'skip ad', 'skip ads'];

function clickSkipAd() {
  if (!skipAdOn) return;
  var els = document.querySelectorAll('button, a, div, span, i');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var t = (el.textContent || '').trim().toLowerCase();
    if (!t || t.length > 12 || SKIP_WORDS.indexOf(t) < 0) continue;
    if (!el.offsetWidth && !el.offsetHeight) continue;   // 不可见不点
    try { el.click(); } catch (e) {}
  }
}

// 广告按钮多在广告开始数秒后才出现，靠 MutationObserver 兜住任意时机；节流 300ms
var skipTimer = 0;
new MutationObserver(function () {
  if (skipTimer) return;
  skipTimer = setTimeout(function () { skipTimer = 0; clickSkipAd(); }, 300);
}).observe(document.documentElement, { childList: true, subtree: true });
clickSkipAd();
