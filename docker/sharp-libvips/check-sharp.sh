#!/usr/bin/env bash
# usage: check-sharp.sh <app root>
# Fails unless the sharp installed under <app root> runs on the libvips this directory builds. The lock file and the installed
# @img/sharp-libvips-linux-<arch> package must be the release env.sh pins (a sharp upgrade that brings another release must
# move the pins with it, or a new addon would run on the old library), and a node process started there must encode a
# WebP with libvips VIPS_VERSION mapped from that package's lib directory and from nowhere else.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/env.sh"
cd "$1"

SHARP_LIBVIPS_VERSION="$SHARP_LIBVIPS_VERSION" VIPS_VERSION="$VIPS_VERSION" node - << 'EOF'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { SHARP_LIBVIPS_VERSION: release, VIPS_VERSION: vips } = process.env;
const name = `@img/sharp-libvips-linux-${process.arch}`;
const failures = [];
const locked = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')).packages?.[`node_modules/${name}`]?.version;
const installed = JSON.parse(fs.readFileSync(path.join('node_modules', name, 'package.json'), 'utf8')).version;
for (const [where, version] of [['package-lock.json', locked], ['node_modules', installed]]) {
  if (version !== release) failures.push(`${where} has ${name} ${version}, the libvips build is of ${release}: move the pins of docker/sharp-libvips/env.sh with the sharp upgrade`);
}

const sharp = require('sharp');
const library = fs.realpathSync(path.join('node_modules', name, 'lib', `libvips-cpp.so.${vips}`));
sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
  .webp()
  .toBuffer()
  .then((webp) => {
    const mapped = [...new Set(fs.readFileSync('/proc/self/maps', 'utf8').split('\n').filter((line) => line.includes('libvips-cpp')).map((line) => line.trim().split(/\s+/).pop()))];
    if (mapped.length !== 1 || mapped[0] !== library) failures.push(`the process maps ${mapped.join(', ') || 'no libvips-cpp'}, not ${library}`);
    if (sharp.versions.vips !== vips) failures.push(`sharp reports libvips ${sharp.versions.vips}, not ${vips}`);
    if (webp.toString('latin1', 0, 4) !== 'RIFF' || webp.toString('latin1', 8, 12) !== 'WEBP') failures.push('the encode did not return a WebP file');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(library)).digest('hex');
    console.log(`sharp ${JSON.parse(fs.readFileSync(path.join('node_modules', 'sharp', 'package.json'), 'utf8')).version} on libvips ${sharp.versions.vips}: ${library} (sha256 ${digest}), a ${webp.length}-byte WebP`);
    for (const failure of failures) console.error(failure);
    process.exit(failures.length === 0 ? 0 : 1);
  });
EOF
