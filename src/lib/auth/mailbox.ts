/**
 * Whether a string is one plain mailbox address (`local@domain`) and nothing else. An address goes to the mail server as the
 * recipient, where a comma, a display name in angle brackets, a quote, a group or a line break turns one string into other or
 * several recipients; so registration accepts only this form, and the sender checks it again before every send.
 */
export const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;

// Local part: the dot-atom characters of RFC 5322 without quoting. Domain: dot-separated labels of letters, digits and hyphens.
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function isPlainMailbox(value: string): boolean {
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > MAX_LOCAL_LENGTH || !LOCAL_PART.test(local)) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
}
