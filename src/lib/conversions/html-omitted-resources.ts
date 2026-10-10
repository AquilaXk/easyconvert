/**
 * Policy and report for the resources an HTML document names but the converter never fetches. Network access is
 * never granted to a conversion, so an image that is not embedded as a data: URI cannot be drawn. By default it is
 * left out and reported as a warning in the result; with `requireResources` the conversion refuses instead.
 */

/** Longest reference a warning quotes, in characters. */
const MAX_REFERENCE_CHARS = 120;
/** Most omissions listed one by one; the rest are counted in a final warning. */
export const MAX_REPORTED_OMISSIONS = 50;
const CONTROL_CHARACTERS = /\p{Cc}/gu;

export interface HtmlResourcePolicy {
  /** Refuse a document with an external resource (400) instead of leaving the resource out. */
  requireResources?: boolean;
}

function quoted(reference: string): string {
  const text = [...reference.replaceAll(CONTROL_CHARACTERS, ' ').trim()];
  return text.length > MAX_REFERENCE_CHARS ? `${text.slice(0, MAX_REFERENCE_CHARS).join('')}…` : text.join('');
}

/** The external images one conversion left out, in document order. */
export class OmittedExternalImages {
  private readonly listed: string[] = [];
  private total = 0;

  add(reference: string): void {
    this.total++;
    if (this.listed.length < MAX_REPORTED_OMISSIONS) this.listed.push(quoted(reference));
  }

  get count(): number {
    return this.total;
  }

  /** One warning per listed image, then one for the images beyond the limit. */
  warnings(): string[] {
    const lines = this.listed.map((reference) => `Left out the image "${reference}": external resources are not fetched.`);
    const unlisted = this.total - this.listed.length;
    if (unlisted > 0) lines.push(`Left out ${unlisted} more external images: external resources are not fetched.`);
    return lines;
  }
}
