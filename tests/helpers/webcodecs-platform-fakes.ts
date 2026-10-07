import { vi } from 'vitest';

/**
 * Stand-ins for the browser WebCodecs globals, which Node does not ship. They record what the code under test
 * asks of the platform and hand back what the test queues; they never decide an expected value. A decoder here
 * returns one frame (or one block of silence-free PCM) per input chunk, a stand-in for real decoding that is
 * enough to drive the worker's control flow. Codec correctness is checked elsewhere against reference tools.
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
}

export interface FakeVideoFrame {
  close: ReturnType<typeof vi.fn>;
  timestamp: number;
  displayWidth: number;
  displayHeight: number;
  duration?: number;
}

export interface FakePlatform {
  videoEncoderConfigures: Array<Record<string, unknown>>;
  videoDecoderConfigures: Array<Record<string, unknown>>;
  /** Every frame the fake VideoDecoder produced, in order; `close` is a spy. */
  decodedFrames: FakeVideoFrame[];
  /** Every frame handed to VideoEncoder.encode. */
  encodedFrames: Array<{ timestamp: number }>;
  audioEncoderConfigures: Array<Record<string, unknown>>;
  audioDecoderConfigures: Array<Record<string, unknown>>;
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

/** Installs the fakes and returns the counters; call `restore()` in `afterEach`. */
export function installFakeWebCodecs(options: FakePlatformOptions = {}): FakePlatform {
  const g = globalThis as unknown as Record<string, unknown>;
  const previous = new Map<string, unknown>(GLOBAL_NAMES.map((name) => [name, g[name]]));
  const frameSize = options.decodedFrameSize ?? DEFAULT_FRAME_SIZE;
  const state: FakePlatform = {
    videoEncoderConfigures: [],
    videoDecoderConfigures: [],
    decodedFrames: [],
    encodedFrames: [],
    audioEncoderConfigures: [],
    audioDecoderConfigures: [],
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
    constructor(public init: { type: string; timestamp: number; duration?: number; data: Uint8Array }) {
      this.byteLength = init.data.byteLength;
      this.type = init.type;
      this.timestamp = init.timestamp;
      this.duration = init.duration;
    }
  };
  g.VideoEncoder = class {
    public encodeQueueSize = 0;
    private reportedConfig = false;
    public configure = vi.fn((config: Record<string, unknown>) => {
      state.videoEncoderConfigures.push(config);
    });
    public encode = vi.fn((frame: { timestamp: number }, opts?: { keyFrame?: boolean }) => {
      state.encodedFrames.push({ timestamp: frame.timestamp });
      const bytes = options.videoChunkBytes ?? new Uint8Array([0, 0, 0, 1, 0x65]);
      const metadata =
        options.videoDecoderConfig && !this.reportedConfig ? { decoderConfig: options.videoDecoderConfig } : undefined;
      this.reportedConfig = true;
      this.init.output(
        {
          byteLength: bytes.byteLength,
          copyTo: (dest: Uint8Array) => dest.set(bytes),
          timestamp: frame.timestamp,
          type: opts?.keyFrame ? 'key' : 'delta',
        },
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
  g.VideoDecoder = class {
    public decodeQueueSize = 0;
    public configure = vi.fn((config: Record<string, unknown>) => {
      state.videoDecoderConfigures.push(config);
    });
    public decode = vi.fn((chunk: { timestamp: number; duration?: number }) => {
      const frame: FakeVideoFrame = {
        close: vi.fn(),
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        displayWidth: frameSize.width,
        displayHeight: frameSize.height,
      };
      state.decodedFrames.push(frame);
      this.init.output(frame);
    });
    public flush = vi.fn(async () => undefined);
    public close = vi.fn();
    static isConfigSupported = vi.fn(isSupported);
    constructor(private init: { output: (frame: unknown) => void; error: (e: unknown) => void }) {}
  };
  g.AudioData = class {
    public close = vi.fn();
    public timestamp: number;
    constructor(public init: { timestamp?: number }) {
      this.timestamp = init?.timestamp ?? 0;
      state.audioDataClosers.push(this.close);
    }
  };
  g.EncodedAudioChunk = class {
    public byteLength: number;
    public type: string;
    public timestamp: number;
    public duration?: number;
    constructor(public init: { type: string; timestamp: number; duration?: number; data: Uint8Array }) {
      this.byteLength = init.data.byteLength;
      this.type = init.type;
      this.timestamp = init.timestamp;
      this.duration = init.duration;
    }
  };
  g.AudioEncoder = class {
    public encodeQueueSize = 0;
    private reportedConfig = false;
    public configure = vi.fn((config: Record<string, unknown>) => {
      state.audioEncoderConfigures.push(config);
    });
    public encode = vi.fn((data: { timestamp: number; init?: Record<string, unknown> }) => {
      state.audioDataEncoded.push({ timestamp: data.timestamp, ...(data.init ?? {}) });
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
    public decode = vi.fn((chunk: { timestamp: number }) => {
      const AudioDataFake = g.AudioData as new (init: Record<string, unknown>) => unknown;
      const config = state.audioDecoderConfigures.at(-1) ?? {};
      this.init.output(
        new AudioDataFake({
          format: 'f32',
          sampleRate: config.sampleRate,
          numberOfChannels: config.numberOfChannels,
          numberOfFrames: options.decodedAudioFramesPerChunk,
          timestamp: chunk.timestamp,
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
