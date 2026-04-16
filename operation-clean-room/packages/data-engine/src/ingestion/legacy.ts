import { join } from 'node:path';
import { loadXML } from './xml-loader.js';
import type { FXRate, LegacyInvoice } from './types.js';
import { parseAmbiguousDate } from '../utils/date-parser.js';
import { convertToUSD, loadFXRates } from '../utils/fx.js';

type RawLegacyInvoice = {
  id?: string;
  customer_name?: string;
  amount?: number | string;
  currency?: string;
  date?: string;
  status?: string;
  description?: string;
  payment_ref?: string;
};

type LegacyInvoiceDocument = {
  invoices?: {
    invoice?: RawLegacyInvoice[];
  };
};

const VALID_STATUSES = new Set<LegacyInvoice['status']>([
  'paid',
  'unpaid',
  'overdue',
  'void',
  'partially_paid',
]);

function toNullableString(value: string | null | undefined): string | null {
  if (value == null) return null;

  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.toLowerCase() === 'null' ||
    trimmed.toLowerCase() === 'undefined'
  ) {
    return null;
  }

  return trimmed;
}

function requireString(value: string | null | undefined, fieldName: string): string {
  const normalized = toNullableString(value);
  if (normalized == null) {
    throw new Error(`Missing required legacy invoice field "${fieldName}"`);
  }

  return normalized;
}

function normalizeAmount(value: number | string | undefined): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Invalid legacy invoice amount');
    }

    return value;
  }

  const normalized = toNullableString(value);
  if (normalized == null) {
    throw new Error('Missing required legacy invoice field "amount"');
  }

  const parsed = Number(normalized.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid legacy invoice amount "${value}"`);
  }

  return parsed;
}

function normalizeStatus(value: string | undefined): LegacyInvoice['status'] {
  const normalized = requireString(value, 'status').toLowerCase() as LegacyInvoice['status'];
  if (!VALID_STATUSES.has(normalized)) {
    throw new Error(`Unsupported legacy invoice status "${normalized}"`);
  }

  return normalized;
}

function inferDominantLegacyFormat(dates: string[]): 'DD/MM/YYYY' | 'MM/DD/YYYY' {
  let dayFirst = 0;
  let monthFirst = 0;

  for (const rawDate of dates) {
    const trimmed = rawDate.trim();
    const parts = trimmed.split(/[\/.-]/);
    if (parts.length !== 3) continue;

    const first = Number(parts[0]);
    const second = Number(parts[1]);

    if (first > 12 && second <= 12) dayFirst++;
    if (second > 12 && first <= 12) monthFirst++;
  }

  return dayFirst >= monthFirst ? 'DD/MM/YYYY' : 'MM/DD/YYYY';
}

function normalizeLegacyInvoice(
  invoice: RawLegacyInvoice,
  allDates: string[],
  formatHint: 'DD/MM/YYYY' | 'MM/DD/YYYY',
  fxRates: FXRate[],
): LegacyInvoice {
  const rawDate = requireString(invoice.date, 'date');
  const parsedDate = parseAmbiguousDate(rawDate, {
    neighborDates: allDates,
    formatHint,
  });
  const rawAmount = normalizeAmount(invoice.amount);
  const currency = requireString(invoice.currency, 'currency').toLowerCase();
  const amount =
    currency === 'usd' ? rawAmount : convertToUSD(rawAmount, currency, parsedDate, fxRates);

  return {
    id: requireString(invoice.id, 'id'),
    customer_name: requireString(invoice.customer_name, 'customer_name'),
    amount,
    currency,
    date: parsedDate.toISOString(),
    status: normalizeStatus(invoice.status),
    description: toNullableString(invoice.description),
    payment_ref: toNullableString(invoice.payment_ref),
  };
}

/**
 * Load and normalize legacy billing system invoices.
 *
 * The legacy system was decommissioned but its historical data is critical
 * for accurate LTV calculations and reconciliation.  Key challenges:
 *
 * - **Ambiguous date formats**: The legacy system inconsistently used both
 *   DD/MM/YYYY and MM/DD/YYYY formats depending on the operator's locale.
 *   Dates like "03/04/2023" are genuinely ambiguous (March 4 vs April 3).
 *   Use contextual clues (surrounding dates, invoice sequences) to resolve.
 *   See `utils/date-parser.ts` for the disambiguation strategy.
 *
 * - **payment_ref cross-referencing**: Some invoices have a `payment_ref`
 *   field that contains a Stripe charge ID (e.g. "ch_3Ox...").  This allows
 *   linking legacy invoices to Stripe payments for reconciliation.  However,
 *   the field is often null or contains internal reference numbers that look
 *   similar but are NOT Stripe IDs.
 *
 * - **Currency inconsistencies**: Some invoices store amounts in cents while
 *   others store in whole units.  The `currency` field is sometimes missing
 *   or contains non-standard codes.
 *
 * - **Partial payments**: The legacy system supported partial payments,
 *   resulting in "partially_paid" statuses.  The `amount` field reflects
 *   the total invoice value, not the amount collected.
 *
 * @param dataDir - Path to the data directory
 * @returns Normalized legacy invoice records
 */
export async function loadLegacyInvoices(dataDir: string): Promise<LegacyInvoice[]> {
  const filePath = join(dataDir, 'legacy_invoices.xml');
  const fxRatesPath = join(dataDir, 'fx_rates.csv');
  const [document, fxRates] = await Promise.all([
    loadXML<LegacyInvoiceDocument>(filePath, {
      arrayTags: ['invoice'],
    }),
    loadFXRates(fxRatesPath),
  ]);

  const invoices = document.invoices?.invoice;
  if (!Array.isArray(invoices)) {
    throw new Error(`Invalid legacy invoice payload in ${filePath}: expected invoices.invoice[]`);
  }

  const allDates = invoices
    .map((invoice) => toNullableString(invoice.date))
    .filter((date): date is string => date != null);
  const formatHint = inferDominantLegacyFormat(allDates);

  return invoices.map((invoice, index) => {
    try {
      return normalizeLegacyInvoice(invoice, allDates, formatHint, fxRates);
    } catch (err) {
      throw new Error(
        `Failed to normalize legacy invoice at index ${index}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}
