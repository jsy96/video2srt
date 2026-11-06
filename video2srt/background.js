// video2srt 后台 service worker
// 职责：状态机管理、申请 tab 捕获、创建/关闭 offscreen 文档、兜底下载、
//       汇总进度给侧边栏面板、处理键盘快捷键命令
'use strict';

// 工具栏图标不弹 popup，而是开关侧边栏面板（面板常驻可见，用户随时收起）
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});

var OFFSCREEN_URL = 'offscreen/offscreen.html';
var STATE_KEY = 'v2s_state';
var CFG_KEY = 'v2s_cfg';
var LAST_SRT_KEY = 'v2s_last_srt';   // 最近一次识别结果原文（面板显示/复制用，storage.local 持久）
// 与 options.js 中的 DEFAULT_CFG 保持一致
var DEFAULT_CFG = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  model: 'FunAudioLLM/SenseVoiceSmall',
  language: '',
  bitrate: 48,
  chunkMinutes: 20,
  forceOneX: true,
  autoStopOnEnded: false,
  autoSkipAd: true,
  saveAsMp3: false,
  saveAsSrt: false
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

  // lastFocusedWindow：service worker 里 currentWindow 语义不可靠（无所属窗口），
  // 用户刚点过面板/快捷键，聚焦窗口即目标窗口
  var tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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
      return {
        ok: false,
        error: '本页还没授权捕获（Chrome 规定侧边栏按钮不算授权）：按一下开始快捷键，或在页面右键菜单点「🎙 开始录制本页音频」即可'
      };
    }
    throw e;
  }

  var cfg = await getCfg();
  await chrome.storage.local.remove(LAST_SRT_KEY);   // 新一轮录制，旧识别结果不再显示
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
  if (msg.srt) await chrome.storage.local.set(objOf(LAST_SRT_KEY, msg.srt));
  var cfg = await getCfg();
  var ids = [];
  var files = msg.files || [];
  for (var i = 0; i < files.length; i++) {
    try {
      // 用户勾选「弹框保存」时对应文件弹 Save As 框（与 offscreen 直下路径同规则）
      var dialog = /\.srt$/i.test(files[i].filename) ? !!cfg.saveAsSrt : !!cfg.saveAsMp3;
      ids.push(await chrome.downloads.download({
        url: files[i].url, filename: files[i].filename, saveAs: dialog, conflictAction: 'uniquify'
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
          await chrome.storage.local.remove(LAST_SRT_KEY);
          sendResponse(await setState({ state: 'idle', stage: '', detail: '', error: '', startedAt: 0, pending: [] }));
          break;
        case 'force-close': sendResponse(await forceClose()); break;
        case 'video-ended': sendResponse(await onVideoEnded()); break;
        case 'offscreen-progress':
          // 分段转写的部分结果即时写库 → 侧边栏面板实时滚动显示
          if (msg.partialSrt) await chrome.storage.local.set(objOf(LAST_SRT_KEY, msg.partialSrt));
          sendResponse(await setState({ stage: msg.stage || '', detail: msg.detail || '' }));
          break;
        case 'offscreen-files': sendResponse(await onFiles(msg)); break;
        case 'offscreen-done-direct': {
          if (msg.srt) await chrome.storage.local.set(objOf(LAST_SRT_KEY, msg.srt));
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

// ---- 页面右键菜单：快捷键之外的授权入口 ----
// tabCapture 的「扩展被调用过」授权按标签页发放，侧边栏/弹窗内按钮的点击不算；
// 右键菜单点击与快捷键都构成授权，且不受侧边栏全局常驻的影响
chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({ id: 'v2s-start', title: '🎙 开始录制本页音频', contexts: ['page', 'video'] });
    chrome.contextMenus.create({ id: 'v2s-stop', title: '⏹ 停止录制并生成文件', contexts: ['page', 'video'] });
  });
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  (async function () {
    try {
      if (info.menuItemId === 'v2s-start') {
        var r = await onStartCapture();
        // 顺手展开侧边栏面板显示状态（菜单点击带用户手势，允许 open）
        if (tab && tab.windowId != null && r && r.ok) {
          try { await chrome.sidePanel.open({ windowId: tab.windowId }); } catch (e) {}
        }
      } else if (info.menuItemId === 'v2s-stop') {
        await onStopCapture();
      }
    } catch (e) {
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
