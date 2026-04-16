import { join } from 'node:path';
import { loadCSV } from './csv-loader.js';
import type { StripePayment } from './types.js';
import type { FXRate } from './types.js';
import { convertToUSD, loadFXRates } from '../utils/fx.js';

type StripePaymentStatus = StripePayment['status'];

const STATUS_ALIASES: Record<string, StripePaymentStatus> = {
  succeeded: 'succeeded',
  success: 'succeeded',
  paid: 'succeeded',
  captured: 'succeeded',
  failed: 'failed',
  failure: 'failed',
  pending: 'pending',
  processing: 'pending',
  requires_payment_method: 'pending',
  requires_action: 'pending',
  refunded: 'refunded',
  partial_refund: 'refunded',
  partially_refunded: 'refunded',
  dispute: 'disputed',
  disputed: 'disputed',
  chargeback: 'disputed',
};

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

function getField(row: Record<string, string>, candidates: string[]): string | undefined {
  const entries = Object.entries(row);

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeKey(candidate);
    const match = entries.find(([key]) => normalizeKey(key) === normalizedCandidate);
    if (match) return match[1];
  }

  return undefined;
}

function toNullableString(value: string | undefined): string | null {
  if (value == null) return null;

  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.toLowerCase() === 'null' ||
    normalized.toLowerCase() === 'undefined'
  ) {
    return null;
  }

  return normalized;
}

function requireField(
  row: Record<string, string>,
  candidates: string[],
  fieldName: string,
): string {
  const value = toNullableString(getField(row, candidates));
  if (value == null) {
    throw new Error(`Missing required Stripe field "${fieldName}"`);
  }

  return value;
}

function parseAmount(value: string | undefined): number {
  const normalized = toNullableString(value);
  if (normalized == null) return 0;

  const compact = normalized.replace(/[$,\s]/g, '');
  const parsed = Number(compact);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Stripe amount "${value}"`);
  }

  return Math.trunc(parsed);
}

function normalizeCurrency(value: string | undefined): string {
  const normalized = toNullableString(value);
  return normalized == null ? 'usd' : normalized.toLowerCase();
}

function normalizePaymentDate(value: string | undefined): string {
  const normalized = toNullableString(value);
  if (normalized == null) {
    throw new Error('Missing required Stripe field "payment_date"');
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid Stripe payment date "${value}"`);
  }

  // Preserve date-only values as YYYY-MM-DD for stable reconciliation keys.
  return normalized.length <= 10 ? normalized : parsed.toISOString();
}

function normalizeStatus(row: Record<string, string>): StripePaymentStatus {
  if (toNullableString(getField(row, ['dispute_id', 'dispute', 'chargeback_id']))) {
    return 'disputed';
  }

  if (toNullableString(getField(row, ['refund_id', 'refund', 'refund_transaction_id']))) {
    return 'refunded';
  }

  const amount = parseAmount(
    getField(row, ['amount', 'amount_cents', 'gross_amount', 'net_amount']),
  );
  if (amount < 0) {
    return 'refunded';
  }

  if (toNullableString(getField(row, ['failure_code', 'failure_reason', 'decline_code']))) {
    return 'failed';
  }

  const explicitStatus = toNullableString(
    getField(row, ['status', 'payment_status', 'charge_status']),
  );
  const normalizedStatus = explicitStatus
    ? STATUS_ALIASES[explicitStatus.toLowerCase()]
    : undefined;
  if (normalizedStatus) return normalizedStatus;

  return 'pending';
}

function normalizeStripeRow(row: Record<string, string>, fxRates: FXRate[]): StripePayment {
  const rawAmount = parseAmount(
    getField(row, ['amount', 'amount_cents', 'gross_amount', 'net_amount']),
  );
  const currency = normalizeCurrency(getField(row, ['currency']));
  const paymentDate = normalizePaymentDate(
    getField(row, ['payment_date', 'created', 'created_at', 'date', 'charge_date']),
  );
  const amount =
    currency === 'usd' ? rawAmount : convertToUSD(rawAmount, currency, new Date(paymentDate), fxRates);

  return {
    payment_id: requireField(
      row,
      ['payment_id', 'id', 'charge_id', 'payment_intent_id'],
      'payment_id',
    ),
    customer_id: requireField(
      row,
      ['customer_id', 'customer', 'stripe_customer_id'],
      'customer_id',
    ),
    customer_name: requireField(row, ['customer_name', 'name', 'customer'], 'customer_name'),
    amount,
    currency,
    status: normalizeStatus(row),
    payment_date: paymentDate,
    subscription_id: toNullableString(
      getField(row, ['subscription_id', 'subscription', 'stripe_subscription_id']),
    ),
    description: toNullableString(getField(row, ['description', 'memo', 'statement_descriptor'])),
    failure_code: toNullableString(
      getField(row, ['failure_code', 'failure_reason', 'decline_code']),
    ),
    refund_id: toNullableString(getField(row, ['refund_id', 'refund', 'refund_transaction_id'])),
    dispute_id: toNullableString(getField(row, ['dispute_id', 'dispute', 'chargeback_id'])),
  };
}

/**
 * Load and normalize Stripe payment data.
 *
 * Raw Stripe payments need normalization:
 * - Currency amounts may need FX conversion
 * - Failed payments with retries should be linked
 * - Refunds may appear as negative amounts or separate rows
 * - Dispute payments need special handling
 *
 * @param dataDir - Path to the data directory
 * @returns Normalized Stripe payment records
 */
export async function loadStripePayments(dataDir: string): Promise<StripePayment[]> {
  const filePath = join(dataDir, 'stripe_payments.csv');
  const fxRatesPath = join(dataDir, 'fx_rates.csv');
  const fxRates = await loadFXRates(fxRatesPath);

  return loadCSV<StripePayment>(filePath, {
    transform: (row) => normalizeStripeRow(row, fxRates),
  });
}
