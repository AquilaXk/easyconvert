import type { UserRecord } from './types';

/** Whether the address of the account is known to be the owner's: Google vouches for it, an email account proves it with the link of a verification mail, or with a password reset. */
export function isEmailVerified(record: Pick<UserRecord, 'provider' | 'emailVerified'>): boolean {
  return record.provider === 'google' || record.emailVerified === true;
}

/**
 * The fields that confirm the address of `record` now. The first confirmation also writes `verifiedAt`, which later confirmations
 * and the accounts confirmed before it was recorded leave as it is: a time that moved forward would make the owner's own keys look
 * older than the confirmation (`revokeStandingAccess`).
 */
export function confirmationFields(record: Pick<UserRecord, 'provider' | 'emailVerified'>, now: number = Date.now()): Pick<UserRecord, 'emailVerified' | 'verifiedAt'> {
  return isEmailVerified(record) ? { emailVerified: true } : { emailVerified: true, verifiedAt: now };
}

/** An account that signs in with an email and a password and has not been linked to Google. */
export function isPasswordAccount(record: Pick<UserRecord, 'provider' | 'passwordHash' | 'salt'>): boolean {
  return record.provider === 'email' && Boolean(record.passwordHash) && Boolean(record.salt);
}

/**
 * Whether an account is treated as an anonymous visitor for conversions: a password account whose address was never confirmed
 * (every new account until its mailed link is used, and the accounts made before that) and that has bought nothing. It uses the allowance of its address bucket and
 * not a daily allowance of its own, so a person cannot multiply the free allowance with accounts of addresses they do not own;
 * confirming the address (the link of the verification mail, or a password reset) ends it. Google accounts and paid accounts are never treated so.
 */
export function countsAsAnonymousForConversions(user: Pick<UserRecord, 'provider' | 'emailVerified' | 'tier'>): boolean {
  return user.provider === 'email' && !isEmailVerified(user) && user.tier === 'free';
}
