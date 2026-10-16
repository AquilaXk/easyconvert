import { describe, expect, it } from 'vitest';
import {
  encodeFrame,
  FrameReader,
  FRAME_PREFIX_BYTES,
  LauncherProtocolError,
  MAX_HEADER_BYTES,
  type LauncherReply,
  type LauncherRequest,
} from '../src/lib/security/sandbox-launcher-protocol';

describe('launcher frames', () => {
  const request: LauncherRequest = { type: 'run', id: 7, binary: '/usr/bin/qpdf', args: ['--check', 'in.pdf'], hasStdin: true, options: { strictIsolation: false } };

  it('round-trips a header and a payload cut into chunks of any size', () => {
    const payload = Buffer.from(Array.from({ length: 3000 }, (_, index) => index % 251));
    const wire = Buffer.concat(encodeFrame(request, payload));
    for (const size of [1, 2, 7, 8, 9, 64, 1000, wire.length]) {
      const reader = new FrameReader<LauncherRequest>();
      const frames = [];
      for (let at = 0; at < wire.length; at += size) frames.push(...reader.push(wire.subarray(at, at + size)));
      expect(frames).toHaveLength(1);
      expect(frames[0].header).toEqual(request);
      expect(frames[0].payload.equals(payload)).toBe(true);
    }
  });

  it('reads several frames that arrive in one chunk, and a frame without payload', () => {
    const reply: LauncherReply = { type: 'ready' };
    const wire = Buffer.concat([...encodeFrame(reply), ...encodeFrame(request, Buffer.from('abc')), ...encodeFrame(reply)]);
    const frames = new FrameReader<LauncherRequest | LauncherReply>().push(wire);
    expect(frames.map((frame) => frame.header)).toEqual([reply, request, reply]);
    expect(frames.map((frame) => frame.payload.toString('utf8'))).toEqual(['', 'abc', '']);
  });

  it('joins payload given as several buffers without changing a byte', () => {
    const parts = [Buffer.from('out-'), Buffer.alloc(0), Buffer.from('err')];
    const frames = new FrameReader<LauncherReply>().push(Buffer.concat(encodeFrame({ type: 'ready' }, ...parts)));
    expect(frames[0].payload.toString('utf8')).toBe('out-err');
  });

  it('refuses a header longer than any a peer sends and a header that is not JSON', () => {
    const tooLong = Buffer.alloc(FRAME_PREFIX_BYTES);
    tooLong.writeUInt32BE(MAX_HEADER_BYTES + 1, 0);
    expect(() => new FrameReader<unknown>().push(tooLong)).toThrow(LauncherProtocolError);

    const notJson = Buffer.alloc(FRAME_PREFIX_BYTES + 4);
    notJson.writeUInt32BE(4, 0);
    notJson.write('nope', FRAME_PREFIX_BYTES);
    expect(() => new FrameReader<unknown>().push(notJson)).toThrow(LauncherProtocolError);
  });
});
