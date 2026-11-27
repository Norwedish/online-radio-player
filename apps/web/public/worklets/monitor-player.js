/**
 * Direct studio monitor playback: a jitter buffer for Int16 stereo PCM from
 * the playout worker. Waits for `target` ms before starting, re-buffers after
 * a dropout, and skips ahead when it falls too far behind so the delay stays
 * low. Served as a same-origin file (strict CSP: script-src 'self').
 */
class MonitorPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.cap = Math.round(sampleRate * 4);
    this.l = new Float32Array(this.cap);
    this.r = new Float32Array(this.cap);
    this.w = 0;
    this.rd = 0;
    this.count = 0;
    this.target = Math.round((sampleRate * options.processorOptions.targetMs) / 1000);
    this.priming = true;
    this.underruns = 0;
    this.peak = 0;
    this.tick = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === "target") {
        this.target = Math.round((sampleRate * d.ms) / 1000);
        return;
      }
      const s = new Int16Array(d);
      const n = s.length >> 1;
      for (let i = 0; i < n; i++) {
        if (this.count >= this.cap) {
          this.rd = (this.rd + 1) % this.cap;
          this.count--;
        }
        this.l[this.w] = s[2 * i] / 32768;
        this.r[this.w] = s[2 * i + 1] / 32768;
        this.w = (this.w + 1) % this.cap;
        this.count++;
      }
      // Fell behind (hidden tab, network burst): skip ahead so the delay stays low.
      const max = this.target * 2 + Math.round(sampleRate * 0.1);
      if (this.count > max) {
        const skip = this.count - this.target;
        this.rd = (this.rd + skip) % this.cap;
        this.count -= skip;
      }
    };
  }
  process(_inputs, outputs) {
    const L = outputs[0][0];
    const R = outputs[0][1] || outputs[0][0];
    const n = L.length;
    if (this.priming) {
      if (this.count >= this.target) this.priming = false;
      else {
        L.fill(0);
        R.fill(0);
        return true;
      }
    }
    for (let i = 0; i < n; i++) {
      if (this.count === 0) {
        L.fill(0, i);
        R.fill(0, i);
        this.priming = true;
        this.underruns++;
        break;
      }
      const a = this.l[this.rd];
      const b = this.r[this.rd];
      L[i] = a;
      R[i] = b;
      const p = a < 0 ? -a : a;
      const q = b < 0 ? -b : b;
      if (p > this.peak) this.peak = p;
      if (q > this.peak) this.peak = q;
      this.rd = (this.rd + 1) % this.cap;
      this.count--;
    }
    if (++this.tick % 40 === 0) {
      this.port.postMessage({
        bufferedMs: (this.count / sampleRate) * 1000,
        underruns: this.underruns,
        peak: this.peak,
      });
      this.peak = 0;
    }
    return true;
  }
}
registerProcessor("monitor-player", MonitorPlayer);
