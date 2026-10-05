/**
 * Camera RAW source formats: the single list the in-process engine, the native RAW engine and the
 * queue's resource classification all consult. srw and kdc are decoded by LibRaw although the
 * registry does not advertise them as sources yet.
 */
export const RAW_CAMERA_FORMATS: ReadonlySet<string> = new Set([
  '3fr', 'arw', 'cr2', 'cr3', 'crw', 'dcr', 'dng', 'erf', 'kdc', 'mos', 'mrw', 'nef', 'orf', 'pef', 'raf', 'raw', 'rw2', 'srw', 'x3f',
]);
