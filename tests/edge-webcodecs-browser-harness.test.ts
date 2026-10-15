import { describe, it } from 'vitest';

/**
 * Real WebCodecs encoders and decoders exist only in a browser. This repository has no browser harness yet (the
 * Playwright Chromium harness is shared with the image-tier work), so the checks below that need one are listed
 * rather than faked. Everything the worker does with the platform's codecs is covered in Node against platform
 * stand-ins, and every byte it writes is judged by ffprobe and ffmpeg in edge-media-mux.test.ts.
 *
 * The entries stay `todo`: vitest reports them as todo, never as passed, and they do not turn into a skip that
 * ORACLE_STRICT_MODE=1 would have to fail, because there is no tool to be missing, only a harness not yet written.
 * The first entry states a quality criterion (SSIM and audio SNR of the converted file against the source) that no
 * test in this repository verifies yet: the encoders it measures exist only in a browser.
 */
describe('WebCodecs worker in a real browser (no harness available)', () => {
  it.todo('converts H.264 + AAC MP4 to VP9/AV1 + Opus WebM; ffprobe duration within one frame, SSIM >= 0.95, audio SNR >= 20 dB');
  it.todo('converts H.264 + AAC MP4 to MP4 with VP9: vp09 + vpcC, decodes with ffmpeg');
  it.todo('converts WAV to m4a: ftyp M4A, esds, ffprobe reports AAC in MP4');
});
