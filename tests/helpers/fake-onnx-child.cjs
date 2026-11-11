'use strict';
// A stand-in for the ONNX OCR helper program (src/lib/conversions/ocr-onnx-child.ts) that speaks its protocol without loading a model, so the
// pool's handling of a helper (reuse, replacement, loss, time limit, abort) is tested without onnxruntime. `--mode=` picks the behaviour.
const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=ok').slice(7);
if (mode === 'boot-fail') process.exit(3);
if (mode === 'boot-stderr') {
  process.stderr.write('onnxruntime: mbind: Operation not permitted (seccomp)\n' + 'y'.repeat(100_000));
  process.exit(3);
}

function frame(header) {
  const json = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json]);
}

let buffered = Buffer.alloc(0);
let served = 0;
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    if (buffered.length < 8) return;
    const headerBytes = buffered.readUInt32BE(0);
    const payloadBytes = buffered.readUInt32BE(4);
    const total = 8 + headerBytes + payloadBytes;
    if (buffered.length < total) return;
    const request = JSON.parse(buffered.toString('utf8', 8, 8 + headerBytes));
    buffered = buffered.subarray(total);
    serve(request);
  }
});
process.stdin.on('end', () => process.exit(0));

function serve(request) {
  served++;
  if (mode === 'crash') process.exit(1);
  if (mode === 'hang') return;
  // Frames a hostile helper could send: a header that is JSON but not a reply.
  const hostile = { 'null-header': null, 'number-header': 5, 'string-header': 'x', 'array-header': [1, 2], 'no-type-header': { id: request.id }, 'bad-id-header': { type: 'result', id: 'x', result: {} } };
  if (mode in hostile) return process.stdout.write(frame(hostile[mode]));
  if (mode === 'huge-message') return process.stdout.write(frame({ type: 'error', id: request.id, kind: 'unavailable', message: 'x'.repeat(7 * 1024 * 1024) }));
  if (mode === 'non-string-message') return process.stdout.write(frame({ type: 'error', id: request.id, kind: 'failed', message: { not: 'a string' } }));
  if (mode === 'error') return process.stdout.write(frame({ type: 'error', id: request.id, kind: 'failed', message: 'the page could not be read' }));
  const box = { x: 0, y: 0, width: request.width, height: request.height };
  const confidence = mode === 'bad-confidence' ? 7 : 0.9;
  const word = { text: `p${process.pid}n${served}`, confidence, bbox: box };
  const result = { lineBlocks: [{ text: word.text, bbox: box, words: [word] }] };
  process.stdout.write(frame({ type: 'result', id: request.id, result }));
}

if (mode === 'slow-boot') setTimeout(() => process.stdout.write(frame({ type: 'ready' })), 1500);
else process.stdout.write(frame(mode === 'boot-null' ? null : { type: 'ready' }));
