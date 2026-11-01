// Input of tests/i18n-hardcoded-strings.test.ts: each kind of copy the scanner must flag, and code it must leave alone.
import React from 'react';

class ConversionError extends Error {
  constructor(message: string, readonly failure: Record<string, string>) {
    super(message);
  }
}

export function Sample({ name }: { name: string }) {
  const status = 'Converting queued files now...';
  const error = { message: 'Failed to load the file list.' };
  console.warn('Developer Facing Warning Message here');
  const failure = { error: 'Failed', label: 'Upload', id: 'Primary' };
  const limit = `File size exceeds the ${name} limit.`;
  const logged = new Error('The conversion did not finish in time. Try again.');
  const shown = new ConversionError('Logged message for callers.', { code: 'server', label: 'Shown Failure Label Text' });
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
