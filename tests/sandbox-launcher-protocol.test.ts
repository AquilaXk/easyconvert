import { describe, expect, it } from 'vitest';
import {
  capStream,
  encodeFrame,
  isBadFrame,
  FrameReader,
  FRAME_PREFIX_BYTES,
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

  it('reports a header that is too long as a bad frame with the id of its request, skips its bytes and reads on', () => {
    const header = Buffer.from(JSON.stringify({ type: 'error', id: 41, error: { kind: 'process', message: 'x'.repeat(MAX_HEADER_BYTES + 10) } }));
    const prefix = Buffer.alloc(FRAME_PREFIX_BYTES);
    prefix.writeUInt32BE(header.length, 0);
    prefix.writeUInt32BE(5, 4);
    const wire = Buffer.concat([prefix, header, Buffer.from('hello'), ...encodeFrame({ type: 'ready' })]);
    for (const size of [1000, 65536, wire.length]) {
      const reader = new FrameReader<LauncherReply>();
      const frames = [];
      for (let at = 0; at < wire.length; at += size) frames.push(...reader.push(wire.subarray(at, at + size)));
      expect(frames).toHaveLength(2);
      expect(frames[0]).toEqual({ bad: true, id: 41, reason: 'frame header too long' });
      expect(isBadFrame(frames[1]) ? null : frames[1].header).toEqual({ type: 'ready' });
    }
  });

  it('reports a header that is not JSON as a bad frame, with its id when the first bytes show it, and reads on', () => {
    const bad = Buffer.from('{"type":"result","id":9,oops');
    const prefix = Buffer.alloc(FRAME_PREFIX_BYTES);
    prefix.writeUInt32BE(bad.length, 0);
    const unattributable = Buffer.from('nope');
    const prefix2 = Buffer.alloc(FRAME_PREFIX_BYTES);
    prefix2.writeUInt32BE(unattributable.length, 0);
    const frames = new FrameReader<LauncherReply>().push(Buffer.concat([prefix, bad, prefix2, unattributable, ...encodeFrame({ type: 'ready' })]));
    expect(frames.map((frame) => (isBadFrame(frame) ? { id: frame.id, reason: frame.reason } : frame.header))).toEqual([
      { id: 9, reason: 'frame header is not JSON' },
      { id: undefined, reason: 'frame header is not JSON' },
      { type: 'ready' },
    ]);
  });

  it('keeps the head and the tail of a long text, with a note of the cut, and a short text as it is', () => {
    const long = Buffer.concat([Buffer.from('HEAD'), Buffer.alloc(100_000, 'x'), Buffer.from('TAIL')]);
    const capped = capStream(long, 1000, 1000).toString('utf8');
    expect(capped.startsWith('HEAD')).toBe(true);
    expect(capped.endsWith('TAIL')).toBe(true);
    expect(capped).toContain('[... 98008 bytes omitted ...]');
    expect(capped.length).toBeLessThan(2100);
    const short = Buffer.from('invalid password');
    expect(capStream(short, 1000, 1000)).toBe(short);
  });
});
