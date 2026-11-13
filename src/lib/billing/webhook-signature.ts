/*
 * The Paddle-Signature check, translated to TypeScript from PaddleHQ/paddle-python-sdk, paddle_billing/Notifications/PaddleSignature.py
 * (SHA-256 dfd2fe51...c9b7) and Verifier.py (SHA-256 c1a0f3ea...8a3f), at commit f8f575394eb0c2d404ca6d79e6527145cdc50cfe
 * (Apache-2.0, Copyright 2024 Paddle.com Market Limited). The logic is the SDK's: the header is read for its timestamp and every h1
 * value, the HMAC-SHA256 of `<ts>:<raw body>` is compared in constant time with each of them (a header carries several during a key
 * rotation, and one match is enough), and a timestamp farther than the window from now in either direction refuses the request.
 * The window is that of PaddleHQ/paddle-node-sdk (5 s, src/notifications/helpers/webhooks-validator.ts, commit
 * 4e6485ddf9a1547a7b3d111886080828a343d304), whose own check keeps only the last h1 of a header. A key the header names that this
 * code does not know (`h2`) is ignored, as the Node SDK's tests require; the Python SDK raises on it. See NOTICE and docs/licensing.md, 2.21.
 */
import crypto from 'node:crypto';

/** How far the timestamp of a signature may be from this server's clock, in seconds. */
export const SIGNATURE_WINDOW_SECONDS = 5;
const MS_PER_SECOND = 1000;

interface ParsedSignature {
  timestamp: number;
  hashes: string[];
}

/** The timestamp and the h1 values of a `Paddle-Signature` header, or null when it has no valid timestamp or no h1. */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestamp = '';
  const hashes: string[] = [];
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at);
    const value = part.slice(at + 1);
    if (key === 'ts') timestamp = value;
    else if (key === 'h1' && value) hashes.push(value);
  }
  if (!/^\d+$/.test(timestamp) || hashes.length === 0) return null;
  return { timestamp: Number(timestamp), hashes };
}

/** Whether two texts are equal, compared in constant time for equal lengths (the signature and the checkout tag are secrets of the same kind). */
export function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export type SignatureCheck =
  | { valid: true }
  /** `malformed`: no timestamp or no h1; `mismatch`: no h1 is the signature of this body made with the secret; `window`: genuine, but its time is `skewSeconds` off this clock (positive: behind). */
  | { valid: false; reason: 'malformed' | 'mismatch' }
  | { valid: false; reason: 'window'; skewSeconds: number };

/** Checks the `Paddle-Signature` header of a webhook against its raw body and the secret of the notification destination. */
export function checkSignature(secret: string, rawBody: string, header: string, now: number): SignatureCheck {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: 'malformed' };
  const expected = crypto.createHmac('sha256', secret).update(`${parsed.timestamp}:${rawBody}`).digest('hex');
  if (!parsed.hashes.some((hash) => sameText(hash, expected))) return { valid: false, reason: 'mismatch' };
  const behindMs = now - parsed.timestamp * MS_PER_SECOND;
  if (Math.abs(behindMs) > SIGNATURE_WINDOW_SECONDS * MS_PER_SECOND) return { valid: false, reason: 'window', skewSeconds: Math.round(behindMs / MS_PER_SECOND) };
  return { valid: true };
}
