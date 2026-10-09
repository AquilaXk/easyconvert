import fs from 'node:fs';
import path from 'node:path';
import { renderConfigurationDoc, renderEnvExample } from '../src/lib/config/render-docs';

/**
 * Writes docs/configuration.md and docs/configuration.example.env from the configuration schema (src/lib/config/schema.ts).
 * `--check` writes nothing and exits 1 when a committed file differs from what the schema renders.
 */

const ROOT_DIR = path.resolve(__dirname, '..');
const CHECK_FLAG = '--check';

const OUTPUTS: ReadonlyArray<{ file: string; render: () => string }> = [
  { file: path.join(ROOT_DIR, 'docs', 'configuration.md'), render: renderConfigurationDoc },
  { file: path.join(ROOT_DIR, 'docs', 'configuration.example.env'), render: renderEnvExample },
];

function main(): void {
  const check = process.argv.includes(CHECK_FLAG);
  let drifted = false;
  for (const { file, render } of OUTPUTS) {
    const expected = render();
    const relative = path.relative(ROOT_DIR, file);
    if (check) {
      const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
      if (actual !== expected) {
        console.error(`${relative} is out of date; run npm run config:docs`);
        drifted = true;
      }
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, expected, 'utf8');
    console.log(`wrote ${relative}`);
  }
  if (drifted) process.exitCode = 1;
}

main();
