// video2srt 后台 service worker
// 职责：状态机管理、申请 tab 捕获、创建/关闭 offscreen 文档、兜底下载、
//       汇总进度给侧边栏面板、处理键盘快捷键命令
'use strict';

// 工具栏图标不弹 popup，而是开关侧边栏面板（面板常驻可见，用户随时收起）
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});

var OFFSCREEN_URL = 'offscreen/offscreen.html';
var STATE_KEY = 'v2s_state';
var CFG_KEY = 'v2s_cfg';
// 与 options.js 中的 DEFAULT_CFG 保持一致
var DEFAULT_CFG = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  model: 'FunAudioLLM/SenseVoiceSmall',
  language: '',
  bitrate: 48,
  chunkMinutes: 20,
  forceOneX: true,
  autoStopOnEnded: false
};

async function getCfg() {
  var o = await chrome.storage.local.get(CFG_KEY);
  return Object.assign({}, DEFAULT_CFG, o[CFG_KEY] || {});
}

async function getState() {
  var o = await chrome.storage.session.get(STATE_KEY);
  return o[STATE_KEY] || { state: 'idle' };
}

async function setState(patch) {
  var cur = await getState();
  var next = Object.assign({}, cur, patch);
  await chrome.storage.session.set(objOf(STATE_KEY, next));
  return next;
}

function objOf(k, v) { var o = {}; o[k] = v; return o; }

async function hasOffscreen() {
  var ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (!(await hasOffscreen())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: '录制当前标签页音频并转写为 SRT 字幕'
    });
  }
}

async function closeOffscreen() {
  try { if (await hasOffscreen()) await chrome.offscreen.closeDocument(); } catch (e) {}
}

function sendToOffscreen(msg) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg), function (resp) {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || resp.ok === false) return reject(new Error((resp && resp.error) || 'offscreen 无响应'));
      resolve(resp);
    });
  });
}

async function sendToOffscreenRetry(msg) {
  var lastErr;
  for (var i = 0; i < 3; i++) {
    try { return await sendToOffscreen(msg); }
    catch (e) { lastErr = e; await new Promise(function (r) { setTimeout(r, 300); }); }
  }
  throw lastErr;
}

// ---- 页面信息（视频号走内容脚本；其它页面用 scripting 动态注入兜底）----

function pageVideoInfo() {
  var videos = Array.from(document.querySelectorAll('video'));
  var v = videos.find(function (x) { return !x.paused && x.readyState > 2; }) || videos[0];
  var sels = ['.video-title', '[class*="video-title"]', '[class*="title"]', 'h1', '[class*="desc"]'];
  var title = '';
  for (var i = 0; i < sels.length; i++) {
    var el = document.querySelector(sels[i]);
    var t = (el && el.textContent || '').trim();
    if (t && t.length > 1 && t.length < 120) { title = t; break; }
  }
  if (!title) {
    var m = document.querySelector('meta[property="og:title"]');
    if (m) title = m.content || '';
  }
  if (!title) title = (document.title || '').trim().slice(0, 80);
  return {
    found: !!v,
    title: title,
    currentTime: v ? v.currentTime : 0,
    duration: (v && isFinite(v.duration)) ? v.duration : 0
  };
}

async function getVideoInfo(tabId) {
  var info = await new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, { target: 'content', type: 'get-video-info' }, function (resp) {
        void chrome.runtime.lastError;
        resolve(resp || null);
      });
    } catch (e) { resolve(null); }
  });
  if (!info) {
    try {
      var r = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: pageVideoInfo });
      info = r && r[0] && r[0].result;
    } catch (e) { info = null; }
  }
  return info || { found: false, title: '', currentTime: 0, duration: 0 };
}

async function forceOneX(tabId) {
  await new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, { target: 'content', type: 'force-1x' }, function () {
        void chrome.runtime.lastError; resolve();
      });
    } catch (e) { resolve(); }
  });
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function () { document.querySelectorAll('video').forEach(function (v) { try { v.playbackRate = 1; } catch (e) {} }); }
    });
  } catch (e) {}
}

async function enableEndedWatch(tabId) {
  await new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, { target: 'content', type: 'enable-ended-watch' }, function () {
        void chrome.runtime.lastError; resolve();
      });
    } catch (e) { resolve(); }
  });
}

// ---- 主流程 ----

async function onStartCapture() {
  var st = await getState();
  if (st.state === 'recording') return { ok: false, error: '已在录制中' };
  if (st.state === 'processing' || st.state === 'downloading') return { ok: false, error: '正在处理上一次录制，请稍候或强制结束' };

  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs && tabs[0];
  if (!tab || tab.id == null) return { ok: false, error: '找不到当前标签页' };
  if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url || '')) {
    return { ok: false, error: '请在普通网页标签页（如视频页）中使用' };
  }

  // 先申请捕获流（无副作用阶段）：Chrome 要求扩展被「调用」过（点过工具栏图标/侧边栏
  // 面板按钮/快捷键均自带该标记）。此分支仅作兜底提示。
  var streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (e) {
    if (/has not been invoked/i.test(String((e && e.message) || e))) {
      return { ok: false, error: 'Chrome 尚未授权本页捕获，请重新点一次「开始」或按开始快捷键重试' };
    }
    throw e;
  }

  var cfg = await getCfg();
  await ensureOffscreen();
  var info = await getVideoInfo(tab.id);
  if (cfg.forceOneX) await forceOneX(tab.id);
  if (cfg.autoStopOnEnded) await enableEndedWatch(tab.id);

  await sendToOffscreenRetry({ type: 'offscreen-start', streamId: streamId, cfg: cfg, info: info });
  await setState({ state: 'recording', startedAt: Date.now(), stage: '', detail: '', error: '', pending: [] });
  return { ok: true };
}

async function onStopCapture() {
  var st = await getState();
  if (st.state !== 'recording') return { ok: false, error: '当前没有进行中的录制' };
  await setState({ state: 'processing', stage: '正在停止并处理…', detail: '', error: '' });
  await sendToOffscreenRetry({ type: 'offscreen-stop' });
  return { ok: true };
}

async function onFiles(msg) {
  var ids = [];
  var files = msg.files || [];
  for (var i = 0; i < files.length; i++) {
    try {
      ids.push(await chrome.downloads.download({
        url: files[i].url, filename: files[i].filename, saveAs: false, conflictAction: 'uniquify'
      }));
    } catch (e) { /* 单个失败继续下一个 */ }
  }
  if (!ids.length) {
    await setState({ state: 'error', error: '文件下载失败（未生成任何下载任务）', pending: [] });
    await closeOffscreen();
    return { ok: false, error: '文件下载失败' };
  }
  await setState({
    state: 'downloading', stage: '保存文件中…',
    detail: (msg.note ? msg.note + '；' : '') + '共 ' + ids.length + ' 个文件',
    pending: ids, startedAt: 0
  });
  return { ok: true };
}

async function forceClose() {
  await closeOffscreen();
  await setState({ state: 'idle', stage: '', detail: '', error: '', startedAt: 0, pending: [] });
  return { ok: true };
}

async function onVideoEnded() {
  var st = await getState();
  if (st.state !== 'recording') return { ok: true, skipped: true };
  var cfg = await getCfg();
  if (!cfg.autoStopOnEnded) return { ok: true, skipped: true };
  return await onStopCapture();
}

// ---- 消息路由 ----

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.target !== 'background') return;
  (async function () {
    try {
      switch (msg.type) {
        case 'start-capture': sendResponse(await onStartCapture()); break;
        case 'stop-capture': sendResponse(await onStopCapture()); break;
        case 'open-shortcuts': {
          // 快捷键自定义页（chrome:// 页只能由扩展上下文打开）
          await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
          sendResponse({ ok: true });
          break;
        }
        case 'reset-state':
          sendResponse(await setState({ state: 'idle', stage: '', detail: '', error: '', startedAt: 0, pending: [] }));
          break;
        case 'force-close': sendResponse(await forceClose()); break;
        case 'video-ended': sendResponse(await onVideoEnded()); break;
        case 'offscreen-progress':
          sendResponse(await setState({ stage: msg.stage || '', detail: msg.detail || '' }));
          break;
        case 'offscreen-files': sendResponse(await onFiles(msg)); break;
        case 'offscreen-done-direct': {
          await setState({ state: 'done', stage: '', detail: msg.note || '', error: '', pending: [], startedAt: 0 });
          await closeOffscreen();
          sendResponse({ ok: true });
          break;
        }
        case 'offscreen-error':
          await setState({ state: 'error', error: msg.error || '未知错误', stage: '', pending: [] });
          await closeOffscreen();
          sendResponse({ ok: true });
          break;
        default: sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

// 键盘快捷键（用户可在 chrome://extensions/shortcuts 自定义按键）
chrome.commands.onCommand.addListener(function (command) {
  (async function () {
    try {
      if (command === 'start-record') await onStartCapture();
      else if (command === 'stop-record') await onStopCapture();
    } catch (e) { /* 快捷键路径无 UI 可展示错误，写入状态 */
      try { await setState({ state: 'error', error: String((e && e.message) || e), stage: '', pending: [] }); } catch (_) {}
    }
  })();
});

// 兜底下载路径的完成跟踪（offscreen 直接下载时它自己跟踪，不经这里）
chrome.downloads.onChanged.addListener(function (delta) {
  (async function () {
    var st = await getState();
    if (!Array.isArray(st.pending) || st.pending.indexOf(delta.id) < 0) return;
    if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
      var rest = st.pending.filter(function (x) { return x !== delta.id; });
      if (!rest.length) {
        await setState({ state: 'done', stage: '', detail: st.detail, pending: [], startedAt: 0 });
        await closeOffscreen();
      } else {
        await setState({ pending: rest });
      }
    }
  })().catch(function () {});
});
