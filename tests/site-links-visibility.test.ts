import { describe, expect, it } from 'vitest';
import { primaryLinksFor } from '../src/components/site-links';

describe('the primary links of the header', () => {
  it('leave out the dashboard for a visitor and show it to a signed-in person', () => {
    expect(primaryLinksFor(false).map((link) => link.key)).not.toContain('dashboard');
    expect(primaryLinksFor(true).map((link) => link.key)).toContain('dashboard');
  });
});
