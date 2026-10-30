import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { setFlagsFromString } from 'node:v8';

const [mode, file, total, concurrency, jobsPerThread, toggle] = process.argv.slice(2);
if (toggle === 'toggle') {
  let on = false;
  setInterval(() => {
    on = !on;
    setFlagsFromString(on ? '--initial-old-space-size=128' : '--initial-old-space-size=0');
  }, 1).unref();
}
const bytes = fs.readFileSync(file);
const job = { geometry: 'none', content: true, images: true, densityThreshold: 15 };
const entry = path.resolve('dist/pdf-text-worker.js');
let started = 0;

function runThread(jobs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(entry, {
      workerData: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64 },
    });
    let done = 0;
    const send = () => {
      const copy = new Uint8Array(bytes);
      worker.postMessage({ bytes: copy, job }, [copy.buffer]);
    };
    worker.on('message', (reply) => {
      if (!reply.ok) return reject(new Error(reply.message));
      if (++done < jobs) return send();
      if (mode === 'terminate') worker.terminate().then(resolve, reject);
      else resolve(worker);
    });
    worker.on('error', reject);
    send();
  });
}

async function lane() {
  const kept = [];
  while (started < Number(total)) {
    started += Number(jobsPerThread);
    const result = await runThread(Number(jobsPerThread));
    if (mode !== 'terminate') kept.push(result);
  }
  return kept;
}

await Promise.all(Array.from({ length: Number(concurrency) }, lane));
console.log(`${mode} ok`);
process.exit(0);
