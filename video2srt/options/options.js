'use strict';

// 与 background.js 中的 DEFAULT_CFG 保持一致
var DEFAULT_CFG = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  model: 'FunAudioLLM/SenseVoiceSmall',
  language: '',
  bitrate: 48,
  chunkMinutes: 20,
  forceOneX: true,
  autoStopOnEnded: false,
  showPanel: true
};

function $(s) { return document.querySelector(s); }

async function load() {
  var o = await chrome.storage.local.get('v2s_cfg');
  var cfg = Object.assign({}, DEFAULT_CFG, o.v2s_cfg || {});
  $('#baseUrl').value = cfg.baseUrl || '';
  $('#apiKey').value = cfg.apiKey || '';
  $('#model').value = cfg.model || '';
  $('#language').value = cfg.language || '';
  $('#bitrate').value = String(cfg.bitrate || 48);
  $('#chunkMinutes').value = String(cfg.chunkMinutes || 20);
  $('#forceOneX').checked = cfg.forceOneX !== false;
  $('#autoStopOnEnded').checked = !!cfg.autoStopOnEnded;
  $('#showPanel').checked = cfg.showPanel !== false;
}

function collect() {
  return {
    baseUrl: $('#baseUrl').value.trim(),
    apiKey: $('#apiKey').value.trim(),
    model: $('#model').value.trim(),
    language: $('#language').value.trim(),
    bitrate: Number($('#bitrate').value) || 48,
    chunkMinutes: Math.min(60, Math.max(5, Number($('#chunkMinutes').value) || 20)),
    forceOneX: $('#forceOneX').checked,
    autoStopOnEnded: $('#autoStopOnEnded').checked,
    showPanel: $('#showPanel').checked
  };
}

$('#saveBtn').addEventListener('click', async function () {
  await chrome.storage.local.set({ v2s_cfg: collect() });
  $('#status').textContent = '✓ 已保存';
  $('#status').style.color = '#1f9d61';
});

$('#keysBtn').addEventListener('click', function () {
  chrome.runtime.sendMessage({ target: 'background', type: 'open-shortcuts' }, function () {
    void chrome.runtime.lastError;
  });
});

$('#testBtn').addEventListener('click', async function () {
  var cfg = collect();
  var el = $('#status');
  if (!cfg.baseUrl || !cfg.apiKey) {
    el.textContent = '请先填写 Base URL 和 API Key';
    el.style.color = '#d0455b';
    return;
  }
  el.textContent = '测试中…';
  el.style.color = '#6b7280';
  var base = cfg.baseUrl.replace(/\/+$/, '');
  try {
    var res = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + cfg.apiKey } });
    if (res.ok) {
      el.textContent = '✓ 连接成功（HTTP ' + res.status + '）';
      el.style.color = '#1f9d61';
    } else {
      var t = await res.text().catch(function () { return ''; });
      el.textContent = '✗ HTTP ' + res.status + '：' + t.slice(0, 120);
      el.style.color = '#d0455b';
    }
  } catch (e) {
    el.textContent = '✗ 网络失败：' + ((e && e.message) || e);
    el.style.color = '#d0455b';
  }
});

load();
