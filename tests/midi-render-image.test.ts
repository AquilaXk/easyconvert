import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * How the worker image and CI get the MIDI renderer (src/lib/conversions/midi-render.ts): the FluidSynth program and the
 * General MIDI SoundFont in the runner stage, the same two packages in CI so a test runs against what the image ships, and a
 * render inside the sandbox in the container check. The expectations are written out here.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (...segments: string[]): string => readFileSync(path.join(ROOT, ...segments), 'utf-8');
const runner = parseDockerfile(read('Dockerfile.worker')).find((stage) => stage.name === 'runner');
const runs = (runner?.instructions ?? []).filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument);

describe('the MIDI renderer in the worker image and in CI', () => {
  it('installs FluidSynth and the General MIDI SoundFont in the runner stage without recommended packages', () => {
    const install = runs.find((argument) => /apt-get install/.test(argument)) ?? '';
    expect(install).toMatch(/--no-install-recommends/);
    expect(install).toMatch(/\sfluidsynth\s/);
    expect(install).toMatch(/\stimgm6mb-soundfont\s/);
  });

  it('fails the build when FluidSynth does not start or the SoundFont link the worker reads leads nowhere', () => {
    const check = runs.find((argument) => argument.includes('FluidSynth runtime version')) ?? '';
    expect(check).toBe("fluidsynth --version | grep -q 'FluidSynth runtime version' && test -s /usr/share/sounds/sf2/default-GM.sf2");
  });

  it('reads the SoundFont under the name the image check tests, before any other candidate', () => {
    const source = read('src', 'lib', 'conversions', 'midi-render.ts');
    const candidates = /const SOUNDFONT_CANDIDATES = \[\s*'([^']+)'/.exec(source)?.[1];
    expect(candidates).toBe('/usr/share/sounds/sf2/default-GM.sf2');
  });

  it('installs the same two packages in CI', () => {
    const packages = read('.github', 'actions', 'ci-setup', 'apt-packages.txt').split('\n');
    expect(packages.filter((name) => /^(fluidsynth|timgm6mb-soundfont)$/.test(name))).toEqual(['fluidsynth', 'timgm6mb-soundfont']);
  });

  it('renders a note to a WAV inside the sandbox in the container check', () => {
    const script = read('scripts', 'verify-worker-container.sh');
    expect(script).toMatch(/sandboxed timeout "\$CONVERSION_TIMEOUT_SECONDS" fluidsynth -ni -q -r 44100 -T wav -F "\$work_dir\/output\.wav" \/usr\/share\/sounds\/sf2\/default-GM\.sf2/);
    expect(script).toContain('pass "fluidsynth rendered a MIDI note to a WAV inside the sandbox"');
  });
});
