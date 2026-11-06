// video2srt offscreen 文档
// 职责：真正捕获标签页音频 → 实时录制 → 解码/降采样 → 编码 MP3 → 调转写 API → 生成 SRT → 下载文件
// 录音期间保持捕获流的音频轨存活，让 offscreen 文档不被回收；全部下载完成后由后台关闭本文档
/* global lamejs, V2S */
'use strict';

var captureStream = null;   // getUserMedia 拿到的 tab 捕获流（音频轨保活用）
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

function postProgress(stage, detail) {
  chrome.runtime.sendMessage(
    { target: 'background', type: 'offscreen-progress', stage: stage, detail: detail || '' },
    function () { void chrome.runtime.lastError; }
  );
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
  var files = [{ url: URL.createObjectURL(mp3Blob), filename: '视频号转写/' + base + '.mp3' }];
  var note = '';

  if (curCfg && curCfg.apiKey && curCfg.baseUrl) {
    var srtText = null;
    try {
      srtText = await produceSrt(pcm16, durSec, postProgress);
    } catch (e) {
      note = '转写失败：' + String((e && e.message) || e) + '（MP3 已保存，可手动转写）';
    }
    if (srtText) {
      // 前置 UTF-8 BOM，Windows 播放器/记事本打开中文 SRT 不乱码
      // MIME 必须用 application/x-subrip：text/plain 会被 Chrome 下载子系统把 .srt 擅自改成 .txt（实测）
      var srtBlob = new Blob(['﻿' + srtText], { type: 'application/x-subrip' });
      files.push({ url: URL.createObjectURL(srtBlob), filename: '视频号转写/' + base + '.srt' });
    }
  } else {
    note = '未配置转写 API，本次仅导出 MP3（可在扩展设置里配置）';
  }

  await downloadFiles(files, note);
}

// 分段转写长音频并合并为一条 SRT
async function produceSrt(pcm16, durSec, progress) {
  var offset = Math.max(0, +((meta && meta.currentTime) || 0) || 0);
  var maxEnd = (meta && +meta.duration > 0) ? +meta.duration : 0;
  var chunkSec = Math.max(60, ((+curCfg.chunkMinutes) || 20) * 60);
  var kbps = Number(curCfg.bitrate) || 48;

  var pieces = splitPieces(pcm16, 16000, chunkSec);
  var allSegs = [];
  var anyTimed = false;
  var fullText = '';
  for (var i = 0; i < pieces.length; i++) {
    progress('转写中（第 ' + (i + 1) + '/' + pieces.length + ' 段）…', '已录 ' + Math.round(durSec) + ' 秒');
    var pieceMp3 = encodeMp3(pcm16.subarray(pieces[i].a, pieces[i].b), 16000, kbps);
    var r = await transcribeBlob(pieceMp3);
    if (r.timed) anyTimed = true;
    for (var j = 0; j < r.segments.length; j++) {
      var sg = r.segments[j];
      allSegs.push({ start: sg.start + pieces[i].t0, end: sg.end + pieces[i].t0, text: sg.text });
    }
    fullText += r.text || r.segments.map(function (s) { return s.text; }).join('');
  }
  if (anyTimed && allSegs.length) return V2S.buildSrtTimed(allSegs, offset, maxEnd);
  if (!fullText.trim()) throw new Error('转写结果为空');
  return V2S.buildSrtEstimated(fullText, offset, offset + durSec);
}

function splitPieces(pcm16, sr, chunkSec) {
  var cuts = V2S.findCutPoints(pcm16, sr, chunkSec, Math.min(30, chunkSec / 4));
  var pieces = [];
  var prev = 0;
  for (var i = 0; i < cuts.length; i++) {
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

async function downloadFiles(files, note) {
  postProgress('保存文件…', note || '');
  // 首选：在本文档内直接调 downloads API（blob URL 与本文档同源，一定可用）
  var ids = [];
  var directOk = !!(chrome.downloads && chrome.downloads.download);
  if (directOk) {
    try {
      for (var i = 0; i < files.length; i++) {
        ids.push(await chrome.downloads.download({
          url: files[i].url, filename: files[i].filename, saveAs: false, conflictAction: 'uniquify'
        }));
      }
    } catch (e) {
      directOk = false;
    }
  }
  if (directOk) {
    trackDownloadsThenDone(ids, note);
  } else {
    // 兜底：交给后台 service worker 下载并跟踪
    await new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(
        { target: 'background', type: 'offscreen-files', files: files, note: note || '' },
        function (resp) {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(resp);
        }
      );
    });
  }
}

// 等所有下载完结（complete/interrupted）后通知后台收尾并关闭 offscreen
function trackDownloadsThenDone(ids, note) {
  var pending = new Set(ids);
  function reportDone() {
    chrome.runtime.sendMessage(
      { target: 'background', type: 'offscreen-done-direct', note: note || '' },
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
