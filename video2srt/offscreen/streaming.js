// video2srt 流式 ASR 客户端：FunASR 本地服务 / 腾讯云实时语音识别
// 录制期间由 offscreen 把 16k 单声道 PCM 逐块喂给 WebSocket，逐句拿实时结果。
// 只依赖 WebSocket / crypto.subtle，不依赖 chrome.*，可在任意扩展页面加载与测试。
//
// 统一会话接口（三个引擎一致，含默认分段模式的占位行为）：
//   sess.feed(Int16Array)        送一段 16k 单声道 PCM
//   sess.finish() -> Promise     发结束信号并等待收尾（超时兜底）
//   sess.abort()                 立即关闭
// 回调（构造参数）：onPartial(text) / onFinal(text, replaceLast) / onClose(errOrNull)
//   - onFinal 的 replaceLast=true 表示服务端对上一句的离线纠正（FunASR 2pass）
(function (root) {
  'use strict';

  // ---------- 内部：真实 WebSocket 会话 ----------
  function wsSession(ws, handlers, finishTimeoutMs) {
    var q = [];
    var ended = false;      // 已发送结束信号
    var ending = false;     // 收尾中（onClose 不再视为异常）
    var resolveDone = null;
    var done = new Promise(function (r) { resolveDone = r; });
    var guard = setTimeout(function () { resolveDone(); }, finishTimeoutMs || 4000);

    ws.onmessage = function (ev) { try { handlers.onMessage(ev, api); } catch (e) {} };
    ws.onclose = function () {
      clearTimeout(guard);
      resolveDone();
      handlers.onClose(api, ending);
    };
    ws.onerror = function () {};

    function flush() {
      while (ws.readyState === 1 && q.length) {
        try { ws.send(q.shift()); } catch (e) { break; }
      }
    }

    var api = {
      feed: function (pcm16) {
        if (ended) return;
        // 拷贝视图对应的字节（Int16 LE 即服务端要的 pcm 裸流）
        q.push(pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + pcm16.byteLength));
        flush();
      },
      flushQueue: flush,
      markEnding: function () { ending = true; },
      finish: function () {
        if (!ended) { ended = true; ending = true; handlers.sendEnd(ws); }
        flush();
        return done;
      },
      abort: function () { ended = true; ending = true; try { ws.close(); } catch (e) {} }
    };
    return api;
  }

  // ---------- 内部：会话惰性包装（连接建立前缓存 feed/finish，用于异步签名建连） ----------
  function lazySession(connect) {
    var sess = null, failed = false;
    var feedQ = [], finishWaiters = [];
    var aborted = false;
    var api = {
      feed: function (p) { if (sess) sess.feed(p); else if (!failed) feedQ.push(p); },
      finish: function () {
        if (sess) return sess.finish();
        if (failed) return Promise.resolve();
        return new Promise(function (res) { finishWaiters.push(res); });
      },
      abort: function () {
        aborted = true;
        if (sess) sess.abort();
      },
      _settle: function (s) {
        if (s) {
          sess = s;
          while (feedQ.length) sess.feed(feedQ.shift());
          var ws2 = finishWaiters; finishWaiters = [];
          if (aborted) sess.abort();
          else ws2.forEach(function (r) { r(sess.finish()); });
        } else {
          failed = true;
          finishWaiters.forEach(function (r) { r(); });
        }
      }
    };
    connect(api._settle);
    return api;
  }

  // ---------- FunASR 本地流式（官方 runtime WebSocket 协议） ----------
  function createFunasr(opts) {
    opts = opts || {};
    var onPartial = opts.onPartial || function () {};
    var onFinal = opts.onFinal || function () {};
    var onClose = opts.onClose || function () {};

    return lazySession(function (settle) {
      var ws;
      try {
        ws = new WebSocket(opts.url || 'ws://127.0.0.1:10096');
        ws.binaryType = 'arraybuffer';
      } catch (e) {
        onClose(String((e && e.message) || e));
        settle(null);
        return;
      }

      var sess = wsSession(ws, {
        onMessage: function (ev, api) {
          if (typeof ev.data !== 'string') return;
          var j = null;
          try { j = JSON.parse(ev.data); } catch (e) { return; }
          if (j.error || (j.err_no && j.err_no !== 0)) {
            api.markEnding();
            onClose(String(j.error || j.err_msg || 'FunASR 服务报错'));
            api.abort();
            return;
          }
          var text = String(j.text || '');
          if (j.mode === 'offline') { if (text) onFinal(text, true); return; }   // 2pass 纠正
          if (j.is_final) { if (text) onFinal(text, false); }
          else if (text) onPartial(text);
        },
        sendEnd: function (w) { try { w.send(JSON.stringify({ is_speaking: false })); } catch (e) {} },
        onClose: function (api, ending) { onClose(ending ? null : 'FunASR 连接已断开'); }
      }, 4000);

      ws.onopen = function () {
        try {
          ws.send(JSON.stringify({
            mode: 'online',
            chunk_size: [5, 10, 5],
            chunk_interval: 1,
            wav_name: 'v2s',
            wav_format: 'pcm',
            audio_fs: 16000,
            is_speaking: true
          }));
        } catch (e) {}
        sess.flushQueue();
      };
      settle(sess);
    });
  }

  // ---------- 腾讯云实时语音识别（WebSocket + HMAC-SHA1 签名） ----------
  // 签名串（官方语音识别特有算法，纯函数便于测试）：
  // "GETasr.cloud.tencent.com/asr/v2/?" + 按 key 排序的 k=v 用 & 连接（值不 urlencode）
  function tencentSignStr(params) {
    var keys = Object.keys(params).sort();
    return 'GETasr.cloud.tencent.com/asr/v2/?' +
      keys.map(function (k) { return k + '=' + params[k]; }).join('&');
  }

  async function tencentHmacB64(secretKey, signStr) {
    var enc = new TextEncoder();
    var key = await crypto.subtle.importKey('raw', enc.encode(secretKey), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    var sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(signStr)));
    var s = '';
    for (var i = 0; i < sig.length; i++) s += String.fromCharCode(sig[i]);
    return btoa(s);
  }

  async function tencentSignedUrl(cfg) {
    var now = Math.floor(Date.now() / 1000);
    var params = {
      engine_model_type: cfg.model || '16k_zh',
      expired: String(now + 600),
      needvad: '1',
      nonce: String(Math.floor(Math.random() * 1e9)),
      secretid: String(cfg.secretId || ''),
      timestamp: String(now),
      voice_format: 'pcm'
    };
    var signStr = tencentSignStr(params);
    var b64 = await tencentHmacB64(String(cfg.secretKey || ''), signStr);
    var keys = Object.keys(params).sort();
    var qs = keys.map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&') +
      '&signature=' + encodeURIComponent(b64);
    return 'wss://asr.cloud.tencent.com/asr/v2/' + encodeURIComponent(String(cfg.appId || '')) + '?' + qs;
  }

  function createTencent(opts) {
    opts = opts || {};
    var onPartial = opts.onPartial || function () {};
    var onFinal = opts.onFinal || function () {};
    var onClose = opts.onClose || function () {};

    return lazySession(function (settle) {
      tencentSignedUrl(opts).then(function (url) {
        var ws;
        try {
          ws = new WebSocket(url);
          ws.binaryType = 'arraybuffer';
        } catch (e) {
          onClose(String((e && e.message) || e));
          settle(null);
          return;
        }

        var sess = wsSession(ws, {
          onMessage: function (ev, api) {
            if (typeof ev.data !== 'string') return;
            var j = null;
            try { j = JSON.parse(ev.data); } catch (e) { return; }
            if (typeof j.code === 'number' && j.code !== 0) {
              // 4001/4003 参数或签名错、11/12 正常收尾码之外视为异常
              if (j.code === 11 || j.code === 12) { api.markEnding(); return; }
              api.markEnding();
              onClose('腾讯云 ' + j.code + '：' + (j.message || '未知错误'));
              api.abort();
              return;
            }
            var r = j.result || {};
            var text = String(r.voice_text_str || '');
            if (!text) return;
            if (r.slice_type === 2) onFinal(text, false);
            else onPartial(text);
          },
          sendEnd: function (w) { try { w.send(JSON.stringify({ type: 'end' })); } catch (e) {} },
          onClose: function (api, ending) { onClose(ending ? null : '腾讯云连接已断开'); }
        }, 4000);

        ws.onopen = function () { sess.flushQueue(); };
        settle(sess);
      }).catch(function (e) {
        onClose(String((e && e.message) || e));
        settle(null);
      });
    });
  }

  root.V2SStream = {
    createFunasr: createFunasr,
    createTencent: createTencent,
    tencentSignStr: tencentSignStr,
    tencentHmacB64: tencentHmacB64
  };
})(typeof self !== 'undefined' ? self : globalThis);
