import { vi } from 'vitest';

/**
 * Stand-ins for the browser WebCodecs globals, which Node does not ship. They record what the code under test
 * asks of the platform and hand back what the test queues; they never decide an expected value. A decoder here
 * returns one frame (or one block of PCM) per input chunk, a stand-in for real decoding that is enough to
 * drive the worker's control flow. Codec correctness is checked elsewhere against reference tools.
 */

export interface FakeDecodedFrameSize {
  width: number;
  height: number;
}

export interface FakePlatformOptions {
  /** Bytes the fake VideoEncoder emits for every encoded frame. */
  videoChunkBytes?: Uint8Array;
  /** Decoder config the fake VideoEncoder reports with its first output chunk. */
  videoDecoderConfig?: { codec: string; description?: Uint8Array; codedWidth?: number; codedHeight?: number };
  /** Bytes the fake AudioEncoder emits for every encoded block. */
  audioChunkBytes?: Uint8Array;
  audioDecoderConfig?: { codec: string; description?: Uint8Array; sampleRate?: number; numberOfChannels?: number };
  /** Size of the frames the fake VideoDecoder produces. */
  decodedFrameSize?: FakeDecodedFrameSize;
  /** Frames per AudioData the fake AudioDecoder produces for every encoded audio chunk. */
  decodedAudioFramesPerChunk?: number;
  /** Sample rate the fake AudioDecoder reports instead of the configured one (as an SBR decoder would). */
  decodedAudioSampleRate?: number;
  /** The fake VideoEncoder queues each frame and emits its chunk on a later task, raising and lowering encodeQueueSize. */
  asyncVideoEncoder?: boolean;
}

export interface FakeVideoFrame {
  close: ReturnType<typeof vi.fn>;
  timestamp: number;
  displayWidth: number;
  displayHeight: number;
  duration?: number;
}

export interface FakeEncodedChunkRecord {
  type: string;
  timestamp: number;
  duration?: number;
  data: Uint8Array;
}

export interface FakePlatform {
  videoEncoderConfigures: Array<Record<string, unknown>>;
  videoDecoderConfigures: Array<Record<string, unknown>>;
  /** Every chunk handed to VideoDecoder.decode, in order. */
  videoChunksDecoded: FakeEncodedChunkRecord[];
  /** Every frame the fake VideoDecoder produced, in order; `close` is a spy. */
  decodedFrames: FakeVideoFrame[];
  /** Every frame handed to VideoEncoder.encode. */
  encodedFrames: Array<{ timestamp: number }>;
  audioEncoderConfigures: Array<Record<string, unknown>>;
  audioDecoderConfigures: Array<Record<string, unknown>>;
  /** Every chunk handed to AudioDecoder.decode, in order. */
  audioChunksDecoded: FakeEncodedChunkRecord[];
  /** The init (format, sampleRate, numberOfFrames, timestamp, data, ...) of every AudioData handed to encode(). */
  audioDataEncoded: Array<Record<string, unknown>>;
  /** Spies on the `close` of every AudioData created, in order. */
  audioDataClosers: Array<ReturnType<typeof vi.fn>>;
  /** Codec strings the platform reports as unsupported to isConfigSupported. */
  unsupportedCodecs: Set<string>;
  restore: () => void;
}

const GLOBAL_NAMES = [
  'VideoEncoder',
  'VideoDecoder',
  'VideoFrame',
  'EncodedVideoChunk',
  'AudioEncoder',
  'AudioDecoder',
  'AudioData',
  'EncodedAudioChunk',
] as const;

const DEFAULT_FRAME_SIZE: FakeDecodedFrameSize = { width: 0, height: 0 };
const MICROS_PER_SECOND = 1_000_000;

type PcmArray = Int16Array | Int32Array | Float32Array;

const S16_FULL_SCALE = 32768;
const S32_FULL_SCALE = 2 ** 31;

/** Sample `index` of an interleaved array as a float in [-1, 1), the way AudioData.copyTo converts it. */
function asFloat(data: PcmArray, format: string, index: number): number {
  if (format === 's16') return data[index] / S16_FULL_SCALE;
  if (format === 's32') return data[index] / S32_FULL_SCALE;
  return data[index];
}

/** Installs the fakes and returns the counters; call `restore()` in `afterEach`. */
export function installFakeWebCodecs(options: FakePlatformOptions = {}): FakePlatform {
  const g = globalThis as unknown as Record<string, unknown>;
  const previous = new Map<string, unknown>(GLOBAL_NAMES.map((name) => [name, g[name]]));
  const frameSize = options.decodedFrameSize ?? DEFAULT_FRAME_SIZE;
  const state: FakePlatform = {
    videoEncoderConfigures: [],
    videoDecoderConfigures: [],
    videoChunksDecoded: [],
    decodedFrames: [],
    encodedFrames: [],
    audioEncoderConfigures: [],
    audioDecoderConfigures: [],
    audioChunksDecoded: [],
    audioDataEncoded: [],
    audioDataClosers: [],
    unsupportedCodecs: new Set<string>(),
    restore: () => {
      for (const [name, value] of previous) {
        if (value === undefined) delete g[name];
        else g[name] = value;
      }
    },
  };

  const isSupported = async (config: { codec?: string }) => ({
    supported: !(config.codec !== undefined && state.unsupportedCodecs.has(config.codec)),
    config,
  });

  g.VideoFrame = class {
    public close = vi.fn();
    public timestamp: number;
    constructor(
      public source: unknown,
      public init: { timestamp?: number }
    ) {
      this.timestamp = init?.timestamp ?? 0;
    }
  };
  g.EncodedVideoChunk = class {
    public byteLength: number;
    public type: string;
    public timestamp: number;
    public duration?: number;
    public data: Uint8Array;
    constructor(init: { type: string; timestamp: number; duration?: number; data: Uint8Array }) {
      this.byteLength = init.data.byteLength;
      this.type = init.type;
      this.timestamp = init.timestamp;
      this.duration = init.duration;
      this.data = init.data;
    }
  };
  g.VideoEncoder = class {
    public encodeQueueSize = 0;
    public ondequeue?: () => void;
    private reportedConfig = false;
    private outstanding = 0;
    public configure = vi.fn((config: Record<string, unknown>) => {
      state.videoEncoderConfigures.push(config);
    });
    public encode = vi.fn((frame: { timestamp: number; duration?: number }, opts?: { keyFrame?: boolean }) => {
      state.encodedFrames.push({ timestamp: frame.timestamp });
      const bytes = options.videoChunkBytes ?? new Uint8Array([0, 0, 0, 1, 0x65]);
      const metadata =
        options.videoDecoderConfig && !this.reportedConfig ? { decoderConfig: options.videoDecoderConfig } : undefined;
      this.reportedConfig = true;
      const chunk = {
        byteLength: bytes.byteLength,
        copyTo: (dest: Uint8Array) => dest.set(bytes),
        timestamp: frame.timestamp,
        duration: frame.duration ?? null,
        type: opts?.keyFrame ? 'key' : 'delta',
      };
      if (!options.asyncVideoEncoder) {
        this.init.output(chunk, metadata);
        return;
      }
      this.encodeQueueSize++;
      this.outstanding++;
      setTimeout(() => {
        this.encodeQueueSize--;
        this.init.output(chunk, metadata);
        this.ondequeue?.();
        this.outstanding--;
      }, 0);
    });
    public flush = vi.fn(async () => {
      while (this.outstanding > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    public close = vi.fn();
    static isConfigSupported = vi.fn(isSupported);
    constructor(
      private init: { output: (chunk: unknown, metadata?: unknown) => void; error: (e: unknown) => void }
    ) {}
  };
  g.VideoDecoder = class {
    public decodeQueueSize = 0;
    /** Frames wait here until flush, then leave in presentation order as a decoder with reordering delay emits them. */
    private held: FakeVideoFrame[] = [];
    public configure = vi.fn((config: Record<string, unknown>) => {
      state.videoDecoderConfigures.push(config);
    });
    public decode = vi.fn((chunk: FakeEncodedChunkRecord) => {
      state.videoChunksDecoded.push({
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        data: chunk.data,
      });
      const frame: FakeVideoFrame = {
        close: vi.fn(),
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        displayWidth: frameSize.width,
        displayHeight: frameSize.height,
      };
      state.decodedFrames.push(frame);
      this.held.push(frame);
    });
    public flush = vi.fn(async () => {
      const frames = this.held.sort((a, b) => a.timestamp - b.timestamp);
      this.held = [];
      for (const frame of frames) this.init.output(frame);
    });
    public close = vi.fn();
    static isConfigSupported = vi.fn(isSupported);
    constructor(private init: { output: (frame: unknown) => void; error: (e: unknown) => void }) {}
  };
  g.AudioData = class {
    public close = vi.fn();
    public format: string;
    public sampleRate: number;
    public numberOfFrames: number;
    public numberOfChannels: number;
    public timestamp: number;
    public duration: number;
    constructor(
      public init: {
        format: string;
        sampleRate: number;
        numberOfFrames: number;
        numberOfChannels: number;
        timestamp: number;
        data?: PcmArray;
      }
    ) {
      this.format = init.format;
      this.sampleRate = init.sampleRate;
      this.numberOfFrames = init.numberOfFrames;
      this.numberOfChannels = init.numberOfChannels;
      this.timestamp = init.timestamp;
      this.duration = Math.round((init.numberOfFrames * MICROS_PER_SECOND) / init.sampleRate);
      state.audioDataClosers.push(this.close);
    }
    /** Only the conversion the worker asks for: interleaved or planar source to `f32-planar`. */
    allocationSize(opts: { planeIndex: number; frameOffset?: number; frameCount?: number }): number {
      const frames = opts.frameCount ?? this.numberOfFrames - (opts.frameOffset ?? 0);
      return frames * Float32Array.BYTES_PER_ELEMENT;
    }
    copyTo(dest: Float32Array, opts: { planeIndex: number; frameOffset?: number; frameCount?: number; format?: string }): void {
      const data = this.init.data as PcmArray;
      const offset = opts.frameOffset ?? 0;
      const frames = opts.frameCount ?? this.numberOfFrames - offset;
      for (let i = 0; i < frames; i++) {
        dest[i] = asFloat(data, this.format, (offset + i) * this.numberOfChannels + opts.planeIndex);
      }
    }
  };
  g.EncodedAudioChunk = class {
    public byteLength: number;
    public type: string;
    public timestamp: number;
    public duration?: number;
    public data: Uint8Array;
    constructor(init: { type: string; timestamp: number; duration?: number; data: Uint8Array }) {
      this.byteLength = init.data.byteLength;
      this.type = init.type;
      this.timestamp = init.timestamp;
      this.duration = init.duration;
      this.data = init.data;
    }
  };
  g.AudioEncoder = class {
    public encodeQueueSize = 0;
    private reportedConfig = false;
    public configure = vi.fn((config: Record<string, unknown>) => {
      state.audioEncoderConfigures.push(config);
    });
    public encode = vi.fn((data: { timestamp: number; init?: Record<string, unknown> }) => {
      state.audioDataEncoded.push({ ...(data.init ?? {}), timestamp: data.timestamp });
      const bytes = options.audioChunkBytes ?? new Uint8Array([0x21, 0x10, 0x04]);
      const metadata =
        options.audioDecoderConfig && !this.reportedConfig ? { decoderConfig: options.audioDecoderConfig } : undefined;
      this.reportedConfig = true;
      this.init.output(
        { byteLength: bytes.byteLength, copyTo: (dest: Uint8Array) => dest.set(bytes), timestamp: data.timestamp },
        metadata
      );
    });
    public flush = vi.fn(async () => undefined);
    public close = vi.fn();
    static isConfigSupported = vi.fn(isSupported);
    constructor(
      private init: { output: (chunk: unknown, metadata?: unknown) => void; error: (e: unknown) => void }
    ) {}
  };
  g.AudioDecoder = class {
    public decodeQueueSize = 0;
    public configure = vi.fn((config: Record<string, unknown>) => {
      state.audioDecoderConfigures.push(config);
    });
    public decode = vi.fn((chunk: FakeEncodedChunkRecord) => {
      state.audioChunksDecoded.push({
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        data: chunk.data,
      });
      const AudioDataFake = g.AudioData as new (init: Record<string, unknown>) => unknown;
      const config = state.audioDecoderConfigures.at(-1) ?? {};
      const channels = Number(config.numberOfChannels);
      const frames = options.decodedAudioFramesPerChunk ?? 0;
      const data = new Float32Array(frames * channels).map((_, index) => (index % 100) / 100);
      this.init.output(
        new AudioDataFake({
          format: 'f32',
          sampleRate: options.decodedAudioSampleRate ?? config.sampleRate,
          numberOfChannels: channels,
          numberOfFrames: frames,
          timestamp: chunk.timestamp,
          data,
        })
      );
    });
    public flush = vi.fn(async () => undefined);
    public close = vi.fn();
    static isConfigSupported = vi.fn(isSupported);
    constructor(private init: { output: (data: unknown) => void; error: (e: unknown) => void }) {}
  };

  return state;
}
