/** Streaming WAV helpers for pipe-based processors (Stereo Tool stdin/stdout). */

/** 44-byte PCM WAV header with "unknown/streaming" sizes (0xFFFFFFFF). */
export function streamingWavHeader(sampleRate = 48_000, channels = 2, bitsPerSample = 16): Buffer {
  const h = Buffer.alloc(44);
  const blockAlign = (channels * bitsPerSample) / 8;
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(0xffffffff, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(0xffffffff, 40);
  return h;
}

/**
 * Strips a RIFF/WAVE header (any chunk layout) from the start of a stream and
 * passes the `data` payload through. Non-WAV input is passed through untouched.
 */
export class WavStripper {
  private header: Buffer | null = Buffer.alloc(0) as Buffer;

  push(chunk: Buffer): Buffer {
    if (this.header === null) return chunk;
    this.header = Buffer.concat([this.header, chunk]);
    if (this.header.length < 12) return Buffer.alloc(0);
    if (
      this.header.toString("ascii", 0, 4) !== "RIFF" ||
      this.header.toString("ascii", 8, 12) !== "WAVE"
    ) {
      const out = this.header;
      this.header = null;
      return out;
    }
    let pos = 12;
    while (pos + 8 <= this.header.length) {
      const id = this.header.toString("ascii", pos, pos + 4);
      const size = this.header.readUInt32LE(pos + 4);
      if (id === "data") {
        const out = this.header.subarray(pos + 8);
        this.header = null;
        return out;
      }
      if (pos + 8 + size > this.header.length) return Buffer.alloc(0);
      pos += 8 + size + (size % 2);
    }
    if (this.header.length > 65_536) {
      // Malformed: give up and pass through.
      const out = this.header;
      this.header = null;
      return out;
    }
    return Buffer.alloc(0);
  }
}
