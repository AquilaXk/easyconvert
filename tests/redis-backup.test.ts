import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The Redis backup of the production host: deploy/oci/redis-backup.sh, its systemd units and the runbook that installs them. The
 * expectations are written out from the Redis 7.4 persistence documentation (BGSAVE writes a point-in-time dump.rdb by a rename; INFO
 * persistence reports rdb_saves, rdb_bgsave_in_progress and rdb_last_bgsave_status; an RDB file starts with REDIS) and from the privacy
 * policy (an account is deleted within 10 days of the request), not from the code that was written. The script runs for real against a
 * stand-in for `docker` that answers the few commands it sends to the Redis container and records every argument.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf-8');
const SCRIPT = path.join(ROOT, 'deploy', 'oci', 'redis-backup.sh');
const PASSWORD = 'f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b';
const RDB = Buffer.concat([Buffer.from('REDIS0012'), Buffer.from('fa09726564697332', 'hex'), Buffer.alloc(300, 7)]);
const POLICY_DELETION_DAYS = 10;
const DAY_MS = 86_400_000;
const hasFlock = spawnSync('flock', ['--version']).status === 0;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

describe('redis-backup.sh against a stand-in for docker', { timeout: 30_000 }, () => {
  const sandboxes: string[] = [];
  let sandbox: string;
  let home: string;
  let bin: string;
  let backups: string;
  let log: string;
  let state: string;
  let rdbFile: string;

  const stub = (name: string, body: string): void => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  };

  const seed = (name: string, ageDays: number, body: Buffer = RDB): string => {
    const file = path.join(backups, name);
    writeFileSync(file, body, { mode: 0o600 });
    writeFileSync(`${file}.sha256`, `${sha256(body)}  ${name}\n`, { mode: 0o600 });
    const when = new Date(Date.now() - ageDays * DAY_MS);
    utimesSync(file, when, when);
    return file;
  };

  const run = (args: string[] = [], env: Record<string, string> = {}) => {
    const result = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf-8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? '',
        EASYCONVERT_HOME: home,
        BACKUP_DIR: backups,
        BACKUP_MIN_FREE_MB: '0',
        BACKUP_POLL_SECONDS: '1',
        STUB_LOG: log,
        STUB_STATE: state,
        STUB_RDB: rdbFile,
        ...env,
      } as unknown as NodeJS.ProcessEnv,
      timeout: 25_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  const calls = (): string[] => readFileSync(log, 'utf-8').split('\n').filter(Boolean);
  const backupNames = (): string[] => readdirSync(backups).filter((name) => /^redis-\d{8}T\d{6}Z\.rdb$/.test(name)).sort();
  const leftovers = (): string[] => readdirSync(backups).filter((name) => name.endsWith('.part'));

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'redis-backup-'));
    sandboxes.push(sandbox);
    home = path.join(sandbox, 'home');
    bin = path.join(sandbox, 'bin');
    backups = path.join(sandbox, 'backups');
    log = path.join(sandbox, 'calls.log');
    state = path.join(sandbox, 'state');
    rdbFile = path.join(sandbox, 'dump.rdb');
    mkdirSync(path.join(home, 'current'), { recursive: true });
    mkdirSync(bin);
    mkdirSync(backups, { mode: 0o700 });
    mkdirSync(state);
    writeFileSync(path.join(home, 'current', '.env'), `APP_URL=https://convert.example.test\nREDIS_PASSWORD=${PASSWORD}\n`);
    writeFileSync(log, '');
    stub('flock', 'echo "flock $*" >> "$STUB_LOG"; [ -z "$STUB_LOCK_BUSY" ]');
    writeFileSync(rdbFile, RDB);
    writeFileSync(path.join(state, 'saves'), '41');
    writeFileSync(path.join(state, 'pending'), '0');
    // `docker compose ... exec -T redis <command>` is the only form the script uses besides `ps -q redis`. The stand-in keeps the
    // counter of finished saves in $STUB_STATE: BGSAVE starts a save that INFO reports as running for STUB_POLLS answers.
    stub(
      'docker',
      `echo "docker $*" >> "$STUB_LOG"
args=("$@")
for i in "\${!args[@]}"; do [ "\${args[$i]}" = "exec" ] && exec_at=$i; [ "\${args[$i]}" = "ps" ] && ps_at=$i; done
if [ -n "\${ps_at:-}" ]; then [ -n "\${STUB_NO_REDIS:-}" ] || echo "c0ffee"; exit 0; fi
rest=("\${args[@]:$((exec_at + 3))}")
saves() { cat "$STUB_STATE/saves"; }
case "\${rest[0]}" in
  sh)
    # sh -c <script> redis-cli <redis-cli arguments>
    echo "script: \${rest[2]}" >> "$STUB_LOG"
    case "\${rest[4]}" in
      INFO)
        pending="$(cat "$STUB_STATE/pending")"
        if [ "$pending" -gt 0 ]; then
          [ -n "\${STUB_NEVER_FINISH:-}" ] || { pending=$((pending - 1)); echo "$pending" > "$STUB_STATE/pending"; [ "$pending" -eq 0 ] && echo $(($(saves) + 1)) > "$STUB_STATE/saves"; }
        fi
        printf '# Persistence\\r\\nloading:0\\r\\nrdb_bgsave_in_progress:%s\\r\\nrdb_saves:%s\\r\\nrdb_last_bgsave_status:%s\\r\\naof_enabled:1\\r\\n' \\
          "$([ "$(cat "$STUB_STATE/pending")" -gt 0 ] && echo 1 || echo 0)" "$(saves)" "\${STUB_BGSAVE_STATUS:-ok}" ;;
      BGSAVE)
        reply="\${STUB_BGSAVE_REPLY:-Background saving started}"
        case "$reply" in "Background saving"*) echo "\${STUB_POLLS:-2}" > "$STUB_STATE/pending" ;; esac
        printf '%s\\r\\n' "$reply" ;;
    esac ;;
  redis-check-rdb)
    [ -n "\${STUB_CHECK_FAIL:-}" ] && { echo "Wrong signature trying to load DB from file" >&2; exit 1; }
    echo "RDB looks OK!" ;;
  sha256sum)
    printf '%s  %s\\n' "$( (sha256sum "$STUB_RDB" 2>/dev/null || shasum -a 256 "$STUB_RDB") | cut -d' ' -f1)" "\${rest[1]}" ;;
  cat)
    if [ -n "\${STUB_EMPTY_COPY:-}" ]; then exit 0; fi
    if [ -n "\${STUB_CORRUPT_COPY:-}" ]; then (cat "$STUB_RDB"; printf 'x') ; exit 0; fi
    if [ -n "\${STUB_NO_MAGIC:-}" ]; then printf 'NOPE!'; tail -c +6 "$STUB_RDB"; exit 0; fi
    cat "$STUB_RDB" ;;
esac`
    );
  });

  afterAll(() => {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  });

  it('writes a timestamped copy of the dump with a checksum file that sha256sum reads, in a private directory', () => {
    const result = run();

    expect(result.status, result.stderr).toBe(0);
    const names = backupNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^redis-\d{8}T\d{6}Z\.rdb$/);
    const file = path.join(backups, names[0]);
    expect(readFileSync(file).equals(RDB)).toBe(true);
    expect(readFileSync(`${file}.sha256`, 'utf-8')).toBe(`${sha256(RDB)}  ${names[0]}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(`${file}.sha256`).mode & 0o777).toBe(0o600);
    expect(statSync(backups).mode & 0o777).toBe(0o700);
    expect(result.stdout.trim()).toBe(file);
    expect(leftovers()).toEqual([]);
  });

  it('asks the container to save, waits until the save has finished, checks the file and only then copies it', () => {
    const result = run([], { STUB_POLLS: '3' });

    expect(result.status, result.stderr).toBe(0);
    const sequence = calls().filter((line) => line.startsWith('docker')).map((line) => {
      if (line.includes('BGSAVE')) return 'BGSAVE';
      if (line.includes('INFO persistence')) return 'INFO';
      if (line.includes('redis-check-rdb')) return 'check';
      if (line.includes('sha256sum')) return 'sum';
      if (line.includes(' cat ')) return 'cat';
      return 'other';
    });
    const bgsave = sequence.indexOf('BGSAVE');
    expect(sequence.slice(0, 3)).toEqual(['other', 'INFO', 'BGSAVE']);
    expect(sequence.slice(bgsave + 1).filter((step) => step === 'INFO').length).toBeGreaterThanOrEqual(3);
    expect(sequence.slice(-3)).toEqual(['check', 'sum', 'cat']);
    expect(sequence.slice(bgsave + 1).indexOf('check')).toBeGreaterThan(sequence.slice(bgsave + 1).lastIndexOf('INFO'));
  });

  it('runs against the project, env file and compose file of the current release, with the redis profile, and never uses a terminal', () => {
    run();

    const exec = calls().find((line) => line.includes('BGSAVE')) ?? '';
    expect(exec).toContain('compose --project-name easyconvert');
    expect(exec).toContain(`--project-directory ${home}/current`);
    expect(exec).toContain(`--env-file ${home}/current/.env`);
    expect(exec).toContain(`-f ${home}/current/docker-compose.prod.yml`);
    expect(exec).toContain('--profile redis');
    expect(exec).toContain('exec -T redis');
  });

  it('never has the password on a command line or in an output: redis-cli reads it from the container', () => {
    const result = run();

    expect(result.status, result.stderr).toBe(0);
    const everything = [result.stdout, result.stderr, readFileSync(log, 'utf-8')].join('\n');
    expect(everything).not.toContain(PASSWORD);
    const script = calls().find((line) => line.startsWith('script:')) ?? '';
    expect(script).toContain('REDISCLI_AUTH="$REDIS_PASSWORD"');
    expect(calls().filter((line) => line.startsWith('docker')).some((line) => /\s-a\s|--pass/.test(line))).toBe(false);
  });

  it('keeps the newest BACKUP_KEEP backups and removes the older ones with their checksum files', () => {
    const base = Date.now() - 3 * DAY_MS;
    const seeded = Array.from({ length: 6 }, (_, index) => `redis-${stamp(new Date(base + index * 6 * 3_600_000))}.rdb`);
    seeded.forEach((name, index) => seed(name, 3 - index * 0.25));

    const result = run([], { BACKUP_KEEP: '4' });

    expect(result.status, result.stderr).toBe(0);
    const left = backupNames();
    expect(left).toHaveLength(4);
    expect(left.slice(0, 3)).toEqual(seeded.slice(-3));
    for (const name of seeded.slice(0, 3)) {
      expect(existsSync(path.join(backups, name))).toBe(false);
      expect(existsSync(path.join(backups, `${name}.sha256`))).toBe(false);
    }
    for (const name of left) expect(existsSync(path.join(backups, `${name}.sha256`))).toBe(true);
  });

  it('removes a backup older than BACKUP_MAX_AGE_DAYS and keeps one younger than it', () => {
    const old = `redis-${stamp(new Date(Date.now() - 8 * DAY_MS))}.rdb`;
    const young = `redis-${stamp(new Date(Date.now() - 6 * DAY_MS))}.rdb`;
    seed(old, 8);
    seed(young, 6);

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(backups, old))).toBe(false);
    expect(existsSync(path.join(backups, `${old}.sha256`))).toBe(false);
    expect(existsSync(path.join(backups, young))).toBe(true);
    expect(backupNames()).toHaveLength(2);
  });

  it('removes the expired copies even when the new backup cannot be taken, so a broken backup never keeps old accounts alive', () => {
    const old = `redis-${stamp(new Date(Date.now() - 9 * DAY_MS))}.rdb`;
    const young = `redis-${stamp(new Date(Date.now() - 2 * DAY_MS))}.rdb`;
    seed(old, 9);
    seed(young, 2);

    const result = run([], { STUB_CHECK_FAIL: '1' });

    expect(result.status).toBe(1);
    expect(existsSync(path.join(backups, old))).toBe(false);
    expect(existsSync(path.join(backups, young))).toBe(true);
  });

  it('prunes without touching Redis when asked only to prune, and never removes a file it did not name', () => {
    seed(`redis-${stamp(new Date(Date.now() - 9 * DAY_MS))}.rdb`, 9);
    for (const name of ['notes.txt', 'redis-latest.rdb', 'redis-20260101T000000Z.rdb.bak', 'dump.rdb']) {
      writeFileSync(path.join(backups, name), 'keep');
      const when = new Date(Date.now() - 30 * DAY_MS);
      utimesSync(path.join(backups, name), when, when);
    }
    const orphan = path.join(backups, 'redis-20200101T000000Z.rdb.sha256');
    writeFileSync(orphan, 'x');

    const result = run(['prune']);

    expect(result.status, result.stderr).toBe(0);
    expect(calls().filter((line) => line.startsWith('docker'))).toEqual([]);
    expect(backupNames()).toEqual([]);
    expect(existsSync(orphan)).toBe(false);
    for (const name of ['notes.txt', 'redis-latest.rdb', 'redis-20260101T000000Z.rdb.bak', 'dump.rdb']) expect(existsSync(path.join(backups, name)), name).toBe(true);
  });

  it.each([
    ['Redis refuses BGSAVE', { STUB_BGSAVE_REPLY: 'ERR Background save already failed' }, /BGSAVE was refused/],
    ['the save ends with an error', { STUB_BGSAVE_STATUS: 'err' }, /background save failed/],
    ['the save does not finish in time', { STUB_NEVER_FINISH: '1', BACKUP_WAIT_SECONDS: '1' }, /did not finish within 1 seconds/],
    ['redis-check-rdb rejects the file', { STUB_CHECK_FAIL: '1' }, /redis-check-rdb rejected/],
    ['the copy is empty', { STUB_EMPTY_COPY: '1' }, /copy is empty/],
    ['the copy is not an RDB', { STUB_NO_MAGIC: '1' }, /does not start with REDIS/],
    ['the copy differs from the file in the container', { STUB_CORRUPT_COPY: '1' }, /copy differs/],
    ['the volume has too little room', { BACKUP_MIN_FREE_MB: '999999999999' }, /MB free/],
    ['the redis container is not running', { STUB_NO_REDIS: '1' }, /redis container is not running/],
  ])('fails and leaves no backup file when %s', (_name, env, message) => {
    const result = run([], env);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(backupNames()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('refuses a stack that uses another Redis, and a missing release, before it sends anything to a container', () => {
    writeFileSync(path.join(home, 'current', '.env'), 'REDIS_URL=redis://other.example.test:6379\n');
    const external = run();
    expect(external.status).toBe(1);
    expect(external.stderr).toContain('another Redis');
    expect(calls().filter((line) => line.startsWith('docker'))).toEqual([]);

    rmSync(path.join(home, 'current', '.env'));
    const missing = run();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('no running release');
  });

  it('does not run a second backup while another run holds the lock, and asks for the lock on a file, not a directory', () => {
    const busy = run([], { STUB_LOCK_BUSY: '1' });

    expect(busy.status).toBe(1);
    expect(busy.stderr).toContain('another run holds');
    expect(calls().filter((line) => line.startsWith('docker'))).toEqual([]);
    expect(calls().filter((line) => line.startsWith('flock'))).toEqual(['flock -n 9']);
    expect(statSync(path.join(backups, '.lock')).isFile()).toBe(true);
  });

  // skip-ok: platform capability: flock(1) belongs to util-linux and is missing on macOS, where the real lock cannot be tested.
  it.skipIf(!hasFlock)('is blocked by a live holder of the lock file and not by the file left after the holder ended', async () => {
    unlinkSync(path.join(bin, 'flock'));
    const lock = path.join(backups, '.lock');
    const holder = spawn('flock', ['-n', lock, 'sleep', '30'], { stdio: 'ignore' });
    try {
      const deadline = Date.now() + 5_000;
      while (spawnSync('flock', ['-n', lock, 'true']).status === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const busy = run();
      expect(busy.status).toBe(1);
      expect(busy.stderr).toContain('another run holds');
      expect(backupNames()).toEqual([]);
    } finally {
      holder.kill('SIGKILL');
      await new Promise((resolve) => holder.on('exit', resolve));
    }
    expect(existsSync(lock)).toBe(true);
    const after = run();
    expect(after.status, after.stderr).toBe(0);
    expect(backupNames()).toHaveLength(1);
  });

  it('prunes the expired copies on a run after a killed one, because the lock file it left holds nothing', () => {
    writeFileSync(path.join(backups, '.lock'), '');
    const old = `redis-${stamp(new Date(Date.now() - 9 * DAY_MS))}.rdb`;
    seed(old, 9);

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(backups, old))).toBe(false);
    expect(backupNames()).toHaveLength(1);
  });

  it.each([
    ['BACKUP_KEEP', '0'],
    ['BACKUP_KEEP', 'many'],
    ['BACKUP_MAX_AGE_DAYS', '0'],
    ['BACKUP_MAX_AGE_DAYS', '-3'],
  ])('refuses %s=%s instead of pruning everything', (name, value) => {
    seed(`redis-${stamp(new Date(Date.now() - DAY_MS))}.rdb`, 1);

    const result = run([], { [name]: value });

    expect(result.status).toBe(1);
    expect(backupNames()).toHaveLength(1);
  });

  it('refuses an unknown action', () => {
    expect(run(['restore']).status).toBe(1);
  });
});

describe('the backup schedule and the retention promise', () => {
  const script = read('deploy/oci/redis-backup.sh');
  const timer = read('deploy/oci/easyconvert-redis-backup.timer');
  const service = read('deploy/oci/easyconvert-redis-backup.service');
  const doc = read('docs/operations/backup-and-restore.md');
  const policy = read('docs/policy-decisions.md');
  const defaultOf = (name: string): number => Number(new RegExp(`${name}="\\$\\{${name}:-(\\d+)\\}"`).exec(script)?.[1]);
  const ERASURE_TARGET_DAYS = 2;

  it('expires a copy early enough that an account deleted within the erasure target is gone from every backup within the 10 days the privacy policy promises', () => {
    const maxAge = defaultOf('BACKUP_MAX_AGE_DAYS');
    expect(maxAge).toBeGreaterThanOrEqual(1);
    expect(ERASURE_TARGET_DAYS + maxAge).toBeLessThan(POLICY_DELETION_DAYS);
    expect(doc).toContain(`${maxAge} days`);
    expect(doc).toMatch(new RegExp(`within ${ERASURE_TARGET_DAYS} days`));
    expect(read('docs/legal/privacy.en.md')).toContain('within 10 days');
  });

  it('puts the worst case of a copy that holds an erased account at about 9 days 6 hours, inside 10, in every place that says it', () => {
    const worstDays = ERASURE_TARGET_DAYS + defaultOf('BACKUP_MAX_AGE_DAYS') + 6 / 24 + 2 / 1440;
    expect(worstDays).toBeLessThan(POLICY_DELETION_DAYS);
    expect(timer).toContain('OnCalendar=*-*-* 00,06,12,18:17:00 UTC');
    expect(timer).toContain('RandomizedDelaySec=120');
    for (const [name, text] of [['backup-and-restore.md', doc], ['deploy-oci.md', read('docs/deploy-oci.md')], ['policy entry 186', policy.slice(policy.indexOf('## 186. '))]] as const) {
      expect(text, name).toContain('9 days 6 hours');
      expect(text, name).not.toMatch(/gone 9 days after|expired by day 9|day to spare/);
    }
  });

  it('re-erases by the time the erasure finished, not by the time of the request, in the restore, the deletion steps and the policy entry', () => {
    const deployDoc = read('docs/deploy-oci.md');
    const entry = policy.slice(policy.indexOf('## 186. '));
    const restoreStep = doc.split('\n').find((line) => line.startsWith('8. ')) ?? '';
    expect(restoreStep).toContain('erasure finished after');
    expect(restoreStep).toContain('every request still open now');
    expect(doc).toContain('Record when each erasure finished');
    expect(doc).toContain('with "deleted" in the subject');
    expect(deployDoc).toContain('erasure finished after the backup was taken, including a request that was still open then');
    expect(deployDoc).toContain('"deleted" in the subject');
    expect(entry).toContain('the time of the erasure decides, not the time of the request');
    for (const [name, text] of [['backup-and-restore.md', doc], ['deploy-oci.md', deployDoc], ['policy entry 186', entry]] as const) {
      expect(text, name).not.toMatch(/whose request is newer|every deletion request dated after|deletion request in `support@aquilaxk.site` dated after/);
    }
  });

  it('installs the timer only after QA settled the open privacy question, and checks the set-aside copy is deleted the same day', () => {
    expect(doc).toContain('install the timer only after QA has settled the privacy wording question recorded as "Open for QA"');
    expect(policy.slice(policy.indexOf('## 186. '))).toContain('the timer is installed only after QA settles it');
    const lines = doc.split('\n');
    const remove = lines.findIndex((line) => line.startsWith('9. '));
    expect(lines.slice(remove, remove + 8).join('\n')).toMatch(/Check that it is gone:.*must not list `pre-restore`/);
  });

  it('bounds both waits of the restore loader and prints its log when it fails', () => {
    const step5 = doc.slice(doc.indexOf('5. **Turn it into'), doc.indexOf('6. **Start the stack'));
    expect(step5.match(/\[ \$n -lt 600 \]/g)).toHaveLength(2);
    expect(step5).toContain('kill -0 $pid');
    expect(step5.match(/FAILED:/g)).toHaveLength(3);
    expect(step5).toContain('cat /tmp/loader.log');
  });

  it('keeps enough copies for the schedule over the whole age: one every 6 hours for 7 days is 28', () => {
    const perDay = 4;
    expect(timer).toContain('OnCalendar=*-*-* 00,06,12,18:17:00 UTC');
    expect(defaultOf('BACKUP_KEEP')).toBe(perDay * defaultOf('BACKUP_MAX_AGE_DAYS'));
    expect(timer).toContain('Persistent=true');
  });

  it('runs the installed script as the deploy user, from the directory the deploy copies its own script to, and the runbook installs exactly these files', () => {
    const keys = (text: string): Record<string, string> =>
      Object.fromEntries(text.split('\n').filter((line) => /^[A-Za-z]+=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    expect(keys(service)).toEqual({
      Description: 'EasyConvert Redis backup',
      After: 'docker.service',
      Requires: 'docker.service',
      Type: 'oneshot',
      User: 'easyconvert-deploy',
      Group: 'easyconvert-deploy',
      UMask: '0077',
      ExecStart: '/opt/easyconvert/bin/redis-backup.sh',
      TimeoutStartSec: '15min',
      Nice: '10',
      NoNewPrivileges: 'yes',
      PrivateTmp: 'yes',
      ProtectSystem: 'strict',
      ReadWritePaths: '/var/lib/easysubway-data/easyconvert/redis-backups',
    });
    const installSteps = doc
      .split('\n')
      .filter((line) => line.startsWith('sudo '))
      .map((line) => line.trim());
    expect(installSteps).toEqual([
      'sudo install -d -o easyconvert-deploy -g easyconvert-deploy -m 0700 /var/lib/easysubway-data/easyconvert/redis-backups',
      'sudo install -m 0755 deploy/oci/redis-backup.sh /opt/easyconvert/bin/redis-backup.sh',
      'sudo install -m 0644 deploy/oci/easyconvert-redis-backup.service deploy/oci/easyconvert-redis-backup.timer /etc/systemd/system/',
      'sudo systemctl daemon-reload',
      'sudo systemctl enable --now easyconvert-redis-backup.timer',
      'sudo -u easyconvert-deploy /opt/easyconvert/bin/redis-backup.sh',
    ]);
    expect(script).toContain(`BACKUP_DIR="\${BACKUP_DIR:-/var/lib/easysubway-data/easyconvert/redis-backups}"`);
  });

  it('is recorded as policy entry 186, which states the retention and the interaction with account deletion', () => {
    expect(policy).toMatch(/^## 186\. /m);
    expect(policy).toMatch(/^186\. \[/m);
    const entry = policy.slice(policy.indexOf('## 186. '));
    for (const text of ['7 days', 'every 6 hours', 'within 2 days', 'BGREWRITEAOF', 'redis-backup.sh']) expect(entry, text).toContain(text);
  });

  it('keeps no password in any file it adds', () => {
    for (const text of [script, timer, service, doc]) expect(text).not.toMatch(/(?:PASSWORD|SECRET|KEK|PEPPER)=[A-Za-z0-9+/]{12,}/);
  });
});
