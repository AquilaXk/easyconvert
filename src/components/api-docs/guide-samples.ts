/** The requests the guide pages show, sent to the site's own origin with the key read from an environment variable. */

const KEY_HEADER = '-H "x-api-key: $EASYCONVERT_API_KEY"';

export function authenticationSample(origin: string): string {
  return [
    `curl "${origin}/api/v1/jobs" \\\n  ${KEY_HEADER}`,
    `curl "${origin}/api/v1/jobs" \\\n  -H "Authorization: Bearer $EASYCONVERT_API_KEY"`,
  ].join('\n\n');
}

export function convertSample(origin: string): string {
  return [
    `curl -X POST "${origin}/api/v1/convert"`,
    `  ${KEY_HEADER}`,
    '  -H "Accept: application/octet-stream"',
    '  -F "file=@report.docx"',
    '  -F "targetFormat=pdf"',
    '  -o report.pdf',
  ].join(' \\\n');
}

export function startUploadSample(origin: string): string {
  return [
    `curl -X POST "${origin}/api/v1/uploads/direct"`,
    `  ${KEY_HEADER}`,
    '  -H "Content-Type: application/json"',
    `  -d '{"filename": "talk.mov", "totalSize": 734003200}'`,
  ].join(' \\\n');
}

export function createJobSample(origin: string): string {
  return [
    `curl -X POST "${origin}/api/v1/jobs"`,
    `  ${KEY_HEADER}`,
    '  -H "Content-Type: application/json"',
    `  -d '{"storageKey": "<storageKey>", "targetFormat": "mp4"}'`,
  ].join(' \\\n');
}

export function showJobSample(origin: string): string {
  return [`curl "${origin}/api/v1/jobs/<jobId>"`, `  ${KEY_HEADER}`].join(' \\\n');
}

export function downloadSample(origin: string): string {
  return [`curl "${origin}<downloadUrl>"`, `  ${KEY_HEADER}`, '  -o talk.mp4'].join(' \\\n');
}
