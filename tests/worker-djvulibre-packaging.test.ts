import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DJVULIBRE_REQUIRED_PATCHES } from '../src/worker/djvu-render';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The worker image carries djvulibre built from the Debian source of the version the distribution ships, with two patches to libdjvu
 * (entry 135 of docs/policy-decisions.md). The image builds it in a stage of its own and copies the two programs the worker runs, with
 * their message catalog, the licence text, the note that names the source and the patches, into the runner; CI builds the same script.
 * The expectations are written out from the licence terms (the corresponding source and the patches ship with the binary), from the
 * engine patch rule (each patch pinned and applied with no fuzz, the build checked for what the patches change) and from the script's pins.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-djvulibre.sh'), 'utf-8');
const PATCH_DIR = path.join(ROOT, 'scripts', 'djvulibre-patches');
const ACTION_DIR = path.join(ROOT, '.github', 'actions', 'ci-setup');
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'djvulibre');
const runner = stages[stages.length - 1];
const runnerInstructions = (keyword: string) => runner.instructions.filter((instruction) => instruction.keyword === keyword).map((instruction) => instruction.argument);
const readPatch = (name: string) => fs.readFileSync(path.join(PATCH_DIR, name), 'utf-8');

describe('the djvulibre stage of the worker image', () => {
  it('builds on the same base as the runner and runs the install script with the distribution program as the reference of its pixels', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(runner.baseImage);
    const run = stage?.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument) ?? [];
    for (const pkg of ['build-essential', 'patch', 'autoconf', 'automake', 'libtool', 'libjpeg-dev', 'libtiff-dev', 'djvulibre-bin', 'poppler-utils']) {
      expect(run.some((argument) => new RegExp(`\\b${pkg}\\b`).test(argument)), pkg).toBe(true);
    }
    expect(run).toContain('DJVULIBRE_REFERENCE_DDJVU=/usr/bin/ddjvu /tmp/install-djvulibre.sh /opt/djvulibre');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toEqual(['scripts/install-djvulibre.sh /tmp/install-djvulibre.sh', 'scripts/djvulibre-patches /tmp/djvulibre-patches']);
  });

  it('leaves the distribution package out of the runner, copies the build and its notes, and fails unless the two programs load and draw a page', () => {
    const install = runnerInstructions('RUN').find((argument) => argument.includes('apt-get install'));
    expect(install).toBeDefined();
    expect(install).not.toMatch(/\bdjvulibre-bin\b/);
    expect(runnerInstructions('COPY').filter((argument) => argument.includes('djvulibre'))).toEqual([
      '--from=djvulibre /opt/djvulibre /opt/djvulibre',
      '--from=djvulibre /opt/djvulibre/share/doc/djvulibre /usr/share/doc/djvulibre',
    ]);
    const check = runnerInstructions('RUN').find((argument) => argument.includes('/usr/local/bin/ddjvu')) ?? '';
    for (const step of [
      'ln -s /opt/djvulibre/bin/ddjvu /usr/local/bin/ddjvu',
      'ln -s /opt/djvulibre/bin/djvused /usr/local/bin/djvused',
      "! ldd /opt/djvulibre/bin/ddjvu /opt/djvulibre/bin/djvused | grep -q 'not found'",
      'test ! -e /usr/bin/ddjvu',
      '[ "$(djvused -e n "$dir/page.djvu")" = "1" ]',
      '[ "$(djvused -e size "$dir/page.djvu")" = "width=8 height=8" ]',
      'ddjvu -format=pdf "$dir/page.djvu" "$dir/page.pdf"',
    ]) {
      expect(check, step).toContain(step);
    }
    expect(runnerInstructions('RUN')).toContain('cp /usr/share/doc/djvulibre/SOURCE /licenses/djvulibre.SOURCE');
    expect(runnerInstructions('RUN').some((argument) => argument.includes('cat /usr/share/doc/djvulibre/tool-version.txt') && argument.includes('/licenses/tool-versions.txt'))).toBe(true);
  });

  it('is installed before the privileges are dropped, so that the unprivileged account only runs it', () => {
    const copy = runner.instructions.find((instruction) => instruction.argument.startsWith('--from=djvulibre'));
    const user = runner.instructions.find((instruction) => instruction.keyword === 'USER');
    expect((copy?.index ?? Infinity) < (user?.index ?? -Infinity)).toBe(true);
  });
});

describe('the install script of djvulibre', () => {
  it('downloads the Debian source package from a fixed snapshot of the archive over HTTPS and checks the SHA-256 of both archives before unpacking them', () => {
    expect(INSTALL).toMatch(/^DJVULIBRE_VERSION="3\.5\.28"$/m);
    expect(INSTALL).toMatch(/^DJVULIBRE_DEBIAN_REVISION="2\.2"$/m);
    expect(INSTALL).toMatch(/^DJVULIBRE_ORIG_SHA256="[0-9a-f]{64}"$/m);
    expect(INSTALL).toMatch(/^DJVULIBRE_DEBIAN_SHA256="[0-9a-f]{64}"$/m);
    expect(INSTALL).toMatch(/^DJVULIBRE_SNAPSHOT="https:\/\/snapshot\.debian\.org\/archive\/debian\/\d{8}T\d{6}Z\/pool\/main\/d\/djvulibre"$/m);
    expect(INSTALL).not.toContain('https://deb.debian.org');
    expect(INSTALL).toContain("--proto '=https'");
    const check = INSTALL.indexOf('sha256sum --check --strict -');
    expect(check).toBeGreaterThan(0);
    expect(INSTALL.indexOf('tar -xJf')).toBeGreaterThan(check);
  });

  it('needs the distribution program as its reference, of the version it builds, and of the pinned revision on Debian, before it downloads anything', () => {
    expect(INSTALL).toContain('REFERENCE_DDJVU="${DJVULIBRE_REFERENCE_DDJVU:?');
    expect(INSTALL).toContain('reference_version="$(dpkg-query -W -f=\'${Version}\' "$reference_package")"');
    expect(INSTALL).toContain('"${DJVULIBRE_VERSION}-"*) ;;');
    expect(INSTALL).toContain('[ "$reference_version" != "${DJVULIBRE_VERSION}-${DJVULIBRE_DEBIAN_REVISION}" ]');
    expect(INSTALL.indexOf('reference_version=')).toBeLessThan(INSTALL.indexOf('curl '));
  });

  it('applies the Debian series and then only the patch files it names, each checked against its SHA-256, with no fuzz, before the configure', () => {
    const named = [...INSTALL.matchAll(/^ {2}"([\w.-]+\.patch) ([0-9a-f]{64})"$/gm)].map((match) => ({ name: match[1], sha256: match[2] }));
    expect(named.map((entry) => entry.name).sort()).toEqual(fs.readdirSync(PATCH_DIR).sort());
    expect(named.length).toBe(2);
    for (const { name, sha256 } of named) expect(createHash('sha256').update(fs.readFileSync(path.join(PATCH_DIR, name))).digest('hex'), name).toBe(sha256);
    const debian = INSTALL.indexOf('patch -p1 --batch --forward --fuzz=0 --no-backup-if-mismatch --silent --input="debian/patches/${debian_patch}"');
    const ours = INSTALL.indexOf('patch -p1 --batch --forward --fuzz=0 --no-backup-if-mismatch --input="${patch_dir}/${patch_name}"');
    expect(debian).toBeGreaterThan(INSTALL.lastIndexOf('tar -xJf'));
    expect(ours).toBeGreaterThan(debian);
    expect(INSTALL.indexOf('sha256sum --check --strict -', INSTALL.indexOf('for entry in "${DJVULIBRE_PATCHES[@]}"'))).toBeLessThan(ours);
    expect(ours).toBeLessThan(INSTALL.indexOf('./configure'));
    expect(INSTALL).not.toMatch(/\bgit apply\b|\bsed -i\b/);
  });

  it('keeps each patch to its one change: the search of the included files, and the thread that does not start', () => {
    const search = readPatch('include-search-visit-once.patch');
    expect([...search.matchAll(/^--- (\S+)$/gm)].map((match) => match[1])).toEqual(['a/libdjvu/DjVuFile.h', 'a/libdjvu/DjVuFile.cpp', 'a/libdjvu/DjVuImage.cpp']);
    expect(search).toContain('+find_component(const GP<DjVuFile> & file, GP<TYPE> DjVuFile::* component,');
    expect(search).toContain('+   if (map.contains(url))');
    for (const getter of ['info', 'bg44', 'bgpm', 'fgjb', 'fgpm', 'fgbc']) expect(search, getter).toContain(`find_component(file, &DjVuFile::${getter}, map)`);
    expect(search).toContain('+DjVuFile::get_fgjd(int block, GMap<GURL, void *> & map)');
    expect(search).toContain('+        GP<JB2Dict> fgjd = file->get_fgjd(0, map);');
    for (const walk of ['get_merged_anno()', 'compute_closure()', 'stop_decode() and stop()', 'DjVuDocEditor']) expect(search, walk).toContain(walk);
    const thread = readPatch('decode-thread-start-failure.patch');
    expect([...thread.matchAll(/^--- (\S+)$/gm)].map((match) => match[1])).toEqual(['a/libdjvu/DjVuFile.cpp']);
    expect(thread).toContain('+      if (decode_thread->create(static_decode_func, this))');
    expect(thread).toContain('+        decode_thread=0;');
    expect(thread).toContain('+        G_THROW( ERR_MSG("DjVuFile.decode_fail") );');
    for (const site of ['DjVuDocument.cpp line 208', 'ddjvuapi.cpp line\n2695']) expect(thread, site).toContain(site);
  });

  it('names in the worker every patch it installs as the stamp of the build', () => {
    const named = [...INSTALL.matchAll(/^ {2}"([\w.-]+\.patch) [0-9a-f]{64}"$/gm)].map((match) => match[1]);
    expect([...DJVULIBRE_REQUIRED_PATCHES]).toEqual(named);
  });

  it('builds with the flags of the Debian package and fails the build when a program lacks a hardening property', () => {
    expect(INSTALL).toContain('export DEB_BUILD_MAINT_OPTIONS=hardening=+all');
    expect(INSTALL).toContain('eval "$(dpkg-buildflags --export=sh)"');
    expect(INSTALL).toContain('--disable-shared --enable-static');
    const build = INSTALL.indexOf('make -j"$jobs"');
    for (const check of ['readelf -h "$tools/$program"', "'Type:[[:space:]]*DYN'", 'GNU_RELRO', 'BIND_NOW']) expect(INSTALL.indexOf(check), check).toBeGreaterThan(build);
  });

  it('fails the build unless a page is drawn, every chain ends with the status only the patches give, the reference still searches, and the pixels hold', () => {
    expect(INSTALL).toMatch(/^CHAIN_LEVELS=40$/m);
    expect(INSTALL).toMatch(/^MASK_CHAIN_LEVELS="40 60"$/m);
    expect(INSTALL).toMatch(/^THREAD_CHAIN_LEVELS=100$/m);
    expect(INSTALL).toMatch(/^THREAD_STACK_KIB=8192$/m);
    expect(INSTALL).toMatch(/^DDJVU_FAILED=10$/m);
    expect(INSTALL).toMatch(/^TIMED_OUT=124$/m);
    expect(INSTALL).toContain('write_chain "$check_dir/fan-out" "$CHAIN_LEVELS" 2 "$check_dir/info"');
    expect(INSTALL).toContain('write_chain "$check_dir/mask$levels" "$levels" 2 "$check_dir/mask/info" "$check_dir/mask/sjbz"');
    expect(INSTALL).toContain('write_chain "$check_dir/dictionary" "$last_levels" 2 "$check_dir/mask/info" "$check_dir/mask/sjbz" "$check_dir/mask/djbz"');
    expect(INSTALL).toContain('write_chain "$check_dir/deep" "$THREAD_CHAIN_LEVELS" 1 "$check_dir/info"');
    expect(INSTALL).toContain('[ "$status" -eq "$DDJVU_FAILED" ] || { echo "ddjvu ended with status $status on a mask over $levels shared files without its dictionary: the search patch is not in the build"');
    expect(INSTALL).toContain('[ "$status" -eq "$DDJVU_FAILED" ] || { echo "ddjvu ended with status $status on a chain whose threads cannot all start: the thread patch is not in the build"');
    expect(INSTALL.match(/\[ "\$status" -eq "\$TIMED_OUT" \]/g)).toHaveLength(2);
    expect(INSTALL).toContain('status="$(ulimit -s "$THREAD_STACK_KIB" && status_of timeout --signal=KILL');
    expect(INSTALL).toContain('same_pixels "$check_dir/dictionary/chain.pdf" "$check_dir/dictionary/reference.pdf" 1');
    expect(INSTALL).toContain('same_pixels "$check_dir/patched.pdf" "$check_dir/reference.pdf" "$("$tools/djvused" -e n "$manual")"');
    expect(INSTALL).not.toMatch(/\|\| \{ echo "ddjvu did not draw/);
    const install = INSTALL.indexOf('install -m 0755 --strip');
    for (const gate of ['"$tools/cjb2"', 'write_chain "$check_dir/fan-out"', 'write_chain "$check_dir/mask$levels"', 'write_chain "$check_dir/dictionary"', 'write_chain "$check_dir/deep"', 'same_pixels "$check_dir/patched.pdf"']) {
      expect(INSTALL.indexOf(gate), gate).toBeLessThan(install);
    }
  });

  it('installs only the two programs the worker runs, their message catalog, the licence text, and a note naming the source and the patches, which ship beside it', () => {
    expect(INSTALL).toMatch(/^PROGRAMS="ddjvu djvused"$/m);
    expect(INSTALL).toContain('rm -rf "$doc_dir/patches" "$INSTALL_DIR/share/djvu"');
    expect(INSTALL).toContain('cp -a "$work/stage$INSTALL_DIR/share/djvu/." "$INSTALL_DIR/share/djvu/"');
    expect(INSTALL).toContain('install -m 0644 debian/copyright "$doc_dir/copyright"');
    expect(INSTALL).toContain('install -m 0644 "${patch_dir}/${patch_name}" "$doc_dir/patches/${patch_name}"');
    expect(INSTALL).toContain('} > "$doc_dir/SOURCE"');
    expect(INSTALL).toContain('} > "$doc_dir/tool-version.txt"');
    expect(INSTALL).toContain('dpkg-query -W -f=\'djvulibre built with ${binary:Package} ${Version}\\n\' "${BUILD_PACKAGES[@]}"');
    expect(INSTALL).toContain("printf 'djvulibre checked against %s %s\\n' \"$reference_package\" \"$reference_version\"");
  });
});

describe('the djvulibre of CI', () => {
  it('is built by the same script in a task of its own after the packages it links, checked against the distribution program, and cached by the image, the script and the patches', () => {
    const tools = fs.readFileSync(path.join(ACTION_DIR, 'install-tools.sh'), 'utf-8');
    const task = tools.slice(tools.indexOf('task_djvulibre() {'), tools.indexOf('task_verapdf() {'));
    const apt = tools.slice(tools.indexOf('task_apt() {'));
    expect(apt.slice(0, apt.indexOf('\n}\n'))).not.toContain('djvulibre');
    expect(tools).toContain('run_dependent_tasks() {\n  tasks=(djvulibre)\n  run_tasks\n}');
    expect(task).toContain('sudo env DJVULIBRE_REFERENCE_DDJVU=/usr/bin/ddjvu "$action_path/../../../scripts/install-djvulibre.sh" "$djvulibre_dir"');
    expect(task).toContain('sha256sum --check --strict --status "$digest_file"');
    const packages = fs.readFileSync(path.join(ACTION_DIR, 'apt-packages.txt'), 'utf-8').split('\n');
    for (const pkg of ['djvulibre-bin', 'autoconf', 'automake', 'libtool', 'libjpeg-dev', 'libtiff-dev', 'poppler-utils']) expect(packages, pkg).toContain(pkg);
    const action = fs.readFileSync(path.join(ACTION_DIR, 'action.yml'), 'utf-8');
    expect(action).toContain("key: djvulibre-${{ runner.os }}-${{ runner.arch }}-${{ steps.image.outputs.version }}-${{ hashFiles('scripts/install-djvulibre.sh', 'scripts/djvulibre-patches/*') }}");
    expect(action).toContain('DJVULIBRE_CACHE_HIT: ${{ steps.djvulibre-cache.outputs.cache-hit }}');
  });
});
