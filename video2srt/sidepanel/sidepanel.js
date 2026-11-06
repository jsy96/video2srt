'use strict';

// 侧边栏面板（唯一控制面板）：状态轮询 + storage 监听，页面常驻侧边栏实时刷新；
// 识别结果区（srtBox）转写时逐段滚动显示，支持编辑后复制
/* global V2S */
var STATE_KEY = 'v2s_state';
var LAST_SRT_KEY = 'v2s_last_srt';
var lastState = { state: 'idle' };

function $(s) { return document.querySelector(s); }

function displayVersion() {
  // 版本号唯一来源是 manifest.json：1.0.261106.4 → 显示 v1.0.261106-4
  var v = chrome.runtime.getManifest().version.split('.');
  $('#ver').textContent = 'v' + v.slice(0, 3).join('.') + '-' + (v[3] || '1');
}

function fmtDur(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

async function getState() {
  var o = await chrome.storage.session.get(STATE_KEY);
  return o[STATE_KEY] || { state: 'idle' };
}

async function getCfg() {
  var o = await chrome.storage.local.get('v2s_cfg');
  return o.v2s_cfg || {};
}

async function render() {
  var st = await getState();
  var cfg = await getCfg();
  lastState = st;
  var state = st.state || 'idle';
  var host = '';
  try { host = new URL(cfg.baseUrl || '').host; } catch (e) { host = cfg.baseUrl || ''; }
  $('#cfgLine').textContent = cfg.apiKey
    ? ('转写：' + (cfg.model || '?') + ' @ ' + host)
    : '未配置转写 API（将只导出 MP3）';

  var busy = (state === 'processing' || state === 'downloading');
  $('#startBtn').disabled = busy || state === 'recording';
  $('#stopBtn').disabled = state !== 'recording';
  $('#forceLink').hidden = !busy;
  $('#clearLink').hidden = !(state === 'done' || state === 'error');

  if (state === 'recording') {
    $('#stateLine').textContent = '● 录制中 ' + fmtDur(Date.now() - (st.startedAt || Date.now()));
  } else if (state === 'processing') {
    $('#stateLine').textContent = '⏳ ' + (st.stage || '处理中…');
  } else if (state === 'downloading') {
    $('#stateLine').textContent = '⬇ 保存文件中…';
  } else if (state === 'done') {
    $('#stateLine').textContent = '✓ 完成，文件已下载';
  } else if (state === 'error') {
    $('#stateLine').textContent = '✗ 出错';
  } else {
    $('#stateLine').textContent = '○ 就绪';
  }
  $('#detail').textContent = [st.detail, st.error].filter(Boolean).join(' ｜ ');
}

function sendBg(type) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage({ target: 'background', type: type }, function (resp) {
      var err = chrome.runtime.lastError;
      resolve(err ? { ok: false, error: err.message } : resp);
    });
  });
}

$('#startBtn').addEventListener('click', async function () {
  var btn = $('#startBtn');
  btn.disabled = true;
  var resp = await sendBg('start-capture');
  // 等 render 完成后再写错误文案（render 是 async，不等它会被其内部的空详情覆盖）；
  // 失败路径不写 storage，onChanged 不会再来覆盖
  await render();
  if (resp && resp.ok === false) $('#detail').textContent = resp.error || '操作失败';
});

$('#stopBtn').addEventListener('click', async function () {
  var btn = $('#stopBtn');
  btn.disabled = true;
  var resp = await sendBg('stop-capture');
  await render();
  if (resp && resp.ok === false) $('#detail').textContent = resp.error || '操作失败';
});

$('#optLink').addEventListener('click', function (e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('#keyLink').addEventListener('click', function (e) {
  e.preventDefault();
  sendBg('open-shortcuts');
});

$('#clearLink').addEventListener('click', function (e) {
  e.preventDefault();
  sendBg('reset-state').then(render);
});

$('#forceLink').addEventListener('click', function (e) {
  e.preventDefault();
  if (!window.confirm('强制结束会丢弃正在处理的数据，确定？')) return;
  sendBg('force-close').then(render);
});

// ---- 识别结果区：显示 / 实时滚动 / 复制 ----

function applySrt(text) {
  var box = $('#srtBox'), sec = $('#result');
  if (!box || !sec) return;
  if (!text) { sec.hidden = true; box.value = ''; return; }
  sec.hidden = false;
  // 只在用户本就停在底部时自动跟到最新（实时滚动）；主动上翻阅读时不打扰
  var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  box.value = text;
  if (atBottom) box.scrollTop = box.scrollHeight;
  $('#copySrtBtn').disabled = false;
  $('#copyTextBtn').disabled = false;
}

async function loadSrt() {
  var o = await chrome.storage.local.get(LAST_SRT_KEY);
  applySrt(o[LAST_SRT_KEY] || '');
}

function copyWithFeedback(btn, getText) {
  var txt = getText();
  if (!txt) return;
  var old = btn.textContent;
  navigator.clipboard.writeText(txt).then(function () {
    btn.textContent = '✓ 已复制';
  }, function () {
    btn.textContent = '✗ 复制失败';
  }).then(function () {
    setTimeout(function () { btn.textContent = old; }, 1200);
  });
}

$('#copySrtBtn').addEventListener('click', function () {
  copyWithFeedback(this, function () { return $('#srtBox').value; });
});
$('#copyTextBtn').addEventListener('click', function () {
  copyWithFeedback(this, function () { return V2S.srtToPlain($('#srtBox').value); });
});

displayVersion();
render();
loadSrt();
setInterval(function () { if (lastState.state === 'recording') render(); }, 500);
chrome.storage.onChanged.addListener(function (ch, area) {
  if (area === 'session' && ch[STATE_KEY]) render();
  if (area === 'local' && ch[LAST_SRT_KEY]) applySrt(ch[LAST_SRT_KEY].newValue || '');
});
