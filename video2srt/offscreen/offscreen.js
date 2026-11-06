// video2srt offscreen 文档
// 职责：真正捕获标签页音频 → 实时录制 → 解码/降采样 → 编码 MP3 → 调转写 API → 生成 SRT → 下载文件
// 录音期间保持捕获流的音频轨存活，让 offscreen 文档不被回收；全部下载完成后由后台关闭本文档
/* global lamejs, V2S */
'use strict';

var captureStream = null;   // getUserMedia 拿到的 tab 捕获流（音频轨保活用）
var playbackEl = null;      // 捕获音频回放元素：tabCapture 会把标签页静音，靠它让用户照常听声
var audioCtx = null;        // 16k 单声道降采样音频图
var recorder = null;
var recordChunks = [];
var curCfg = null;
var meta = null;            // { found, title, currentTime, duration }

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.target !== 'offscreen') return;
  (async function () {
    try {
      if (msg.type === 'offscreen-start') sendResponse(await startCapture(msg));
      else if (msg.type === 'offscreen-stop') sendResponse(await requestStop());
      else sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

function postProgress(stage, detail, partialSrt) {
  var msg = { target: 'background', type: 'offscreen-progress', stage: stage, detail: detail || '' };
  if (partialSrt) msg.partialSrt = partialSrt;   // 分段转写的部分结果 → 面板实时显示
  chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; });
}

// 最近一次产物的暂存（IndexedDB，扩展同源、文档关闭后仍在，磁盘级容量），
// 供侧边栏面板「保存 MP3/SRT」按钮随时重新保存；sidepanel.js 里有同款读取助手
function idbSet(key, val) {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open('v2s', 1);
    req.onupgradeneeded = function () { req.result.createObjectStore('last'); };
    req.onsuccess = function () {
      var db = req.result;
      var tx = db.transaction('last', 'readwrite').objectStore('last').put(val, key);
      tx.onsuccess = function () { db.close(); resolve(); };
      tx.onerror = function () { db.close(); reject(tx.error); };
    };
    req.onerror = function () { reject(req.error); };
  });
}

async function startCapture(msg) {
  if (recorder) return { ok: false, error: '已在录制中' };
  curCfg = msg.cfg || {};
  meta = msg.info || {};
  recordChunks = [];

  var m = { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId };
  // 与 Chrome 官方 tab capture 示例一致：音视频一起申请（audio-only 在部分版本受限），视频轨拿到后立即停掉
  captureStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: m },
    video: { mandatory: m }
  });
  captureStream.getVideoTracks().forEach(function (t) { t.stop(); });

  // 关键：tabCapture 会把被捕获标签页静音（声音全部进捕获流），不回放用户就听不到——
  // 按 Chrome 官方 tab-capture 示例的做法，在本文档里把捕获流原样播出来；
  // 录的是降采样流（recordStream），回放用原始流，音质不受影响，也不会回录（回放不经过被捕获标签页）
  playbackEl = new Audio();
  playbackEl.srcObject = new MediaStream(captureStream.getAudioTracks());
  try { await playbackEl.play(); } catch (e) { /* 个别环境 autoplay 受限时静默失败，不影响录制 */ }

  // 首选：经 16k 单声道音频图录制（体积小、解码省内存）；失败则回退直接录原始音轨
  var recordStream = captureStream;
  try {
    audioCtx = new AudioContext({ sampleRate: 16000 });
    var src = audioCtx.createMediaStreamSource(captureStream);
    var mono = audioCtx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers';
    var dest = audioCtx.createMediaStreamDestination();
    src.connect(mono);
    mono.connect(dest);
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (audioCtx.state === 'running' && dest.stream.getAudioTracks().length) {
      recordStream = dest.stream;
    } else {
      throw new Error('AudioContext 未能运行');
    }
  } catch (e) {
    try { if (audioCtx) await audioCtx.close(); } catch (_) {}
    audioCtx = null;
    recordStream = captureStream;
  }

  var mime = (window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
    ? 'audio/webm;codecs=opus' : 'audio/webm';
  recorder = new MediaRecorder(new MediaStream(recordStream.getAudioTracks()), { mimeType: mime });
  recorder.ondataavailable = function (e) { if (e.data && e.data.size) recordChunks.push(e.data); };
  recorder.onstop = onRecorderStopped;
  recorder.start(1000);
  return { ok: true };
}

async function requestStop() {
  if (!recorder) return { ok: false, error: '当前没有进行中的录制' };
  postProgress('正在停止录制…');
  recorder.stop(); // stop 自身会触发最后一次 ondataavailable
  return { ok: true };
}

function onRecorderStopped() {
  recorder = null;
  // 关掉音频图，但保留 captureStream 音频轨：offscreen 文档靠它存活到下载结束
  if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
  finalize().catch(function (e) {
    chrome.runtime.sendMessage(
      { target: 'background', type: 'offscreen-error', error: String((e && e.message) || e) },
      function () { void chrome.runtime.lastError; }
    );
  });
}

async function finalize() {
  postProgress('解码录音…');
  var blob = new Blob(recordChunks, { type: 'audio/webm' });
  recordChunks = [];
  if (!blob.size) throw new Error('未录到音频：请确认录制期间视频在播放且未静音');

  // 解码（webm/opus）→ 统一重采样为 16kHz 单声道
  var ab = await blob.arrayBuffer();
  var decodeCtx = new OfflineAudioContext(1, 1, 48000);
  var decoded = await decodeCtx.decodeAudioData(ab);
  var targetLen = Math.max(1, Math.ceil(decoded.duration * 16000));
  var off = new OfflineAudioContext(1, targetLen, 16000);
  var srcNode = off.createBufferSource();
  srcNode.buffer = decoded;
  srcNode.connect(off.destination);
  srcNode.start(0);
  var monoBuf = await off.startRendering();
  var pcm16 = V2S.floatToInt16(monoBuf.getChannelData(0));

  // 静音检查（抽样峰值）
  var peak = 0;
  for (var i = 0; i < pcm16.length; i += 97) { var a = Math.abs(pcm16[i]); if (a > peak) peak = a; }
  if (peak < 30) throw new Error('录音几乎全是静音：请确认视频没有静音、页面标签页正在出声');
  var durSec = pcm16.length / 16000;

  postProgress('编码 MP3…');
  var kbps = Number(curCfg.bitrate) || 48;
  var mp3Blob = encodeMp3(pcm16, 16000, kbps);

  var base = V2S.buildBaseName(meta && meta.title);
  var files = [{ url: URL.createObjectURL(mp3Blob), filename: '视频转写/' + base + '.mp3' }];
  var note = '';
  var srtText = null;

  // 暂存最近一次的 MP3 与文件名（失败不影响主流程，只是面板按钮暂时无货可存）
  try { await idbSet('mp3', mp3Blob); await idbSet('base', base); } catch (e) {}

  if (curCfg && curCfg.apiKey && curCfg.baseUrl) {
    try {
      srtText = await produceSrt(pcm16, durSec, postProgress);
    } catch (e) {
      note = '转写失败：' + String((e && e.message) || e) + '（MP3 已保存，可手动转写）';
    }
    if (srtText) {
      // 前置 UTF-8 BOM，Windows 播放器/记事本打开中文 SRT 不乱码
      // MIME 必须用 application/x-subrip：text/plain 会被 Chrome 下载子系统把 .srt 擅自改成 .txt（实测）
      var srtBlob = new Blob(['﻿' + srtText], { type: 'application/x-subrip' });
      files.push({ url: URL.createObjectURL(srtBlob), filename: '视频转写/' + base + '.srt' });
    }
  } else {
    note = '未配置转写 API，本次仅导出 MP3（可在扩展设置里配置）';
  }

  // srtText 原文（无 BOM）随消息带给后台，供侧边栏面板显示与复制。
  // 保存模式：勾选「结束后自动弹框保存」→ 弹保存框存两个文件；
  //           未勾选 → 不自动保存，产物留在暂存（IDB）与面板，点「保存 MP3/SRT」手动存
  if (curCfg && curCfg.autoSaveDialog) {
    await downloadFiles(files, note, srtText);
  } else {
    var doneNote = (note ? note + '；' : '') + '未自动保存：点面板「保存 MP3/SRT」按钮保存文件';
    postProgress('完成', doneNote);
    chrome.runtime.sendMessage(
      { target: 'background', type: 'offscreen-done-direct', note: doneNote, srt: srtText || '' },
      function () { void chrome.runtime.lastError; }
    );
  }
}

// 分段转写并合并为一条 SRT —— 精确时间轴策略：
// 1) 先转一段 PROBE_SEC（约 25s，切在静音处）探测模型能力；
// 2) 模型返回分段（verbose_json，如 whisper 系）→ 剩余按用户配置的大段转写，逐句精确时间戳；
// 3) 模型只回纯文本（如 SenseVoice）→ 剩余按 PROBE_SEC 细分段，每段文字只在自己的
//    时间窗内按句均分，把估算误差限制在单段（~25s）内，而非整条录音。
var PROBE_SEC = 25;

async function produceSrt(pcm16, durSec, progress) {
  var sr = 16000;
  var offset = Math.max(0, +((meta && meta.currentTime) || 0) || 0);
  var maxEnd = (meta && +meta.duration > 0) ? +meta.duration : 0;
  var bigChunkSec = Math.max(60, ((+curCfg.chunkMinutes) || 20) * 60);
  var kbps = Number(curCfg.bitrate) || 48;

  // 短音频（不足两段）直接整段转
  if (durSec <= PROBE_SEC * 1.6) {
    progress('转写中…', '已录 ' + Math.round(durSec) + ' 秒');
    var r0 = await transcribeBlob(encodeMp3(pcm16, sr, kbps));
    if (r0.timed && r0.segments.length) return V2S.buildSrtTimed(r0.segments, offset, maxEnd);
    if (!String(r0.text || '').trim()) throw new Error('转写结果为空');
    return V2S.buildSrtEstimated(r0.text, offset, offset + durSec);
  }

  // 探测段：[0, probeEnd)
  var cutsFine = V2S.findCutPoints(pcm16, sr, PROBE_SEC, 8);
  var probeEnd = cutsFine.length ? cutsFine[0] : Math.floor(durSec * 0.5 * sr);
  progress('转写中（探测段精度…）', '');
  var probe = await transcribeBlob(encodeMp3(pcm16.subarray(0, probeEnd), sr, kbps));

  if (probe.timed) {
    // 模型支持分段 → 大段转写、精确时间戳；每段完成即推送部分结果，面板实时滚动显示
    var segs = probe.segments.map(function (s) { return { start: s.start, end: s.end, text: s.text }; });
    progress('转写中（第 1 段，精确时间戳）…', '', V2S.buildSrtTimed(segs, offset, maxEnd));
    var rest = splitPieces(pcm16, sr, bigChunkSec, probeEnd);
    for (var i = 0; i < rest.length; i++) {
      progress('转写中（第 ' + (i + 2) + '/' + (rest.length + 1) + ' 段，精确时间戳）…', '');
      var rb = await transcribeBlob(encodeMp3(pcm16.subarray(rest[i].a, rest[i].b), sr, kbps));
      for (var j = 0; j < rb.segments.length; j++) {
        segs.push({ start: rb.segments[j].start + rest[i].t0, end: rb.segments[j].end + rest[i].t0, text: rb.segments[j].text });
      }
      progress('转写中（第 ' + (i + 2) + '/' + (rest.length + 1) + ' 段，精确时间戳）…', '', V2S.buildSrtTimed(segs, offset, maxEnd));
    }
    if (segs.length) return V2S.buildSrtTimed(segs, offset, maxEnd);
    throw new Error('转写结果为空');
  }

  // 纯文本模型 → 25s 细分段，误差限制在段内；同样每段推送部分结果
  var textPieces = [{ text: String(probe.text || ''), start: offset, end: offset + probeEnd / sr }];
  progress('转写中（第 1 段，细分估算时间轴）…', '', V2S.buildSrtEstimatedPieces(textPieces));
  var fineRest = splitPieces(pcm16, sr, PROBE_SEC, probeEnd);
  for (var k = 0; k < fineRest.length; k++) {
    progress('转写中（第 ' + (k + 2) + '/' + (fineRest.length + 1) + ' 段，细分估算时间轴）…', '');
    var rf = await transcribeBlob(encodeMp3(pcm16.subarray(fineRest[k].a, fineRest[k].b), sr, kbps));
    textPieces.push({
      text: String(rf.text || ''),
      start: offset + fineRest[k].t0,
      end: offset + fineRest[k].b / sr
    });
    progress('转写中（第 ' + (k + 2) + '/' + (fineRest.length + 1) + ' 段，细分估算时间轴）…', '', V2S.buildSrtEstimatedPieces(textPieces));
  }
  var srt = V2S.buildSrtEstimatedPieces(textPieces);
  if (!srt) throw new Error('转写结果为空');
  return srt;
}

// 把 pcm 按 chunkSec 在静音处切段；fromSample 之后才开始产生切点（探测段之后）
function splitPieces(pcm16, sr, chunkSec, fromSample) {
  var cuts = V2S.findCutPoints(pcm16, sr, chunkSec, Math.min(30, chunkSec / 4));
  var pieces = [];
  var prev = Math.max(0, fromSample || 0);
  for (var i = 0; i < cuts.length; i++) {
    if (cuts[i] <= prev) continue;
    pieces.push({ a: prev, b: cuts[i], t0: prev / sr });
    prev = cuts[i];
  }
  pieces.push({ a: prev, b: pcm16.length, t0: prev / sr });
  return pieces.filter(function (p) { return p.b - p.a > sr * 5; });
}

// 调用 OpenAI 兼容的 /audio/transcriptions
async function transcribeBlob(mp3Blob) {
  var base = String(curCfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 API Base URL');
  var fd = new FormData();
  fd.append('file', mp3Blob, 'audio.mp3');
  fd.append('model', String(curCfg.model || 'whisper-1'));
  fd.append('response_format', 'verbose_json');
  if (curCfg.language) fd.append('language', String(curCfg.language));

  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 10 * 60 * 1000);
  var res;
  try {
    res = await fetch(base + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + curCfg.apiKey },
      body: fd,
      signal: ctrl.signal
    });
  } catch (e) {
    throw new Error('转写请求发送失败（网络/代理/URL）：' + ((e && e.message) || e));
  } finally {
    clearTimeout(timer);
  }
  var raw = await res.text();
  if (!res.ok) throw new Error('转写 API 返回 ' + res.status + '：' + raw.slice(0, 300));
  var j = null;
  try { j = JSON.parse(raw); } catch (_) { j = { text: raw }; }
  var segs = [];
  if (Array.isArray(j.segments)) {
    for (var i = 0; i < j.segments.length; i++) {
      var s = j.segments[i];
      var txt = String(s.text || '').trim();
      var st = +s.start || 0, en = +s.end || 0;
      if (txt && en > st) segs.push({ start: st, end: en, text: txt });
    }
  }
  return { segments: segs, text: String(j.text || ''), timed: segs.length > 0 };
}

// lamejs 编码 MP3（单声道）
function encodeMp3(pcm16, sampleRate, kbps, onProgress) {
  if (typeof lamejs === 'undefined') throw new Error('MP3 编码器(lamejs)未加载');
  var enc = new lamejs.Mp3Encoder(1, sampleRate, kbps);
  var block = 1152 * 64;
  var parts = [];
  for (var i = 0; i < pcm16.length; i += block) {
    var buf = enc.encodeBuffer(pcm16.subarray(i, Math.min(i + block, pcm16.length)));
    if (buf.length > 0) parts.push(new Uint8Array(buf));
    if (onProgress) onProgress(i / pcm16.length);
  }
  var tail = enc.flush();
  if (tail.length > 0) parts.push(new Uint8Array(tail));
  return new Blob(parts, { type: 'audio/mpeg' });
}

async function downloadFiles(files, note, srtText) {
  postProgress('弹保存框…', note || '');
  // 自动模式（勾选「结束后自动弹框保存」）：每个文件弹 Save As 框由用户选位置
  // 首选：在本文档内直接调 downloads API（blob URL 与本文档同源，一定可用）
  var ids = [];
  var directOk = !!(chrome.downloads && chrome.downloads.download);
  if (directOk) {
    try {
      for (var i = 0; i < files.length; i++) {
        ids.push(await chrome.downloads.download({
          url: files[i].url, filename: files[i].filename, saveAs: true
        }));
      }
    } catch (e) {
      directOk = false;
    }
  }
  if (directOk) {
    trackDownloadsThenDone(ids, note, srtText);
  } else {
    // 兜底：交给后台 service worker 下载并跟踪
    await new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(
        { target: 'background', type: 'offscreen-files', files: files, note: note || '', srt: srtText || '' },
        function (resp) {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(resp);
        }
      );
    });
  }
}

// 等所有下载完结（complete/interrupted）后通知后台收尾并关闭 offscreen
function trackDownloadsThenDone(ids, note, srtText) {
  var pending = new Set(ids);
  function reportDone() {
    chrome.runtime.sendMessage(
      { target: 'background', type: 'offscreen-done-direct', note: note || '', srt: srtText || '' },
      function () { void chrome.runtime.lastError; }
    );
  }
  if (!pending.size) return reportDone();
  var listener = function (delta) {
    if (!pending.has(delta.id)) return;
    if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
      pending.delete(delta.id);
      if (!pending.size) {
        try { chrome.downloads.onChanged.removeListener(listener); } catch (_) {}
        reportDone();
      }
    }
  };
  chrome.downloads.onChanged.addListener(listener);
}
