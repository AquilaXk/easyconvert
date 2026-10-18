/**
 * Standard MIDI Files made and measured by hand from the specification (Standard MIDI Files 1.0), with no library and no
 * synthesizer: the expected pitch of a note is the equal-temperament formula and the expected length of a piece is the sum
 * of its delta times at the tempo in force, so neither comes from the renderer under test.
 */

const HEADER_LENGTH = 6;
const FORMAT_SINGLE_TRACK = 0;
const DEFAULT_DIVISION = 480;
const DEFAULT_MICROSECONDS_PER_QUARTER = 500_000;
const DEFAULT_VELOCITY = 100;
const MICROSECONDS_PER_SECOND = 1_000_000;
const META_EVENT = 0xff;
const META_TEMPO = 0x51;
const META_END_OF_TRACK = 0x2f;
const SYSEX_START = 0xf0;
const SYSEX_ESCAPE = 0xf7;
const STATUS_BIT = 0x80;
const PROGRAM_CHANGE = 0xc0;
const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;
const CHANNEL_PRESSURE = 0xd0;
const SMPTE_DIVISION_BIT = 0x8000;
const CONCERT_PITCH_NOTE = 69;
const CONCERT_PITCH_HZ = 440;
const SEMITONES_PER_OCTAVE = 12;
const VLQ_PAYLOAD_BITS = 7;
const VLQ_PAYLOAD_MASK = 0x7f;
const VLQ_MAX_BYTES = 4;

export interface MidiNote {
  /** MIDI note number, 69 is A4. */
  note: number;
  startTick: number;
  lengthTicks: number;
  /** General MIDI program, 0 based; piano when absent. */
  program?: number;
}

export interface MidiPiece {
  division?: number;
  microsecondsPerQuarter?: number;
}

/** Frequency of a note in Hz in twelve-tone equal temperament with A4 at 440 Hz. */
export function noteFrequencyHz(note: number): number {
  return CONCERT_PITCH_HZ * 2 ** ((note - CONCERT_PITCH_NOTE) / SEMITONES_PER_OCTAVE);
}

function variableLength(value: number): number[] {
  const bytes = [value & VLQ_PAYLOAD_MASK];
  for (let rest = value >>> VLQ_PAYLOAD_BITS; rest > 0; rest >>>= VLQ_PAYLOAD_BITS) bytes.unshift((rest & VLQ_PAYLOAD_MASK) | STATUS_BIT);
  return bytes;
}

interface TimedEvent {
  tick: number;
  bytes: number[];
}

/** A format 0 file of one track: the tempo, then the notes on channel 0 in time order. */
export function craftMidi(notes: readonly MidiNote[], piece: MidiPiece = {}): Buffer {
  const division = piece.division ?? DEFAULT_DIVISION;
  const tempo = piece.microsecondsPerQuarter ?? DEFAULT_MICROSECONDS_PER_QUARTER;
  const events: TimedEvent[] = [{ tick: 0, bytes: [META_EVENT, META_TEMPO, 3, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff] }];
  for (const { note, startTick, lengthTicks, program } of notes) {
    if (program !== undefined) events.push({ tick: startTick, bytes: [PROGRAM_CHANGE, program] });
    events.push({ tick: startTick, bytes: [NOTE_ON, note, DEFAULT_VELOCITY] });
    events.push({ tick: startTick + lengthTicks, bytes: [NOTE_OFF, note, 0] });
  }
  events.sort((a, b) => a.tick - b.tick);
  const endTick = events.reduce((latest, event) => Math.max(latest, event.tick), 0);
  events.push({ tick: endTick, bytes: [META_EVENT, META_END_OF_TRACK, 0] });
  const body: number[] = [];
  let previous = 0;
  for (const event of events) {
    body.push(...variableLength(event.tick - previous), ...event.bytes);
    previous = event.tick;
  }
  const header = Buffer.alloc(HEADER_LENGTH + 8);
  header.write('MThd', 0, 'latin1');
  header.writeUInt32BE(HEADER_LENGTH, 4);
  header.writeUInt16BE(FORMAT_SINGLE_TRACK, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt16BE(division, 12);
  const trackHeader = Buffer.alloc(8);
  trackHeader.write('MTrk', 0, 'latin1');
  trackHeader.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, trackHeader, Buffer.from(body)]);
}

/** Data bytes that follow a channel message status. */
function dataLength(status: number): number {
  const kind = status & 0xf0;
  return kind === PROGRAM_CHANGE || kind === CHANNEL_PRESSURE ? 1 : 2;
}

/**
 * Playing time of a Standard MIDI File in seconds: the position of its last event on the tempo map of all its tracks.
 * Files timed in SMPTE frames are not read.
 */
export function midiLengthSeconds(file: Buffer): number {
  if (file.toString('latin1', 0, 4) !== 'MThd') throw new Error('not a Standard MIDI File');
  const trackCount = file.readUInt16BE(10);
  const division = file.readUInt16BE(12);
  if ((division & SMPTE_DIVISION_BIT) !== 0) throw new Error('SMPTE time division is not read');
  const tempoChanges: Array<{ tick: number; microsecondsPerQuarter: number }> = [];
  let lastTick = 0;
  let offset = 8 + file.readUInt32BE(4);
  for (let track = 0; track < trackCount; track++) {
    if (file.toString('latin1', offset, offset + 4) !== 'MTrk') throw new Error(`track ${track} has no MTrk header`);
    const end = offset + 8 + file.readUInt32BE(offset + 4);
    offset += 8;
    let tick = 0;
    let status = 0;
    const readVariable = (): number => {
      let value = 0;
      for (let i = 0; i < VLQ_MAX_BYTES; i++) {
        const byte = file[offset++];
        value = (value << VLQ_PAYLOAD_BITS) | (byte & VLQ_PAYLOAD_MASK);
        if ((byte & STATUS_BIT) === 0) break;
      }
      return value;
    };
    while (offset < end) {
      tick += readVariable();
      if ((file[offset] & STATUS_BIT) !== 0) status = file[offset++];
      if (status === META_EVENT) {
        const type = file[offset++];
        const length = readVariable();
        if (type === META_TEMPO) tempoChanges.push({ tick, microsecondsPerQuarter: file.readUIntBE(offset, 3) });
        offset += length;
      } else if (status === SYSEX_START || status === SYSEX_ESCAPE) {
        offset += readVariable();
      } else {
        offset += dataLength(status);
      }
      lastTick = Math.max(lastTick, tick);
    }
    offset = end;
  }
  tempoChanges.sort((a, b) => a.tick - b.tick);
  let seconds = 0;
  let from = 0;
  let tempo = DEFAULT_MICROSECONDS_PER_QUARTER;
  for (const change of tempoChanges) {
    if (change.tick >= lastTick) break;
    seconds += ((change.tick - from) * tempo) / division / MICROSECONDS_PER_SECOND;
    from = change.tick;
    tempo = change.microsecondsPerQuarter;
  }
  return seconds + ((lastTick - from) * tempo) / division / MICROSECONDS_PER_SECOND;
}

const MIN_PITCH_HZ = 60;
const MAX_PITCH_HZ = 2000;
/** A lag counts as the fundamental when its correlation is within this share of the strongest one, which prefers the shortest period over its multiples. */
const PEAK_SHARE = 0.9;

/**
 * Fundamental frequency of mono samples by autocorrelation: the shortest period whose normalised correlation is close to the
 * strongest one in the range of 60 to 2000 Hz.
 */
export function fundamentalHz(samples: Float64Array, sampleRate: number): number {
  const minLag = Math.floor(sampleRate / MAX_PITCH_HZ);
  const maxLag = Math.ceil(sampleRate / MIN_PITCH_HZ);
  const energy = samples.reduce((sum, value) => sum + value * value, 0);
  const correlation = new Float64Array(maxLag + 1);
  let strongest = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < samples.length; i++) sum += samples[i] * samples[i + lag];
    correlation[lag] = sum / energy;
    strongest = Math.max(strongest, correlation[lag]);
  }
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const isPeak = correlation[lag] >= correlation[lag - 1] && correlation[lag] >= correlation[lag + 1];
    if (isPeak && correlation[lag] >= PEAK_SHARE * strongest) {
      // Parabolic interpolation between the neighbours places the peak between whole samples.
      const [left, centre, right] = [correlation[lag - 1], correlation[lag], correlation[lag + 1]];
      const shift = (left - right) / (2 * (left - 2 * centre + right));
      return sampleRate / (lag + shift);
    }
  }
  throw new Error('no periodic component found');
}
