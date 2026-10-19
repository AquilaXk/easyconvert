/**
 * Multichannel test signals that share nothing with the converter: a WAVE_FORMAT_EXTENSIBLE writer that gives every
 * channel a tone of its own, and a Goertzel filter that reads the level of one tone in one channel of decoded PCM.
 * A channel that is swapped, dropped or mixed shows as a tone in the wrong channel.
 */

/** Speaker position bits of the WAVE channel mask (Microsoft `ksmedia.h`, SPEAKER_*). */
export const SPEAKER = {
  frontLeft: 0x1,
  frontRight: 0x2,
  frontCenter: 0x4,
  lowFrequency: 0x8,
  backLeft: 0x10,
  backRight: 0x20,
  backCenter: 0x100,
  sideLeft: 0x200,
  sideRight: 0x400,
} as const;

/** One layout: the mask of its speakers and the name FFmpeg shows for it. Speakers are stored in ascending bit order. */
export interface ToneLayout {
  readonly name: string;
  readonly mask: number;
}

export const LAYOUT_5_1_SIDE: ToneLayout = {
  name: '5.1(side)',
  mask: SPEAKER.frontLeft | SPEAKER.frontRight | SPEAKER.frontCenter | SPEAKER.lowFrequency | SPEAKER.sideLeft | SPEAKER.sideRight,
};
export const LAYOUT_5_0_SIDE: ToneLayout = {
  name: '5.0(side)',
  mask: SPEAKER.frontLeft | SPEAKER.frontRight | SPEAKER.frontCenter | SPEAKER.sideLeft | SPEAKER.sideRight,
};
export const LAYOUT_QUAD_SIDE: ToneLayout = {
  name: 'quad(side)',
  mask: SPEAKER.frontLeft | SPEAKER.frontRight | SPEAKER.sideLeft | SPEAKER.sideRight,
};
export const LAYOUT_5_1_BACK: ToneLayout = {
  name: '5.1',
  mask: SPEAKER.frontLeft | SPEAKER.frontRight | SPEAKER.frontCenter | SPEAKER.lowFrequency | SPEAKER.backLeft | SPEAKER.backRight,
};
export const LAYOUT_7_1: ToneLayout = {
  name: '7.1',
  mask: LAYOUT_5_1_BACK.mask | SPEAKER.sideLeft | SPEAKER.sideRight,
};

/** Tone of each channel in Hz, in the order the channels are stored; every one is far from the others and from the harmonics of a lower one. */
export const CHANNEL_TONES_HZ: readonly number[] = [400, 600, 800, 80, 1000, 1200, 1400, 1700];

const KSDATAFORMAT_SUBTYPE_PCM = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const BYTES_PER_SAMPLE = 2;
const EXTENSIBLE_FMT_BYTES = 40;
const PCM_FULL_SCALE = 32767;

function channelCountOf(mask: number): number {
  let count = 0;
  for (let bits = mask; bits !== 0; bits >>>= 1) count += bits & 1;
  return count;
}

/** A 16-bit WAVE_FORMAT_EXTENSIBLE file of `seconds` in which channel k carries a sine of `CHANNEL_TONES_HZ[k]` at `amplitude` (0 to 1). */
export function toneWav(layout: ToneLayout, sampleRate: number, seconds: number, amplitude: number): Buffer {
  const channels = channelCountOf(layout.mask);
  const frames = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(frames * channels * BYTES_PER_SAMPLE);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.round(amplitude * PCM_FULL_SCALE * Math.sin((2 * Math.PI * CHANNEL_TONES_HZ[channel] * frame) / sampleRate));
      data.writeInt16LE(value, (frame * channels + channel) * BYTES_PER_SAMPLE);
    }
  }
  const fmt = Buffer.alloc(EXTENSIBLE_FMT_BYTES);
  fmt.writeUInt16LE(WAVE_FORMAT_EXTENSIBLE, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 8);
  fmt.writeUInt16LE(channels * BYTES_PER_SAMPLE, 12);
  fmt.writeUInt16LE(16, 14);
  fmt.writeUInt16LE(22, 16);
  fmt.writeUInt16LE(16, 18);
  fmt.writeUInt32LE(layout.mask, 20);
  KSDATAFORMAT_SUBTYPE_PCM.copy(fmt, 24);
  const chunk = (id: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt), chunk('data', data)]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/** Amplitude (0 to 1 of full scale) of the sine of `frequencyHz` in channel `channel` of interleaved s16le `pcm`. */
export function toneAmplitude(pcm: Buffer, channels: number, channel: number, frequencyHz: number, sampleRate: number): number {
  const frames = Math.floor(pcm.length / (channels * BYTES_PER_SAMPLE));
  const w = (2 * Math.PI * frequencyHz) / sampleRate;
  let cos = 0;
  let sin = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const x = pcm.readInt16LE((frame * channels + channel) * BYTES_PER_SAMPLE) / PCM_FULL_SCALE;
    cos += x * Math.cos(w * frame);
    sin += x * Math.sin(w * frame);
  }
  return (2 * Math.hypot(cos, sin)) / frames;
}

/** Root mean square (0 to 1 of full scale) of channel `channel` of interleaved s16le `pcm`. */
export function channelRms(pcm: Buffer, channels: number, channel: number): number {
  const frames = Math.floor(pcm.length / (channels * BYTES_PER_SAMPLE));
  let energy = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const x = pcm.readInt16LE((frame * channels + channel) * BYTES_PER_SAMPLE) / PCM_FULL_SCALE;
    energy += x * x;
  }
  return Math.sqrt(energy / frames);
}

export function toDecibels(ratio: number): number {
  return 20 * Math.log10(ratio);
}
