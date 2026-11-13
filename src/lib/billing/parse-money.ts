/*
 * Copied verbatim from PaddleHQ/paddle-nextjs-starter-kit, src/utils/paddle/parse-money.ts, at commit
 * da90482f8416f0e54a24991200e168496fce94b7 (Apache-2.0, Copyright 2024 Paddle.com Market Limited, SHA-256 of the file b138dcd6...fed8). The code below this comment is
 * unchanged; the changes of this repository to it are separate commits (git log of this file). See NOTICE and docs/licensing.md, 2.20.
 */
export function convertAmountFromLowestUnit(amount: string, currency: string) {
  switch (currency) {
    case 'JPY':
    case 'KRW':
    case 'VND':
    case 'CLP':
      return parseFloat(amount);
    default:
      return parseFloat(amount) / 100;
  }
}

export function parseMoney(amount: string = '0', currency: string = 'USD') {
  const parsedAmount = convertAmountFromLowestUnit(amount, currency);
  return formatMoney(parsedAmount, currency);
}

export function formatMoney(amount: number = 0, currency: string = 'USD') {
  const language = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  return new Intl.NumberFormat(language ?? 'en-US', {
    style: 'currency',
    currency: currency,
  }).format(amount);
}
