/**
 * Hand-assembled RIFF/WAVE files for the OPFS audio tests, built from the WAVE specification: PCM or float
 * fmt chunks, optional extra chunks before and after the data, and the pad byte after an odd chunk. It imports
 * nothing from src.
 */

export interface CraftedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Format tag; 1 is integer PCM, 3 is IEEE float. */
  formatTag?: number;
  data: Uint8Array;
  /** Chunks written between fmt and data. */
  before?: Array<{ id: string; body: Uint8Array }>;
  /** Chunks written after the data chunk. */
  after?: Array<{ id: string; body: Uint8Array }>;
  /** Overrides the data chunk size field (to craft a truncated or lying file). */
  dataSizeField?: number;
}

function chunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length + (body.length % 2));
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

export function craftWav(spec: CraftedWav): Uint8Array {
  const blockAlign = (spec.channels * spec.bitsPerSample) / 8;
  const fmt = new Uint8Array(16);
  const fmtView = new DataView(fmt.buffer);
  fmtView.setUint16(0, spec.formatTag ?? 1, true);
  fmtView.setUint16(2, spec.channels, true);
  fmtView.setUint32(4, spec.sampleRate, true);
  fmtView.setUint32(8, spec.sampleRate * blockAlign, true);
  fmtView.setUint16(12, blockAlign, true);
  fmtView.setUint16(14, spec.bitsPerSample, true);
  const dataChunk = chunk('data', spec.data);
  if (spec.dataSizeField !== undefined) new DataView(dataChunk.buffer).setUint32(4, spec.dataSizeField, true);
  const parts = [
    chunk('fmt ', fmt),
    ...(spec.before ?? []).map((c) => chunk(c.id, c.body)),
    dataChunk,
    ...(spec.after ?? []).map((c) => chunk(c.id, c.body)),
  ];
  const body = parts.reduce((total, part) => total + part.length, 4);
  const out = new Uint8Array(8 + body);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(out.buffer).setUint32(4, body, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  let at = 12;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Interleaved little-endian 16-bit samples as bytes. */
export function int16Bytes(samples: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return out;
}

/** A sine tone of `frames` frames at `rate`, channel c scaled by `1 / (c + 1)`, as interleaved samples. */
export function sineSamples(frames: number, channels: number, rate: number, freq: number, amplitude: number): Int16Array {
  const out = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      out[i * channels + c] = Math.round((amplitude / (c + 1)) * Math.sin((2 * Math.PI * freq * i) / rate));
    }
  }
  return out;
}
