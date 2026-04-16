/**
 * Company name and amount normalization utilities.
 *
 * Cross-system entity matching requires normalizing company names so that
 * variant spellings can be compared.  For example, these should all be
 * recognized as the same entity:
 *
 *   - "Acme Corp"
 *   - "ACME Corporation"
 *   - "acme corp."
 *   - "Acme Corporation Ltd."
 *   - "ACME, Inc."
 *   - "The Acme Company"
 *
 * Normalization steps:
 * 1. Convert to lowercase
 * 2. Remove common legal suffixes (Inc, Corp, Corporation, Ltd, LLC, GmbH,
 *    AG, SA, SAS, BV, NV, Pty, Co, Company, Group, Holdings, etc.)
 * 3. Remove common prefixes ("The ")
 * 4. Remove punctuation (periods, commas, hyphens) but preserve spaces
 * 5. Collapse multiple spaces into one
 * 6. Trim leading and trailing whitespace
 *
 * @module utils/normalization
 */

/**
 * Normalize a company name for fuzzy matching.
 *
 * @param name - Raw company name from any data source
 * @returns Normalized name suitable for comparison
 */
export function normalizeCompanyName(name: string): string {
  const legalSuffixes = [
    'incorporated',
    'inc',
    'corporation',
    'corp',
    'company',
    'co',
    'limited',
    'ltd',
    'llc',
    'gmbh',
    'ag',
    'sa',
    'sas',
    'bv',
    'nv',
    'pty',
    'group',
    'holdings',
    'holding',
    'systems',
    'solutions',
    'technologies',
    'technology',
    'software',
    'services',
    'service',
    'studios',
    'studio',
    'corporation',
  ];

  const suffixPattern = new RegExp(`\\b(?:${legalSuffixes.join('|')})\\b`, 'g');

  return name
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[.,'’&/()-]/g, ' ')
    .replace(suffixPattern, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a monetary amount to a standard representation.
 *
 * Handles common inconsistencies:
 * - Some systems store amounts in cents (integer), others in dollars (decimal).
 * - Negative amounts may represent refunds or credits.
 * - Very large amounts (> 1,000,000) in "cents" currencies should be
 *   divided by 100 to get the dollar value.
 *
 * The heuristic:
 * - If `currency` is a zero-decimal currency (JPY, KRW, etc.), return as-is.
 * - If the amount is an integer and > 10,000, assume it's in cents and divide by 100.
 * - Otherwise return as-is (assumed to be in major currency units).
 *
 * @param amount - Raw amount value
 * @param currency - ISO 4217 currency code
 * @returns Amount normalized to major currency units (e.g., dollars, not cents)
 */
export function normalizeAmount(amount: number, currency: string): number {
  const zeroDecimalCurrencies = new Set(['JPY', 'KRW', 'VND']);
  const normalizedCurrency = currency.trim().toUpperCase();

  if (zeroDecimalCurrencies.has(normalizedCurrency)) {
    return amount;
  }

  if (Number.isInteger(amount) && Math.abs(amount) > 10_000) {
    return amount / 100;
  }

  return amount;
}
