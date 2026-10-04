export const PIPELINE_OPERATIONS = [
  'convert',
  'ocr',
  'archive',
  'optimize',
  'import/url',
  'import/s3',
  'import/gcs',
  'import/azure',
  'import/sftp',
  'import/webdav',
  'export/url',
  'export/s3',
  'export/gcs',
  'export/azure',
  'export/sftp',
  'export/webdav',
] as const;

export type PipelineOperation = (typeof PIPELINE_OPERATIONS)[number];
