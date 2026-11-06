/** The key of a format in the `formatDescriptions` messages: a message key cannot hold a dot (`tar.gz` is `tar_gz`). */
export function formatMessageKey(formatId: string): string {
  return formatId.replaceAll('.', '_');
}
