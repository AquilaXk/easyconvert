import { DISPOSABLE_EMAIL_DOMAINS } from './disposable-email-domains.generated';

/**
 * Whether the address is on a domain of the list of disposable mailboxes, so that a sign-up cannot make accounts from addresses
 * made to be thrown away. The list is vendored (third_party/disposable-email-domains, CC0 1.0) and read once into a Set; the
 * server never fetches it. As the list's own notes say, an entry is a second-level domain (or a third-level one under a public
 * suffix), so the domain of the address and each of its parents are looked up: `a@inbox.example.com` matches `example.com`.
 */
let blocked: ReadonlySet<string> | undefined;

export function isDisposableEmail(email: string): boolean {
  blocked ??= new Set(DISPOSABLE_EMAIL_DOMAINS);
  const labels = email.slice(email.lastIndexOf('@') + 1).toLowerCase().split('.');
  // The last label alone is a top-level domain, never an entry.
  for (let start = 0; start < labels.length - 1; start++) {
    if (blocked.has(labels.slice(start).join('.'))) return true;
  }
  return false;
}
