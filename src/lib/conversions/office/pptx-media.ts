import type JSZip from 'jszip';
import { InflateBudget } from '../bounded-inflate';
import { assertEmbeddableImageWithinLimit, openLimitedSharp, rethrowInputPixelLimit } from '../image-input-limits';
import { MAX_ZIP_MEDIA_BYTES, readZipEntryBytes } from '../zip-entry-reader';
import { maxDocumentMediaBytes } from './media-limits';

/**
 * Embedded pictures of one PPTX conversion. A deck can name one media part from any number of pictures, so each part
 * is read once and shared by every picture that uses it; the decoded bytes of all parts are charged once to a
 * per-document budget. A target that does not draw pictures (text, Markdown, JSON) never reads a media part.
 */

/** Longest string V8 can build, in characters (2^29 - 24). */
const V8_MAX_STRING_CHARS = 0x1fffffe8;

/**
 * Most base64 characters of pictures an HTML page may embed in all: the string limit of the engine less 128 MiB for the
 * markup around them. Past it the page cannot be built, so the conversion is refused (413) before any picture is encoded.
 */
export const HTML_MAX_EMBEDDED_BASE64_CHARS = V8_MAX_STRING_CHARS - 128 * 1024 * 1024;

/** Base64 characters of `bytes` bytes. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

export interface LoadedPicture {
  /** Shared by every picture that uses the part; copy it before changing it. */
  buffer: Buffer;
  mimeType: string;
}

export interface PptxMediaOptions {
  /** False for a target that draws no pictures: no media part is then read. */
  enabled: boolean;
  /** Most bytes one part may decode to, where the target cannot hold more than that. */
  maxPartBytes?: number;
}

export class PptxMedia {
  readonly enabled: boolean;
  private readonly maxPartBytes: number;
  private readonly budget = new InflateBudget(maxDocumentMediaBytes());
  private readonly parts = new Map<string, Promise<LoadedPicture>>();

  constructor(options: PptxMediaOptions = { enabled: true }) {
    this.enabled = options.enabled;
    this.maxPartBytes = Math.min(options.maxPartBytes ?? MAX_ZIP_MEDIA_BYTES, MAX_ZIP_MEDIA_BYTES);
  }

  /** The picture stored at `mediaPath`, read on first use; undefined when media is not wanted or the part is missing. */
  picture(zip: JSZip, mediaPath: string): Promise<LoadedPicture | undefined> {
    const entry = this.enabled ? zip.file(mediaPath) : null;
    if (!entry) return Promise.resolve(undefined);
    let part = this.parts.get(mediaPath);
    if (!part) {
      part = this.load(entry, mediaPath);
      this.parts.set(mediaPath, part);
    }
    return part;
  }

  /** Counts a picture derived from a part (converted or cropped) against the document budget, since it is held as well. */
  chargeDerived(bytes: number, mediaPath: string): void {
    this.budget.charge(bytes, `A copy of ZIP entry '${mediaPath}'`);
  }

  private async load(entry: JSZip.JSZipObject, mediaPath: string): Promise<LoadedPicture> {
    let buffer = await readZipEntryBytes(entry, { maxBytes: this.maxPartBytes, budget: this.budget });
    // PNG and JPEG are embedded without a re-encode, whatever the part is called: check their header.
    // Pictures are processed one at a time on purpose: each decode can hold up to the pixel limit in memory.
    await assertEmbeddableImageWithinLimit(buffer);
    const lower = mediaPath.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return { buffer, mimeType: 'image/jpeg' };
    if (!lower.endsWith('.png')) {
      let converted: Buffer | undefined;
      try {
        converted = await openLimitedSharp(buffer).png().toBuffer();
      } catch (err) {
        rethrowInputPixelLimit(err);
      }
      // Outside the try: rethrowInputPixelLimit passes every other error on, which would swallow the budget's 413.
      if (converted) {
        this.chargeDerived(converted.length, mediaPath);
        buffer = converted;
      }
    }
    return { buffer, mimeType: 'image/png' };
  }
}
