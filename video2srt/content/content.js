// video2srt 内容脚本（所有网页）
// 职责：
//   1. 悬浮控制面板：开始/结束按钮 + 实时状态，随时可见、可拖动、可折叠（Shadow DOM 隔离样式）
//   2. 报告当前视频信息（标题/播放进度，用于 SRT 时间轴平移与文件命名）
//   3. 按需把倍速强制回 1x、监听视频播放结束（可选自动停止录制）
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
  } else if (msg.type === 'panel-state') {
    panel.render(msg.st, msg.recordingHere !== false);
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
// 悬浮控制面板
// ============================================================================

var panel = (function () {
  var host = null, root = null, els = {};
  var cur = { state: 'idle' };       // 最近一次收到的状态
  var lastHere = true;               // 该状态是否属于本标签页
  var collapsed = false;
  var timerId = 0;
  var POS_KEY = 'v2s_panel_pos';
  var COLLAPSE_KEY = 'v2s_panel_collapsed';

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}',
    '.panel{position:fixed;z-index:2147483646;width:230px;background:#fff;border:1px solid #e5e7eb;',
    ' border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.18);color:#1f2430;font-size:13px;user-select:none}',
    '.panel.collapsed{width:auto;border-radius:999px;padding:0}',
    '.head{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:move;border-bottom:1px solid #f0f1f4}',
    '.head .logo{font-size:15px;line-height:1}',
    '.head .name{flex:1;font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.head .fold{border:0;background:none;cursor:pointer;color:#6b7280;font-size:14px;line-height:1;padding:2px 4px;border-radius:6px}',
    '.head .fold:hover{background:#f3f4f6}',
    '.body{padding:10px 12px}',
    '.st{font-size:12.5px;font-weight:600;margin-bottom:8px;min-height:17px}',
    '.st.rec{color:#d0455b}.st.done{color:#1f9d61}.st.err{color:#d0455b}.st.prog{color:#5b4ee0}',
    '.btns{display:flex;gap:8px}',
    'button.act{flex:1;border:0;border-radius:8px;padding:8px 0;font-size:13px;font-weight:600;cursor:pointer}',
    'button.start{background:#5b4ee0;color:#fff}button.start:hover:not(:disabled){background:#4a3fc4}',
    'button.stop{background:#d0455b;color:#fff}button.stop:hover:not(:disabled){background:#b23649}',
    'button.act:disabled{opacity:.45;cursor:not-allowed}',
    '.foot{display:flex;justify-content:space-between;padding:6px 12px 8px;font-size:11px;color:#9ca3af}',
    '.foot a{color:#5b4ee0;text-decoration:none;cursor:pointer}',
    '.bubble{position:fixed;z-index:2147483646;width:38px;height:38px;border-radius:999px;background:#5b4ee0;',
    ' color:#fff;display:flex;align-items:center;justify-content:center;font-size:17px;cursor:pointer;',
    ' box-shadow:0 4px 14px rgba(0,0,0,.25);user-select:none}',
    '.bubble.rec{background:#d0455b;box-shadow:0 0 0 4px rgba(208,69,91,.25)}',
    '.dot{position:absolute;top:3px;right:3px;width:8px;height:8px;border-radius:999px;background:#fff;display:none}',
    '.bubble.rec .dot{display:block;animation:v2sblink 1s infinite}',
    '@keyframes v2sblink{50%{opacity:.2}}'
  ].join('');

  function clampXY(x, y, w, h) {
    var vw = window.innerWidth, vh = window.innerHeight;
    return [Math.min(Math.max(4, x), Math.max(4, vw - w - 4)), Math.min(Math.max(4, y), Math.max(4, vh - h - 4))];
  }

  function applyPos(x, y) {
    var el = visibleEl();
    if (!el) return;
    var w = el.offsetWidth || 230, h = el.offsetHeight || 120;
    var p = clampXY(x, y, w, h);
    el.style.left = p[0] + 'px';
    el.style.top = p[1] + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  function visibleEl() { return host ? (collapsed ? els.bubble : els.panel) : null; }

  function savePos() {
    var el = visibleEl();
    if (!el) return;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ x: parseInt(el.style.left, 10) || 0, y: parseInt(el.style.top, 10) || 0 }));
    } catch (e) {}
  }

  function loadPos() {
    try { var s = localStorage.getItem(POS_KEY); if (s) return JSON.parse(s); } catch (e) {}
    return null;
  }

  function makeDraggable(handle, what) {
    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var el = what();
      var sx = e.clientX, sy = e.clientY;
      var ox = el.offsetLeft, oy = el.offsetTop;
      var moved = false;
      function onMove(ev) {
        moved = true;
        applyPos(ox + ev.clientX - sx, oy + ev.clientY - sy);
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (moved) savePos();
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault();
    });
  }

  function build() {
    host = document.createElement('div');
    host.id = 'v2s-panel-host';
    root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    var panelEl = document.createElement('div');
    panelEl.className = 'panel';
    panelEl.innerHTML =
      '<div class="head"><span class="logo">🎙</span><span class="name">视频录音转文字</span>' +
      '<button class="fold" title="折叠">–</button></div>' +
      '<div class="body"><div class="st">○ 就绪</div>' +
      '<div class="btns"><button class="act start">开始</button><button class="act stop">结束</button></div></div>' +
      '<div class="foot"><span class="ver"></span><a class="keys">快捷键</a></div>';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.title = '视频录音转文字';
    bubble.innerHTML = '🎙<span class="dot"></span>';
    root.appendChild(panelEl);
    root.appendChild(bubble);

    els = {
      panel: panelEl, bubble: bubble,
      head: panelEl.querySelector('.head'),
      name: panelEl.querySelector('.name'),
      fold: panelEl.querySelector('.fold'),
      st: panelEl.querySelector('.st'),
      start: panelEl.querySelector('.start'),
      stop: panelEl.querySelector('.stop'),
      ver: panelEl.querySelector('.ver'),
      keys: panelEl.querySelector('.keys')
    };
    els.ver.textContent = 'v' + (chrome.runtime.getManifest().version.split('.').slice(0, 3).join('.') +
      '-' + (chrome.runtime.getManifest().version.split('.')[3] || '1'));

    els.start.addEventListener('click', function () { sendBg('start-capture'); });
    els.stop.addEventListener('click', function () { sendBg('stop-capture'); });
    els.fold.addEventListener('click', function (e) { e.stopPropagation(); setCollapsed(true); });
    bubble.addEventListener('click', function () { setCollapsed(false); });
    els.keys.addEventListener('click', function () {
      try { chrome.runtime.sendMessage({ target: 'background', type: 'open-shortcuts' }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    });

    makeDraggable(els.head, function () { return els.panel; });
    makeDraggable(bubble, function () { return els.bubble; });

    document.documentElement.appendChild(host);

    var pos = loadPos();
    applyPos(pos ? pos.x : window.innerWidth - 244, pos ? pos.y : 16);
    try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) {}
    setCollapsed(collapsed, true);

    // 全屏时把面板挂进全屏元素，保证「随时可见」
    document.addEventListener('fullscreenchange', function () {
      var fs = document.fullscreenElement;
      var target = fs || document.documentElement;
      if (host.parentNode !== target) target.appendChild(host);
    });
  }

  function setCollapsed(c, skipSave) {
    collapsed = c;
    if (!host) return;
    els.panel.style.display = c ? 'none' : 'block';
    els.bubble.style.display = c ? 'flex' : 'none';
    if (c) {
      var pos = loadPos();
      var bx = pos ? pos.x : window.innerWidth - 50;
      var by = pos ? pos.y : 16;
      applyPos(bx, by);
    } else {
      var p2 = loadPos();
      applyPos(p2 ? p2.x : window.innerWidth - 244, p2 ? p2.y : 16);
    }
    if (!skipSave) { try { localStorage.setItem(COLLAPSE_KEY, c ? '1' : '0'); } catch (e) {} }
    render(cur, lastHere);
  }

  function fmtDur(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function render(st, here) {
    if (!host) return;
    cur = st;
    lastHere = here !== false;
    if (!lastHere) st = { state: 'idle' };   // 别的标签页在录制/处理，本页按钮仍可用
    var state = st.state || 'idle';
    var startEn = (state === 'idle' || state === 'done' || state === 'error');
    var stopEn = (state === 'recording');
    els.start.disabled = !startEn;
    els.stop.disabled = !stopEn;
    els.bubble.classList.toggle('rec', state === 'recording');

    var txt;
    if (state === 'recording') txt = '● 录制中 ' + fmtDur(Date.now() - (st.startedAt || Date.now()));
    else if (state === 'processing') txt = '⏳ ' + (st.stage || '处理中…');
    else if (state === 'downloading') txt = '⬇ 保存文件中…';
    else if (state === 'done') txt = '✓ 完成，文件已下载';
    else if (state === 'error') txt = '✗ ' + (st.error || '出错');
    else txt = '○ 就绪';
    els.st.textContent = txt;
    els.st.className = 'st' + (state === 'recording' ? ' rec' : state === 'done' ? ' done' :
      state === 'error' ? ' err' : (state === 'processing' || state === 'downloading') ? ' prog' : '');

    clearInterval(timerId); timerId = 0;
    if (state === 'recording') {
      timerId = setInterval(function () {
        if (cur.state === 'recording') {
          els.st.textContent = '● 录制中 ' + fmtDur(Date.now() - (cur.startedAt || Date.now()));
        }
      }, 500);
    }
  }

  function sendBg(type) {
    try {
      chrome.runtime.sendMessage({ target: 'background', type: type }, function (resp) {
        void chrome.runtime.lastError;
        if (resp && resp.ok === false && resp.error) {
          els.st.textContent = '✗ ' + resp.error;
          els.st.className = 'st err';
        }
        // 无论成败都重拉一次状态（后台可能已推进/在别处复位）
        pullState();
      });
    } catch (e) {}
  }

  function pullState() {
    try {
      chrome.runtime.sendMessage({ target: 'background', type: 'get-panel-state' }, function (resp) {
        void chrome.runtime.lastError;
        if (resp && resp.ok) render(resp.st, resp.recordingHere);
      });
    } catch (e) {}
  }

  function init() {
    chrome.storage.local.get('v2s_cfg', function (o) {
      var cfg = o && o.v2s_cfg;
      if (cfg && cfg.showPanel === false) return;   // 设置里关掉了悬浮面板
      build();
      pullState();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { render: render };
})();
