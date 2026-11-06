// video2srt PCM 抽头（AudioWorklet 版）
// 在 16k 单声道音频图上并接本处理器，把采样攒成 ~4096 点的 Float32 块发给主线程；
// 主线程转 Int16 后用于录制期间的实时分段转写。
// 放在真实文件（非 blob URL）里加载，符合 MV3 扩展 CSP。
class PcmTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(4096);
    this._n = 0;
  }

  process(inputs) {
    var ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (var i = 0; i < ch.length; i++) {
        this._buf[this._n++] = ch[i];
        if (this._n === this._buf.length) {
          this.port.postMessage(this._buf.slice(0));
          this._n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTapProcessor);
