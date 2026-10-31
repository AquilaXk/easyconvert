import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The worker image carries a pinned FFmpeg release built from source, not the distribution package: Debian 13 ships FFmpeg 7.1,
 * which decodes only the packets of an xHE-AAC stream whose coding tools it implements. The expectations are written out from the
 * licence terms (GPL only as a separate program, nothing nonfree, the corresponding source nameable, the licence text shipped),
 * from the hardening the other pinned programs get, and from the codecs the conversions name.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL_PATH = path.join(ROOT, 'scripts', 'install-ffmpeg.sh');
const INSTALL = fs.readFileSync(INSTALL_PATH, 'utf-8');
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'ffmpeg');
const runner = stages[stages.length - 1];
const instructions = (from: typeof runner | undefined, keyword: string): string[] => (from?.instructions ?? []).filter((instruction) => instruction.keyword === keyword).map((instruction) => instruction.argument);
const aptInstall = (from: typeof runner | undefined): string => instructions(from, 'RUN').find((argument) => /apt-get install/.test(argument)) ?? '';

/** The development package the build links and the runtime package that holds the library it loads. */
const CODEC_LIBRARIES: ReadonlyArray<{ dev: string; runtime: string; flag: string }> = [
  { dev: 'libx264-dev', runtime: 'libx264-164', flag: '--enable-libx264' },
  { dev: 'libx265-dev', runtime: 'libx265-215', flag: '--enable-libx265' },
  { dev: 'libvpx-dev', runtime: 'libvpx9', flag: '--enable-libvpx' },
  { dev: 'libsvtav1enc-dev', runtime: 'libsvtav1enc2', flag: '--enable-libsvtav1' },
  { dev: 'libdav1d-dev', runtime: 'libdav1d7', flag: '--enable-libdav1d' },
  { dev: 'libopus-dev', runtime: 'libopus0', flag: '--enable-libopus' },
  { dev: 'libmp3lame-dev', runtime: 'libmp3lame0', flag: '--enable-libmp3lame' },
  { dev: 'libvorbis-dev', runtime: 'libvorbisenc2', flag: '--enable-libvorbis' },
  { dev: 'libtheora-dev', runtime: 'libtheoraenc1', flag: '--enable-libtheora' },
  { dev: 'libwebp-dev', runtime: 'libwebp7', flag: '--enable-libwebp' },
  { dev: 'libsoxr-dev', runtime: 'libsoxr0', flag: '--enable-libsoxr' },
  { dev: 'libzimg-dev', runtime: 'libzimg2', flag: '--enable-libzimg' },
  { dev: 'libass-dev', runtime: 'libass9', flag: '--enable-libass' },
  { dev: 'libva-dev', runtime: 'libva-drm2', flag: '--enable-vaapi' },
  { dev: 'libdrm-dev', runtime: 'libdrm2', flag: '--enable-libdrm' },
];

describe('the ffmpeg stage of the worker image', () => {
  it('exists, builds on the same base as the runner and runs the pinned install script into /opt/ffmpeg', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(runner.baseImage);
    expect(instructions(stage, 'RUN')).toContain('/tmp/install-ffmpeg.sh /opt/ffmpeg');
    expect(instructions(stage, 'COPY')).toContain('scripts/install-ffmpeg.sh /tmp/install-ffmpeg.sh');
  });

  it('copies the patch directory next to the install script, which looks for it beside itself', () => {
    expect(instructions(stage, 'COPY')).toEqual(['scripts/install-ffmpeg.sh /tmp/install-ffmpeg.sh', 'scripts/ffmpeg-patches /tmp/ffmpeg-patches']);
    expect(INSTALL.match(/^patch_dir="(.*)"$/m)?.[1]).toBe('$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ffmpeg-patches');
  });

  it('installs the compiler, the assembler and the development package of every library the build links', () => {
    const install = aptInstall(stage);
    for (const tool of ['build-essential', 'patch', 'nasm', 'pkg-config', 'curl', 'xz-utils']) expect(install, tool).toMatch(new RegExp(`\\b${tool}\\b`));
    for (const { dev } of CODEC_LIBRARIES) expect(install, dev).toMatch(new RegExp(`\\b${dev}\\b`));
    expect(install).toMatch(/\blibffmpeg-nvenc-dev\b/);
  });
});

describe('the runner of the worker image', () => {
  it('installs the runtime library of every codec the build links, and not the distribution ffmpeg package', () => {
    const install = aptInstall(runner);
    for (const { runtime } of CODEC_LIBRARIES) expect(install, runtime).toMatch(new RegExp(`(^|\\s)${runtime}(\\s|$)`));
    expect(install).not.toMatch(/(^|\s)ffmpeg(\s|$)/);
    expect(install).not.toMatch(/\blibavcodec/);
  });

  it('records the FFmpeg version and source digest in the tool-versions manifest from the install script, not from a second copy', () => {
    const manifest = instructions(runner, 'RUN').find((argument) => argument.includes('/licenses/tool-versions.txt')) ?? '';
    expect(manifest).toMatch(/; cat \/usr\/share\/doc\/ffmpeg\/tool-version\.txt; \} > \/licenses\/tool-versions\.txt$/);
    const line = INSTALL.match(/printf '([^']*)\\n' "\$FFMPEG_VERSION" "\$FFMPEG_SHA256" > "\$INSTALL_DIR\/share\/doc\/ffmpeg\/tool-version\.txt"/);
    expect(line?.[1]).toBe('ffmpeg %s (source, sha256 %s)');
  });

  it('copies the build, the licence text and the source note, finds the programs where the worker looks, and fails the build when they cannot start', () => {
    expect(instructions(runner, 'COPY').filter((argument) => argument.includes('--from=ffmpeg'))).toEqual([
      '--from=ffmpeg /opt/ffmpeg /opt/ffmpeg',
      '--from=ffmpeg /opt/ffmpeg/share/doc/ffmpeg /usr/share/doc/ffmpeg',
    ]);
    const check = instructions(runner, 'RUN').find((argument) => argument.includes('/usr/local/bin/ffmpeg')) ?? '';
    expect(check).toContain('ln -s /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg');
    expect(check).toContain('ln -s /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe');
    expect(check).toContain("! ldd /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /opt/ffmpeg/lib/*.so.* | grep -q 'not found'");
    expect(check, '/usr/bin comes first in the worker search order, so a package copy would shadow the build').toContain('test ! -e /usr/bin/ffmpeg');
    expect(check, 'the same holds for ffprobe, which the worker also looks for in /usr/bin first').toContain('test ! -e /usr/bin/ffprobe');
    expect(check).toContain('ffmpeg -version');
    expect(instructions(runner, 'RUN')).toContain('cp /usr/share/doc/ffmpeg/SOURCE /licenses/ffmpeg.SOURCE');
  });

  it('is installed before the privileges are dropped, so that the unprivileged account only runs it', () => {
    const copy = runner.instructions.find((instruction) => instruction.argument.includes('--from=ffmpeg /opt/ffmpeg /opt/ffmpeg'));
    const user = runner.instructions.find((instruction) => instruction.keyword === 'USER');
    expect(copy).toBeDefined();
    expect(user).toBeDefined();
    expect((copy?.index ?? Infinity) < (user?.index ?? -Infinity)).toBe(true);
  });
});

describe('the install script of FFmpeg', () => {
  it('is valid shell', () => {
    const run = spawnSync('bash', ['-n', INSTALL_PATH], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });

  it('downloads one release archive over HTTPS and checks its SHA-256 before unpacking it', () => {
    expect(INSTALL).toMatch(/^FFMPEG_VERSION="9\.\d+\.\d+"$/m);
    expect(INSTALL).toMatch(/^FFMPEG_SHA256="[0-9a-f]{64}"$/m);
    expect(INSTALL).toMatch(/^FFMPEG_URL="https:\/\/ffmpeg\.org\/releases\/ffmpeg-\$\{FFMPEG_VERSION\}\.tar\.xz"$/m);
    const check = INSTALL.indexOf('sha256sum --check --strict');
    const unpack = INSTALL.indexOf('tar -xJf');
    expect(check).toBeGreaterThan(0);
    expect(unpack).toBeGreaterThan(check);
    expect(INSTALL).not.toMatch(/\bgit apply\b|\bsed -i\b/);
  });

  it('applies only the patch files it names, each checked against its SHA-256 before it is applied, with no fuzz, after the unpacking and before the configure', () => {
    const named = [...INSTALL.matchAll(/^ {2}"([\w.-]+\.patch) ([0-9a-f]{64})"$/gm)].map((match) => ({ name: match[1], sha256: match[2] }));
    const onDisk = fs.readdirSync(path.join(ROOT, 'scripts', 'ffmpeg-patches')).sort();
    expect(named.map((entry) => entry.name).sort()).toEqual(onDisk);
    expect(named.length).toBeGreaterThan(0);
    for (const { name, sha256 } of named) {
      const bytes = fs.readFileSync(path.join(ROOT, 'scripts', 'ffmpeg-patches', name));
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(sha256);
    }
    const apply = INSTALL.indexOf('patch -p1 --forward --fuzz=0 --no-backup-if-mismatch --input=');
    expect(apply).toBeGreaterThan(INSTALL.indexOf('tar -xJf'));
    expect(apply).toBeLessThan(INSTALL.indexOf('./configure'));
    expect(INSTALL.indexOf('sha256sum --check --strict -', INSTALL.indexOf('for entry in'))).toBeLessThan(apply);
    expect(INSTALL.match(/\bpatch -p1\b/g)).toHaveLength(1);
  });

  it('keeps the libvorbis patch to the one file and the one property: frames of any size, cut into the calls the encoder always made', () => {
    const patch = fs.readFileSync(path.join(ROOT, 'scripts', 'ffmpeg-patches', 'libvorbis-whole-frames.patch'), 'utf-8');
    expect([...patch.matchAll(/^--- (\S+)$/gm)].map((match) => match[1])).toEqual(['a/libavcodec/libvorbisenc.c']);
    expect(patch).toContain('+#define LIBVORBIS_CHUNK_SIZE 64');
    expect(patch).toContain('+    FF_CODEC_RECEIVE_PACKET_CB(libvorbis_receive_packet),');
    expect(patch).toContain('AV_CODEC_CAP_VARIABLE_FRAME_SIZE');
    expect(patch).not.toContain('+    avctx->frame_size');
  });

  it('fails the build when the patch is missing from the encoder or when the stream depends on the frame size', () => {
    expect(INSTALL).toContain("grep -Eq 'General capabilities:.*\\bvariable\\b'");
    expect(INSTALL).toContain('the libvorbis encoder writes another stream for another frame size');
    for (const size of ['64', '100', '100000']) expect(INSTALL, size).toContain(`vorbis_stream ${size}`);
    expect(INSTALL.indexOf('vorbis_stream 64')).toBeGreaterThan(INSTALL.indexOf('make -j"$jobs"'));
  });

  it('links the libraries the conversions name and only those, with no nonfree component and no network', () => {
    for (const { flag } of CODEC_LIBRARIES) expect(INSTALL, flag).toContain(flag);
    for (const flag of ['--enable-gpl', '--disable-autodetect', '--disable-network', '--disable-ffplay', '--enable-indev=lavfi']) expect(INSTALL, flag).toContain(flag);
    const configure = INSTALL.slice(INSTALL.indexOf('./configure'), INSTALL.indexOf('make -j'));
    expect(configure).not.toMatch(/--enable-nonfree|--enable-version3|libfdk|--enable-libaom|--enable-gnutls|--enable-openssl/);
    expect(configure, 'DASH input is not built: its demuxer probes by content and would read local segment files named by an upload').not.toContain('--enable-libxml2');
    expect(DOCKERFILE).not.toMatch(/\blibxml2-dev\b/);
  });

  it('builds position independent executables, and gives every program and shared library a read-only relocation table, immediate binding and a RUNPATH equal to the install lib directory, failing the build otherwise', () => {
    expect(INSTALL).toContain('--toolchain=hardened');
    expect(INSTALL).toContain('"$INSTALL_DIR"/lib/*.so.*; do');
    const build = INSTALL.indexOf('make -j"$jobs"');
    const checks = ['readelf -h "$INSTALL_DIR/bin/$program"', 'readelf -lW -d "$elf"', "'Type:[[:space:]]*DYN'", 'GNU_RELRO', 'BIND_NOW', "'(RPATH)'", 'Library runpath: [$INSTALL_DIR/lib]'].map((check) => INSTALL.indexOf(check));
    for (const position of checks) expect(position).toBeGreaterThan(build);
    expect(Math.max(...checks)).toBeLessThan(INSTALL.indexOf('install -d "$INSTALL_DIR/share/doc/ffmpeg"'));
  });

  it('fails the build when an encoder, a decoder or a filter the conversions name is missing', () => {
    for (const name of ['libx264', 'libx265', 'libvpx-vp9', 'libsvtav1', 'libopus', 'libmp3lame', 'libvorbis']) expect(INSTALL, name).toMatch(new RegExp(`REQUIRED_ENCODERS="[^"]*\\b${name}\\b`));
    expect(INSTALL).toMatch(/REQUIRED_DECODERS="[^"]*\blibdav1d\b/);
    for (const name of ['zscale', 'subtitles']) expect(INSTALL, name).toMatch(new RegExp(`REQUIRED_FILTERS="[^"]*\\b${name}\\b`));
    expect(INSTALL).toContain('--enable-nonfree');
    expect(INSTALL).toContain('the build is nonfree');
  });

  it('installs the licence text and the note that names the archive the build came from', () => {
    expect(INSTALL).toContain('install -m 0644 COPYING.GPLv2 "$INSTALL_DIR/share/doc/ffmpeg/copyright"');
    expect(INSTALL).toMatch(/> "\$INSTALL_DIR\/share\/doc\/ffmpeg\/SOURCE"/);
  });

  it('names each applied patch in the source note and in the tool-versions line, so that the build is not called unmodified', () => {
    expect(INSTALL).toMatch(/>> "\$INSTALL_DIR\/share\/doc\/ffmpeg\/SOURCE"/);
    expect(INSTALL).toMatch(/>> "\$INSTALL_DIR\/share\/doc\/ffmpeg\/tool-version\.txt"/);
    expect(INSTALL).toContain('install -m 0644 "${patch_dir}/${patch_name}" "$INSTALL_DIR/share/doc/ffmpeg/patches/${patch_name}"');
    expect(INSTALL).not.toMatch(/unmodified/);
  });
});
