import { describe, expect, it } from 'vitest';
import { recordEngineOutput } from '../src/lib/engine-output';
import { captureEngineOutput } from './helpers/engine-output-log';

describe('captureEngineOutput', () => {
  it('keeps what was recorded readable after restore', () => {
    const log = captureEngineOutput();
    recordEngineOutput('ddjvu', 'djvu', 'no shape dictionary');
    log.restore();
    expect(log.outputs()).toEqual(['no shape dictionary']);
    expect(log.engines()).toEqual(['ddjvu']);
  });
});
