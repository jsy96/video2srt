// video2srt 纯函数工具集
// 同时供两处使用：offscreen 页面（挂到 self.V2S）与 Node 单元测试（module.exports）
// 不引用任何 chrome.* / DOM API
(function (root) {
  'use strict';

  function pad(n, w) { return String(Math.floor(n)).padStart(w, '0'); }

  // 秒 → SRT 时间戳 HH:MM:SS,mmm（先换算总毫秒再拆，避免浮点进位误差）
  function secToSrtTime(t) {
    var total = Math.round(Math.max(0, +t || 0) * 1000);
    var h = Math.floor(total / 3600000); total -= h * 3600000;
    var m = Math.floor(total / 60000); total -= m * 60000;
    var s = Math.floor(total / 1000);
    var ms = total - s * 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(ms, 3);
  }

  // Float32 PCM [-1,1] → Int16 PCM
  function floatToInt16(f32) {
    var out = new Int16Array(f32.length);
    for (var i = 0; i < f32.length; i++) {
      var v = Math.round(f32[i] * 32767);
      out[i] = v > 32767 ? 32767 : (v < -32768 ? -32768 : v);
    }
    return out;
  }

  // 在 pcm 中按 chunkSec 间隔找切分点：在每个目标点 ±half 窗口里选能量（RMS）最低的帧
  // 返回样本偏移数组，用于长音频分段转写
  function findCutPoints(pcm, sr, chunkSec, searchSec) {
    var frameN = Math.max(1, Math.floor(sr * 0.05));
    var nFrames = Math.floor(pcm.length / frameN);
    if (nFrames < 10) return [];
    var rms = new Float64Array(nFrames);
    for (var i = 0; i < nFrames; i++) {
      var acc = 0, off = i * frameN, end = off + frameN;
      for (var j = off; j < end; j++) { var x = pcm[j]; acc += x * x; }
      rms[i] = Math.sqrt(acc / frameN);
    }
    var dur = pcm.length / sr;
    var half = Math.max(1, Math.min(searchSec, chunkSec / 4, dur * 0.05));
    var tail = Math.min(30, chunkSec / 2, dur * 0.1);
    var cuts = [], prevCut = -Infinity;
    for (var t = chunkSec; t < dur - tail; t += chunkSec) {
      var lo = Math.max(0, Math.floor((t - half) / 0.05));
      var hi = Math.min(nFrames - 1, Math.floor((t + half) / 0.05));
      if (hi <= lo) continue;
      var best = lo, bestV = Infinity;
      for (var k = lo; k <= hi; k++) if (rms[k] < bestV) { bestV = rms[k]; best = k; }
      var cut = best * frameN;
      if (cut - prevCut > sr * 10) { cuts.push(cut); prevCut = cut; }
    }
    return cuts;
  }

  // 文本 → 字幕句列表：先按句末标点切，超长再按逗号顿号切
  function splitSentences(text, maxLen) {
    maxLen = maxLen || 42;
    var out = [], m;
    var re = /[^。！？!?…]+[。！？!?…]+["”』」）)]*|[^。！？!?…]+$/g;
    var s = String(text || '');
    while ((m = re.exec(s)) !== null) {
      var t = m[0].trim();
      if (t) out.push(t);
    }
    var final = [];
    for (var i = 0; i < out.length; i++) {
      var sent = out[i];
      if (sent.length <= maxLen) { final.push(sent); continue; }
      var buf = '';
      var parts = sent.split(/(?=[，、；,;])/);
      for (var p = 0; p < parts.length; p++) {
        if ((buf + parts[p]).length > maxLen && buf) { pushWrapped(final, buf, maxLen); buf = parts[p]; }
        else buf += parts[p];
      }
      if (buf.trim()) pushWrapped(final, buf, maxLen);
    }
    return final;
  }

  // 连逗号都没有的超长片段：按 maxLen 硬折行
  function pushWrapped(list, s, maxLen) {
    s = s.trim();
    while (s.length > maxLen) {
      list.push(s.slice(0, maxLen).trim());
      s = s.slice(maxLen);
    }
    if (s) list.push(s);
  }

  // 有时间戳的分段 → SRT；offsetSec = 录制开始时视频已播放的秒数（时间轴平移）
  // maxEndSec > 0 时把结尾截到视频时长内
  function buildSrtTimed(segs, offsetSec, maxEndSec) {
    var off = Math.max(0, +offsetSec || 0);
    var maxEnd = +maxEndSec > 0 ? +maxEndSec : Infinity;
    var list = [];
    for (var i = 0; i < segs.length; i++) {
      var sg = segs[i];
      var txt = String(sg.text || '').trim();
      if (!txt) continue;
      list.push({ start: Math.max(0, +sg.start || 0) + off, end: Math.max(0, +sg.end || 0) + off, text: txt });
    }
    list.sort(function (a, b) { return a.start - b.start; });
    var blocks = [];
    for (var j = 0; j < list.length; j++) {
      var it = list[j];
      if (it.start >= maxEnd) continue;
      var end = Math.min(it.end, maxEnd);
      if (end <= it.start) end = it.start + 0.2;
      blocks.push((blocks.length + 1) + '\n' + secToSrtTime(it.start) + ' --> ' + secToSrtTime(end) + '\n' + it.text);
    }
    return blocks.length ? blocks.join('\n\n') + '\n' : '';
  }

  // 无时间戳的全文 → SRT（按句切分、按时长按字数比例估算时间轴，仅兜底用）
  function buildSrtEstimated(text, startSec, endSec, maxLen) {
    var sents = splitSentences(text, maxLen);
    if (!sents.length) return '';
    var total = Math.max(0.5, endSec - startSec);
    var totalChars = 0;
    for (var i = 0; i < sents.length; i++) totalChars += sents[i].length;
    if (!totalChars) totalChars = 1;
    var t = startSec, blocks = [];
    for (var k = 0; k < sents.length; k++) {
      if (t >= endSec) break;
      var d = Math.max(0.4, total * (sents[k].length / totalChars));
      var a = t, b = t + d;
      if (k === sents.length - 1) b = Math.max(b, endSec);
      if (b > endSec) b = endSec;
      blocks.push((blocks.length + 1) + '\n' + secToSrtTime(a) + ' --> ' + secToSrtTime(b) + '\n' + sents[k]);
      t = b;
    }
    return blocks.length ? blocks.join('\n\n') + '\n' : '';
  }

  // Windows 文件名非法字符清理
  function sanitizeFilename(name) {
    var s = String(name || '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.\s]+$/, '');
    if (s.length > 60) s = s.slice(0, 60);
    return s || 'video';
  }

  // 导出文件基础名：标题_YYYYMMDD-HHMMSS
  function buildBaseName(title, date) {
    var d = date || new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    var stamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    return sanitizeFilename(title) + '_' + stamp;
  }

  var api = {
    secToSrtTime: secToSrtTime,
    floatToInt16: floatToInt16,
    findCutPoints: findCutPoints,
    splitSentences: splitSentences,
    buildSrtTimed: buildSrtTimed,
    buildSrtEstimated: buildSrtEstimated,
    sanitizeFilename: sanitizeFilename,
    buildBaseName: buildBaseName
  };
  root.V2S = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
