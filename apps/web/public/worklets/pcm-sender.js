/**
 * Browser studio uplink (ADR 0004): float mic samples → Int16 PCM chunks of
 * 960 samples (20 ms mono at 48 kHz) posted to the main thread, which sends
 * them over the live WebSocket. Served as a same-origin file so the strict
 * Content-Security-Policy (script-src 'self') allows it.
 */
class PcmSender extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(960);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = v < 0 ? v * 32768 : v * 32767;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.buffer.slice(0));
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-sender", PcmSender);
