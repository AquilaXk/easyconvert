/** Limit for a case that walks every registered format or pair, sized against the slowest on a CI runner (8.5 s, the picker's names in Korean); finite so a hung walk still fails. */
export const REGISTRY_WIDE_TIMEOUT_MS = 30_000;
