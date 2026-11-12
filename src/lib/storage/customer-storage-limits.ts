/** Files an `import.s3` or `import.sftp` node takes from a prefix or a directory when it names no `maxObjects`. */
export const DEFAULT_STORAGE_IMPORT_OBJECTS = 20;

/** The most files one import node takes from a prefix or a directory; a listing with more is refused, never cut short. */
export const MAX_STORAGE_IMPORT_OBJECTS = 100;
