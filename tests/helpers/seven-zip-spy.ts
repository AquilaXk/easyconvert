import fs from 'node:fs';
import path from 'node:path';
import { getOracleToolPath } from './differential-oracle';
import { processesWithArgument } from './process-state';

/**
 * A stand-in 7-Zip that records every call it receives and then runs the real one with the same arguments, so what a
 * conversion asks 7-Zip to do is read from outside the code under test. The shell stays the parent of the real
 * process (no `exec`): when the engine kills the process group on a limit, the wrapper dies with it and the
 * "finished" line is never written, which is how a test tells a run that was cut short from one that completed.
 */
export interface SevenZipSpy {
  /** Every call so far, as its argument list. */
  calls(): string[][];
  /** Calls whose real 7-Zip process ran to its end (exit status written). */
  completedCalls(): number;
  /** The exit status of every call whose real 7-Zip process returned to the wrapper, in the order they ended. */
  exitStatuses(): number[];
  /**
   * The wrapper shells that are still running, found by the path of the wrapper script in their command line: the id a wrapper reads for
   * itself (`$$`) is an id of the PID namespace the sandbox puts it in, which the host knows as another process.
   */
  runningWrappers(): number[];
  /**
   * Shell commands the wrapper runs just before the real 7-Zip starts, on every call until `reset`. A test uses them
   * to change a file between the moment the code under test read it and the moment 7-Zip opens it.
   */
  beforeRealRun(shellCommands: string): void;
  reset(): void;
  /** Points the worker engines at the wrapper until `restore`. */
  install(): void;
  restore(): void;
}

const ARGUMENT_SEPARATOR = '--end-of-call--';

export function createSevenZipSpy(workDir: string): SevenZipSpy {
  const real = getOracleToolPath('7z');
  if (real === null) throw new Error('7z is required');
  const callLog = path.join(workDir, 'spy-calls.log');
  const doneLog = path.join(workDir, 'spy-done.log');
  const script = path.join(workDir, 'spy-7z.sh');
  const hookFile = path.join(workDir, 'spy-before-run.sh');
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `{ for a in "$@"; do printf '%s\\n' "$a"; done; echo '${ARGUMENT_SEPARATOR}'; } >> '${callLog}'`,
      `[ -f '${hookFile}' ] && sh '${hookFile}'`,
      `'${real}' "$@"`,
      'status=$?',
      `echo "$status" >> '${doneLog}'`,
      'exit $status',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  let previous: string | undefined;
  let previousConfinement: string | undefined;
  return {
    calls() {
      if (!fs.existsSync(callLog)) return [];
      const lines = fs.readFileSync(callLog, 'utf8').split('\n');
      const calls: string[][] = [];
      let current: string[] = [];
      for (const line of lines.slice(0, -1)) {
        if (line === ARGUMENT_SEPARATOR) {
          calls.push(current);
          current = [];
        } else {
          current.push(line);
        }
      }
      return calls;
    },
    runningWrappers() {
      return processesWithArgument(script);
    },
    completedCalls() {
      return fs.existsSync(doneLog) ? fs.readFileSync(doneLog, 'utf8').split('\n').filter((line) => line !== '').length : 0;
    },
    exitStatuses() {
      return fs.existsSync(doneLog) ? fs.readFileSync(doneLog, 'utf8').split('\n').filter((line) => line !== '').map(Number) : [];
    },
    beforeRealRun(shellCommands) {
      fs.writeFileSync(hookFile, `${shellCommands}\n`);
    },
    reset() {
      fs.rmSync(hookFile, { force: true });
      fs.rmSync(callLog, { force: true });
      fs.rmSync(doneLog, { force: true });
    },
    install() {
      previous = process.env.P7ZIP_PATH;
      previousConfinement = process.env.SANDBOX_CONFINE_FILES;
      process.env.P7ZIP_PATH = script;
      // The wrapper appends to logs outside the job directory of the run, which the file confinement refuses (policy 247).
      process.env.SANDBOX_CONFINE_FILES = 'false';
    },
    restore() {
      if (previous === undefined) delete process.env.P7ZIP_PATH;
      else process.env.P7ZIP_PATH = previous;
      if (previousConfinement === undefined) delete process.env.SANDBOX_CONFINE_FILES;
      else process.env.SANDBOX_CONFINE_FILES = previousConfinement;
    },
  };
}
