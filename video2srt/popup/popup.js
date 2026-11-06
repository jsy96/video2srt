'use strict';

var STATE_KEY = 'v2s_state';
var lastState = { state: 'idle' };

function $(s) { return document.querySelector(s); }

function displayVersion() {
  // 版本号唯一来源是 manifest.json：1.0.261106.3 → 显示 v1.0.261106-3
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
  if (resp && resp.ok === false) $('#detail').textContent = resp.error || '操作失败';
  render();
});

$('#stopBtn').addEventListener('click', async function () {
  var btn = $('#stopBtn');
  btn.disabled = true;
  var resp = await sendBg('stop-capture');
  if (resp && resp.ok === false) $('#detail').textContent = resp.error || '操作失败';
  render();
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

displayVersion();
render();
setInterval(function () { if (lastState.state === 'recording') render(); }, 500);
chrome.storage.onChanged.addListener(function (ch, area) {
  if (area === 'session' && ch[STATE_KEY]) render();
});
