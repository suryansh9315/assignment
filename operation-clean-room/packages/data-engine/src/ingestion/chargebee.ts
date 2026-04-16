import { join } from 'node:path';
import { loadJSON } from './json-loader.js';
import type { ChargebeeSubscription, ChargebeeCoupon, ChargebeePlanChange, FXRate } from './types.js';
import { convertToUSD, loadFXRates } from '../utils/fx.js';

type RawChargebeeSubscription = {
  id?: unknown;
  customer?: {
    id?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    email?: unknown;
    company?: unknown;
    billing_address?: {
      line1?: unknown;
      city?: unknown;
      state?: unknown;
      country?: unknown;
      zip?: unknown;
    };
  };
  plan?: {
    id?: unknown;
    name?: unknown;
    price?: unknown;
    currency?: unknown;
    billing_period?: unknown;
    interval?: unknown;
  };
  status?: unknown;
  trial_end?: unknown;
  current_term_start?: unknown;
  current_term_end?: unknown;
  created_at?: unknown;
  cancelled_at?: unknown;
  cancel_reason?: unknown;
  coupons?: unknown[];
  plan_changes?: unknown[];
  addons?: unknown[];
  metadata?: unknown;
} & Record<string, unknown>;

type RawChargebeePayload =
  | RawChargebeeSubscription[]
  | { subscriptions?: RawChargebeeSubscription[] };

const VALID_STATUSES = new Set<ChargebeeSubscription['status']>([
  'active',
  'in_trial',
  'cancelled',
  'non_renewing',
  'paused',
  'future',
]);

const VALID_BILLING_UNITS = new Set<ChargebeeSubscription['plan']['billing_period_unit']>([
  'month',
  'year',
]);

const VALID_DISCOUNT_TYPES = new Set<ChargebeeCoupon['discount_type']>([
  'percentage',
  'fixed_amount',
]);

const VALID_APPLY_ON = new Set<ChargebeeCoupon['apply_on']>([
  'invoice_amount',
  'each_specified_item',
]);

const VALID_CHANGE_TYPES = new Set<ChargebeePlanChange['change_type']>([
  'upgrade',
  'downgrade',
  'lateral',
]);

function asRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error(`Invalid Chargebee field "${fieldName}"`);
}

function toNullableString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return String(value);

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

function requireString(value: unknown, fieldName: string): string {
  const normalized = toNullableString(value);
  if (normalized == null) {
    throw new Error(`Missing required Chargebee field "${fieldName}"`);
  }

  return normalized;
}

function toNumber(value: unknown, fieldName: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid Chargebee number in field "${fieldName}"`);
    }

    return value;
  }

  const normalized = toNullableString(value);
  if (normalized == null) return 0;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Chargebee number in field "${fieldName}"`);
  }

  return parsed;
}

function toInteger(value: unknown, fieldName: string): number {
  return Math.trunc(toNumber(value, fieldName));
}

function normalizeChargebeeAmount(value: unknown, currency: string, fieldName: string): number {
  const amount = toNumber(value, fieldName);
  const zeroDecimalCurrencies = new Set(['jpy', 'krw', 'vnd']);

  if (zeroDecimalCurrencies.has(currency.trim().toLowerCase())) {
    return amount;
  }

  return Math.round((amount / 100) * 100) / 100;
}

function normalizeDate(value: unknown, fieldName: string, required = true): string | null {
  const normalized = toNullableString(value);
  if (normalized == null) {
    if (required) {
      throw new Error(`Missing required Chargebee field "${fieldName}"`);
    }

    return null;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid Chargebee date in field "${fieldName}"`);
  }

  return parsed.toISOString();
}

function normalizeStatus(value: unknown): ChargebeeSubscription['status'] {
  const status = requireString(value, 'status').toLowerCase() as ChargebeeSubscription['status'];
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Unsupported Chargebee status "${status}"`);
  }

  return status;
}

function normalizeBillingPeriodUnit(
  value: unknown,
): ChargebeeSubscription['plan']['billing_period_unit'] {
  const raw = requireString(value, 'plan.interval').toLowerCase();
  if (VALID_BILLING_UNITS.has(raw as ChargebeeSubscription['plan']['billing_period_unit'])) {
    return raw as ChargebeeSubscription['plan']['billing_period_unit'];
  }

  if (raw === 'monthly') return 'month';
  if (raw === 'annual' || raw === 'yearly') return 'year';

  throw new Error(`Unsupported Chargebee billing interval "${raw}"`);
}

function splitCompanyName(company: string): { firstName: string; lastName: string } {
  const tokens = company.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { firstName: '', lastName: '' };
  }

  if (tokens.length === 1) {
    return { firstName: tokens[0]!, lastName: '' };
  }

  return {
    firstName: tokens[0]!,
    lastName: tokens.slice(1).join(' '),
  };
}

function normalizeCoupon(value: unknown, currency: string): ChargebeeCoupon {
  const coupon = asRecord(value, 'coupons[]');
  const discountTypeRaw = requireString(
    coupon.discount_type,
    'coupons[].discount_type',
  ).toLowerCase();
  const discountType = VALID_DISCOUNT_TYPES.has(discountTypeRaw as ChargebeeCoupon['discount_type'])
    ? (discountTypeRaw as ChargebeeCoupon['discount_type'])
    : (() => {
        throw new Error(`Unsupported Chargebee coupon discount type "${discountTypeRaw}"`);
      })();

  const applyOnRaw = requireString(coupon.apply_on, 'coupons[].apply_on').toLowerCase();
  const applyOn = VALID_APPLY_ON.has(applyOnRaw as ChargebeeCoupon['apply_on'])
    ? (applyOnRaw as ChargebeeCoupon['apply_on'])
    : (() => {
        throw new Error(`Unsupported Chargebee coupon apply_on "${applyOnRaw}"`);
      })();

  return {
    coupon_id: requireString(coupon.coupon_id, 'coupons[].coupon_id'),
    coupon_name: requireString(coupon.coupon_name, 'coupons[].coupon_name'),
    discount_type: discountType,
    discount_value:
      discountType === 'fixed_amount'
        ? normalizeChargebeeAmount(coupon.discount_value, currency, 'coupons[].discount_value')
        : toInteger(coupon.discount_value, 'coupons[].discount_value'),
    apply_on: applyOn,
    valid_from: normalizeDate(coupon.valid_from, 'coupons[].valid_from')!,
    valid_till: normalizeDate(coupon.valid_till, 'coupons[].valid_till', false),
  };
}

function normalizePlanChange(value: unknown, currency: string): ChargebeePlanChange {
  const change = asRecord(value, 'plan_changes[]');
  const changeTypeRaw = requireString(
    change.change_type,
    'plan_changes[].change_type',
  ).toLowerCase();
  const changeType = VALID_CHANGE_TYPES.has(changeTypeRaw as ChargebeePlanChange['change_type'])
    ? (changeTypeRaw as ChargebeePlanChange['change_type'])
    : (() => {
        throw new Error(`Unsupported Chargebee plan change type "${changeTypeRaw}"`);
      })();

  return {
    change_date: normalizeDate(change.changed_at, 'plan_changes[].changed_at')!,
    previous_plan: requireString(change.from_plan, 'plan_changes[].from_plan'),
    new_plan: requireString(change.to_plan, 'plan_changes[].to_plan'),
    previous_amount: normalizeChargebeeAmount(
      change.previous_price,
      currency,
      'plan_changes[].previous_price',
    ),
    new_amount: normalizeChargebeeAmount(change.new_price, currency, 'plan_changes[].new_price'),
    change_type: changeType,
    proration_amount:
      toNullableString(change.prorated) == null
        ? null
        : normalizeChargebeeAmount(change.prorated, currency, 'plan_changes[].prorated'),
  };
}

function normalizeAddon(value: unknown, currency: string): ChargebeeSubscription['addons'][number] {
  const addon = asRecord(value, 'addons[]');

  return {
    addon_id: requireString(addon.addon_id, 'addons[].addon_id'),
    addon_name: requireString(addon.addon_name, 'addons[].addon_name'),
    quantity: toInteger(addon.quantity, 'addons[].quantity'),
    unit_price: normalizeChargebeeAmount(addon.unit_price, currency, 'addons[].unit_price'),
  };
}

function isCouponActive(coupon: ChargebeeCoupon, asOf: Date): boolean {
  const validFrom = new Date(coupon.valid_from);
  const validTill = coupon.valid_till ? new Date(coupon.valid_till) : null;

  return (
    validFrom.getTime() <= asOf.getTime() && (!validTill || validTill.getTime() >= asOf.getTime())
  );
}

function calculateMRR(
  planPrice: number,
  billingPeriodUnit: ChargebeeSubscription['plan']['billing_period_unit'],
  addons: ChargebeeSubscription['addons'],
  coupons: ChargebeeCoupon[],
  currentTermStart: string,
): number {
  const billingPeriodMonths = billingPeriodUnit === 'year' ? 12 : 1;
  const addonTotal = addons.reduce((sum, addon) => sum + addon.quantity * addon.unit_price, 0);
  const recurringAmount = planPrice + addonTotal;
  const monthlyBase = recurringAmount / billingPeriodMonths;

  const activeCoupons = coupons.filter(
    (coupon) =>
      coupon.apply_on === 'invoice_amount' && isCouponActive(coupon, new Date(currentTermStart)),
  );

  const discountedMonthlyAmount = activeCoupons.reduce((amount, coupon) => {
    if (coupon.discount_type === 'percentage') {
      return amount * (1 - coupon.discount_value / 100);
    }

    return amount - coupon.discount_value / billingPeriodMonths;
  }, monthlyBase);

  return Math.max(0, Math.round(discountedMonthlyAmount));
}

function normalizeSubscription(
  raw: RawChargebeeSubscription,
  fxRates: FXRate[],
): ChargebeeSubscription {
  const customer = asRecord(raw.customer, 'customer');
  const plan = asRecord(raw.plan, 'plan');
  const company = requireString(customer.company, 'customer.company');
  const nameFallback = splitCompanyName(company);
  const billingAddress = customer.billing_address
    ? asRecord(customer.billing_address, 'customer.billing_address')
    : {};
  const billingPeriodUnit = normalizeBillingPeriodUnit(plan.interval ?? plan.billing_period);
  const currentTermStart = normalizeDate(raw.current_term_start, 'current_term_start')!;
  const normalizedCurrency = requireString(plan.currency, 'plan.currency').toLowerCase();
  const planPrice = normalizeChargebeeAmount(plan.price, normalizedCurrency, 'plan.price');
  const normalizedCoupons = Array.isArray(raw.coupons)
    ? raw.coupons.map((coupon) => normalizeCoupon(coupon, normalizedCurrency))
    : [];
  const normalizedAddons = Array.isArray(raw.addons)
    ? raw.addons.map((addon) => normalizeAddon(addon, normalizedCurrency))
    : [];
  const mrr = calculateMRR(
    planPrice,
    billingPeriodUnit,
    normalizedAddons,
    normalizedCoupons,
    currentTermStart,
  );
  const baseMetadata =
    raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
      ? (raw.metadata as Record<string, unknown>)
      : {};

  return {
    subscription_id: requireString(raw.id, 'id'),
    customer: {
      customer_id: requireString(customer.id, 'customer.id'),
      first_name: toNullableString(customer.first_name) ?? nameFallback.firstName,
      last_name: toNullableString(customer.last_name) ?? nameFallback.lastName,
      email: requireString(customer.email, 'customer.email'),
      company,
      billing_address: {
        line1: toNullableString(billingAddress.line1) ?? '',
        city: toNullableString(billingAddress.city) ?? '',
        state: toNullableString(billingAddress.state) ?? '',
        country: toNullableString(billingAddress.country) ?? '',
        zip: toNullableString(billingAddress.zip) ?? '',
      },
    },
    plan: {
      plan_id: requireString(plan.id, 'plan.id'),
      plan_name: requireString(plan.name, 'plan.name'),
      price: planPrice,
      currency: normalizedCurrency,
      billing_period: billingPeriodUnit === 'year' ? 12 : 1,
      billing_period_unit: billingPeriodUnit,
      trial_end: normalizeDate(raw.trial_end, 'trial_end', false),
    },
    status: normalizeStatus(raw.status),
    current_term_start: currentTermStart,
    current_term_end: normalizeDate(raw.current_term_end, 'current_term_end')!,
    created_at: normalizeDate(raw.created_at, 'created_at')!,
    cancelled_at: normalizeDate(raw.cancelled_at, 'cancelled_at', false),
    cancel_reason: toNullableString(raw.cancel_reason),
    mrr,
    coupons: normalizedCoupons,
    plan_changes: Array.isArray(raw.plan_changes)
      ? raw.plan_changes.map((change) => normalizePlanChange(change, normalizedCurrency))
      : [],
    addons: normalizedAddons,
    metadata: {
      ...baseMetadata,
      mrr_usd: convertToUSD(mrr, normalizedCurrency, new Date(currentTermStart), fxRates),
    },
  };
}

/**
 * Load and normalize Chargebee subscription data.
 *
 * Chargebee subscriptions have a deeply nested JSON structure that requires
 * careful handling:
 *
 * - **Nested customer object**: Customer details are embedded inside each
 *   subscription.  The same customer may appear across multiple subscriptions
 *   and must be de-duplicated.
 *
 * - **Coupons**: Subscriptions may have one or more coupons with percentage
 *   or fixed-amount discounts.  Coupons can have expiry dates, so MRR
 *   calculations must check whether coupons are still active.
 *
 * - **Plan changes**: A subscription's `plan_changes` array records every
 *   upgrade, downgrade, or lateral move.  Proration amounts on plan changes
 *   affect revenue recognition for the period in which they occur.
 *
 * - **Trial handling**: Subscriptions in `in_trial` status have a `trial_end`
 *   date on their plan object.  These should generally be excluded from ARR
 *   unless specifically requested.  When a trial converts, the first payment
 *   date may differ from the subscription creation date.
 *
 * - **Addons**: Additional line items that contribute to MRR but are tracked
 *   separately from the base plan price.
 *
 * @param dataDir - Path to the data directory
 * @returns Normalized Chargebee subscription records
 */
export async function loadChargebeeSubscriptions(
  dataDir: string,
): Promise<ChargebeeSubscription[]> {
  const filePath = join(dataDir, 'chargebee_subscriptions.json');
  const fxRatesPath = join(dataDir, 'fx_rates.csv');
  const [payload, fxRates] = await Promise.all([
    loadJSON<RawChargebeePayload>(filePath),
    loadFXRates(fxRatesPath),
  ]);
  const subscriptions = Array.isArray(payload) ? payload : payload.subscriptions;

  if (!Array.isArray(subscriptions)) {
    throw new Error(`Invalid Chargebee payload in ${filePath}: expected a subscriptions array`);
  }

  return subscriptions.map((subscription, index) => {
    try {
      return normalizeSubscription(subscription, fxRates);
    } catch (err) {
      throw new Error(
        `Failed to normalize Chargebee subscription at index ${index}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}
