// Input of tests/i18n-hardcoded-strings.test.ts: each kind of copy the scanner must flag, and code it must leave alone.
import React from 'react';

export function Sample({ name }: { name: string }) {
  const status = 'Converting queued files now...';
  const error = { message: 'Failed to load the file list.' };
  console.warn('Developer Facing Warning Message here');
  return (
    <div className="flex items-center gap-2 text-ink" data-testid="sample-root">
      <h2>Visible heading</h2>
      <button type="button" aria-label="Close dialog">
        ×
      </button>
      <input placeholder="Search formats" />
      <span>{'Copied'}</span>
      <span>{status}</span>
      <span>{error.message}</span>
      <button type="button" aria-label={`Remove file ${name}`} />
      <span>EasyConvert</span>
      <code>POST /api/v1/convert</code>
    </div>
  );
}
