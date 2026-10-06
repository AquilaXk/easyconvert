/**
 * Camera RAW source formats: the single list the in-process engine, the native RAW engine and the
 * queue's resource classification all consult. srw and kdc are decoded by LibRaw although the
 * registry does not advertise them as sources yet.
 */
export const RAW_CAMERA_FORMATS: ReadonlySet<string> = new Set([
  '3fr', 'arw', 'cr2', 'cr3', 'crw', 'dcr', 'dng', 'erf', 'kdc', 'mos', 'mrw', 'nef', 'orf', 'pef', 'raf', 'raw', 'rw2', 'srw', 'x3f',
]);

/**
 * Pixel cap for a decoded RAW image: the largest sensors in the registry's camera families are
 * about 150 megapixels, and the 16-bit RGB intermediate is 6 bytes per pixel. The LibRaw engine and the
 * in-process sensor decoders enforce the same limit.
 */
export const RAW_DECODE_MAX_PIXELS = 150_000_000;
