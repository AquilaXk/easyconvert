import { describe, expect, it } from 'vitest';
import { extraIterations, mustUpdate } from '../src/lib/auth/pbkdf2-upgrade';

/** Expectations written by hand from `must_update` and `harden_runtime` of Django's `PBKDF2PasswordHasher` (BSD-3-Clause; see NOTICE and docs/licensing.md, 2.34). */
describe('PBKDF2 upgrade rules (Django: must_update, harden_runtime)', () => {
  it('upgrades a hash whose iterations differ from the current ones, and no other', () => {
    expect(mustUpdate(100_000, 210_000)).toBe(true);
    expect(mustUpdate(210_000, 210_000)).toBe(false);
    expect(mustUpdate(300_000, 210_000)).toBe(true);
  });

  it('runs again the iterations a stored hash lacks, and none when it has as many or more', () => {
    expect(extraIterations(100_000, 210_000)).toBe(110_000);
    expect(extraIterations(210_000, 210_000)).toBe(0);
    expect(extraIterations(300_000, 210_000)).toBe(0);
  });
});
