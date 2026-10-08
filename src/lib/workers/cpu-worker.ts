import { parentPort } from 'node:worker_threads';
import { CPU_TASK_HANDLERS } from './cpu-tasks';

/**
 * Thread entry of the CPU pool: runs `{ id, kind, payload }` messages through the handler for `kind` and answers
 * `{ id, ok, result }` or `{ id, ok: false, error }`. A handler may name ArrayBuffers of its result to transfer.
 */
if (parentPort === null) throw new Error('cpu-worker must run in a worker thread');
const port = parentPort;

interface TaskMessage {
  id: number;
  kind: string;
  payload: unknown;
}

port.on('message', (message: TaskMessage) => {
  const handler = CPU_TASK_HANDLERS[message.kind];
  if (handler === undefined) {
    port.postMessage({ id: message.id, ok: false, error: { name: 'ConversionFailedError', message: `Unknown CPU task kind "${message.kind}"` } });
    return;
  }
  Promise.resolve()
    .then(() => handler(message.payload))
    .then(({ result, transfer }) => {
      port.postMessage({ id: message.id, ok: true, result }, transfer ?? []);
    })
    .catch((error: unknown) => {
      const failure = error as { name?: string; message?: string; status?: number };
      port.postMessage({
        id: message.id,
        ok: false,
        error: { name: failure.name ?? 'Error', message: failure.message ?? String(error), status: failure.status },
      });
    });
});
