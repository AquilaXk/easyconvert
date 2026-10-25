/** Whitespace as FFmpeg's tokenizer counts it (libavutil/avstring.c `WHITESPACES`). */
const FFMPEG_WHITESPACE = ' \n\t\r';
/** Characters special in a filter option value, besides `'` and `\` (doc/filters.texi, "Notes on filtergraph escaping"). */
const FILTER_OPTION_SPECIALS = ':';
/** Characters special in a filtergraph description, besides `'` and `\`. */
const FILTERGRAPH_SPECIALS = '[],;';

/**
 * libavutil/bprint.c `av_bprint_escape` in AV_ESCAPE_MODE_BACKSLASH without flags: `\` goes before `'`, `\`, each
 * character of `specials`, and whitespace that starts or ends the string, which `av_get_token` would otherwise drop.
 */
function ffmpegBackslashEscape(value: string, specials: string): string {
  let escaped = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    const firstOrLast = i === 0 || i === value.length - 1;
    if (c === "'" || c === '\\' || specials.includes(c) || (firstOrLast && FFMPEG_WHITESPACE.includes(c))) escaped += '\\';
    escaped += c;
  }
  return escaped;
}

/**
 * A file path as the value of a filter option inside a filtergraph (`subtitles=filename=<value>`). It is escaped twice,
 * as doc/filters.texi "Notes on filtergraph escaping" prescribes: first for the option value, whose separator is `:`,
 * then for the filtergraph description, whose separators are `[`, `]`, `,` and `;`. FFmpeg undoes the second level in
 * libavfilter/graphparser.c (`av_get_token(filter, "[],;")`) and the first in ff_filter_opt_parse (`av_get_token(args, ":")`).
 */
export function escapeFfmpegFilterPath(filePath: string): string {
  return ffmpegBackslashEscape(ffmpegBackslashEscape(filePath, FILTER_OPTION_SPECIALS), FILTERGRAPH_SPECIALS);
}
