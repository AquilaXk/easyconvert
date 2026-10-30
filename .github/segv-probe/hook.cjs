const fs = require('node:fs');
const threads = require('node:worker_threads');
const { syncBuiltinESMExports } = require('node:module');

const file = `/tmp/probe/${process.pid}.log`;
fs.mkdirSync('/tmp/probe', { recursive: true });
const t0 = Date.now();
const log = (line) => fs.appendFileSync(file, `${Date.now() - t0} ${line}\n`);
let next = 1;

if (threads.isMainThread) {
  const Base = threads.Worker;
  class Logged extends Base {
    constructor(entry, options = {}) {
      super(entry, options);
      const id = next++;
      const label = String(entry).slice(-60).replace(/\s+/g, ' ');
      log(`start #${id} tid=${this.threadId} ${label}`);
      this.once('online', () => log(`online #${id}`));
      this.once('exit', (code) => log(`exit #${id} code=${code}`));
      const terminate = this.terminate.bind(this);
      this.terminate = () => {
        log(`terminate #${id}`);
        return terminate();
      };
    }
  }
  threads.Worker = Logged;
  syncBuiltinESMExports();
  process.on('message', (job) => {
    if (job && job.name) log(`job ${job.id} ${job.name} -> ${job.target}`);
  });
}
