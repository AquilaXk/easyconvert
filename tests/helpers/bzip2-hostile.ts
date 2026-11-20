/**
 * One bzip2 stream of 69 bytes that decodes to one 900,000-byte block of "abab...", written by `compressBzip2` (the system `bzip2 -dc` decodes it
 * to 900,000 bytes). The pattern has no run of four, so the block is a full inverse BWT of 900,000 symbols (6 to 9 ms), and a decoder has to read
 * one such block for each 69 bytes of the input.
 */
const ONE_BLOCK_STREAM = Buffer.from('QlpoOTFBWSZTWREfKpgDbuMBADAAIAAwgE1GioQiYVCETmKCskymszop4UYAAAkCAGAAQABBU0EEyxxdyRThQkL8qpZM', 'base64');

/**
 * `count` concatenated copies of that stream (a decoder reads them as one input): 35 of them (2.4 KB) decode to 31.5 MB in 119 ms, and
 * 14,000 of them (966 KB) are 12.6 GB of output.
 */
export function hostileBzip2Streams(count: number): Buffer {
  return Buffer.concat(Array.from({ length: count }, () => ONE_BLOCK_STREAM));
}
