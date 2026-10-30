import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

interface ComposeFile {
  services: { worker: { environment: Record<string, string | number | null> } };
}

/**
 * The glibc heap bound the service runs with, read from the worker of docker-compose.yml so that a child process that measures
 * memory cannot drift from it (docker-compose.prod.yml sets the same value; the `tests` job of ci.yml sets none).
 */
function serviceMallocArenaMax(): string {
  const compose = parse(readFileSync(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf-8'), { merge: true }) as ComposeFile;
  const bound = compose.services.worker.environment.MALLOC_ARENA_MAX;
  if (bound === undefined || bound === null) throw new Error('docker-compose.yml sets no MALLOC_ARENA_MAX for the worker');
  return String(bound);
}

export const SERVICE_MALLOC_ARENA_MAX = serviceMallocArenaMax();
