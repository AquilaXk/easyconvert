export const PIPELINE_OPERATIONS = ['convert', 'ocr', 'archive', 'optimize'] as const;

export type PipelineOperation = (typeof PIPELINE_OPERATIONS)[number];
