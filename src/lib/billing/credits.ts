/**
 * The credit model (docs/policy-decisions.md, entry 285): what a conversion costs in credits, the sizes of the packages and
 * subscriptions that are sold, and the minute surcharge. Pure data and arithmetic, so the server, the pricing page and the tests
 * read one table. The registry decides which formats exist; this table decides which of them are office or iWork.
 */

/** Credits a package gives, once. Each size has its own Paddle price (`PADDLE_PRICE_ID_PACKAGE_<size>`). */
export const PACKAGE_SIZES = [500, 1000, 2500, 5000, 10000] as const;
export type PackageSize = (typeof PACKAGE_SIZES)[number];

/** Credits a subscription gives each billing period. Each size has its own Paddle price (`PADDLE_PRICE_ID_SUBSCRIPTION_<size>`). */
export const SUBSCRIPTION_SIZES = [1000, 2500, 5000, 10000] as const;
export type SubscriptionSize = (typeof SUBSCRIPTION_SIZES)[number];

export const isPackageSize = (value: unknown): value is PackageSize => PACKAGE_SIZES.some((size) => size === value);
export const isSubscriptionSize = (value: unknown): value is SubscriptionSize => SUBSCRIPTION_SIZES.some((size) => size === value);

/** What a Paddle price sells: a package of credits, or a subscription of credits a period. */
export type ProductKind = 'package' | 'subscription';
export type Product = { kind: 'package'; credits: PackageSize } | { kind: 'subscription'; credits: SubscriptionSize };

/** The variable that holds the Paddle price id of each package and each subscription. */
export const priceIdVariable = (kind: ProductKind, credits: number): string => `PADDLE_PRICE_ID_${kind === 'package' ? 'PACKAGE' : 'SUBSCRIPTION'}_${credits}`;

/** The kinds of conversion that cost different credits. */
export const CONVERSION_CLASSES = ['general', 'office-to-pdf', 'iwork-to-pdf', 'pdf-to-office'] as const;
export type ConversionClass = (typeof CONVERSION_CLASSES)[number];

/** Credits one successful conversion costs, by class, before the minute surcharge. */
export const CREDITS_PER_CLASS: Readonly<Record<ConversionClass, number>> = {
  general: 1,
  'office-to-pdf': 2,
  'iwork-to-pdf': 2,
  'pdf-to-office': 4,
};

/** The word-processor, spreadsheet and presentation formats of the registry that count as office documents. */
export const OFFICE_FORMATS: ReadonlySet<string> = new Set([
  'doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'odt', 'ott', 'fodt',
  'xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'ods', 'ots', 'fods',
  'ppt', 'pptx', 'pptm', 'pot', 'potx', 'pps', 'ppsx', 'odp', 'otp', 'fodp',
]);

/** Apple's iWork formats. */
export const IWORK_FORMATS: ReadonlySet<string> = new Set(['pages', 'numbers', 'key']);

const PDF = 'pdf';

/** The class a conversion between two format ids belongs to. */
export function conversionClassOf(sourceFormat: string, targetFormat: string): ConversionClass {
  const source = sourceFormat.toLowerCase();
  const target = targetFormat.toLowerCase();
  if (target === PDF && OFFICE_FORMATS.has(source)) return 'office-to-pdf';
  if (target === PDF && IWORK_FORMATS.has(source)) return 'iwork-to-pdf';
  if (source === PDF && OFFICE_FORMATS.has(target)) return 'pdf-to-office';
  return 'general';
}

/** Credits reserved for a conversion before it runs: the cost of its class. */
export function baseCredits(sourceFormat: string, targetFormat: string): number {
  return CREDITS_PER_CLASS[conversionClassOf(sourceFormat, targetFormat)];
}

const MS_PER_MINUTE = 60_000;

/** Minutes of processing that have started: 40 s is 1, 60 s is 1, 61 s is 2. */
export function startedMinutes(processingMs: number): number {
  return Number.isFinite(processingMs) && processingMs > 0 ? Math.ceil(processingMs / MS_PER_MINUTE) : 0;
}

/** Credits added for processing time: one for every started minute beyond the first. */
export function minuteSurcharge(processingMs: number): number {
  return Math.max(0, startedMinutes(processingMs) - 1);
}
