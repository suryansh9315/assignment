import type { RevenueReconciliationResult } from './types.js';
import type { ChargebeeSubscription, StripePayment, FXRate } from '../ingestion/types.js';
import { convertToUSD } from '../utils/fx.js';

/**
 * Revenue reconciliation across billing systems.
 *
 * Compares expected revenue (from active subscriptions) against actual
 * revenue (from payments) accounting for:
 *
 * - **Prorations**: Mid-cycle upgrades/downgrades create prorated charges
 *   that don't match the subscription's stated MRR.  The reconciler must
 *   detect proration periods and adjust expected revenue accordingly.
 *
 * - **Discounts / coupons**: Active coupons reduce the invoiced amount
 *   below the plan's list price.  Both percentage and fixed-amount
 *   coupons must be accounted for, including coupon expiry dates.
 *
 * - **FX conversion**: Subscriptions may be priced in EUR, GBP, etc.
 *   but payments are recorded in the original currency.  Reconciliation
 *   must use the FX rate from the payment date (not today's rate) to
 *   convert both sides to a common currency (USD).
 *
 * - **Timing differences**: A subscription billed on the 1st of the month
 *   may have its payment processed on the 2nd or 3rd.  End-of-month
 *   boundary effects can cause payments to fall in a different calendar
 *   month than expected.
 *
 * - **Failed and retried payments**: A failed payment that is retried
 *   successfully should count as a single expected payment, not two.
 *
 * - **Refunds and disputes**: Refunded or disputed payments reduce actual
 *   revenue but do not necessarily reduce expected revenue.
 *
 * @module reconciliation/revenue
 */

/** Options for revenue reconciliation. */
export interface RevenueReconciliationOptions {
  /** Start of the reconciliation period (inclusive). */
  startDate: Date;
  /** End of the reconciliation period (exclusive). */
  endDate: Date;
  /** Tolerance for amount mismatches in USD. Defaults to 0.50. */
  toleranceUSD?: number;
  /** Whether to include trial subscriptions. Defaults to false. */
  includeTrials?: boolean;
}

/**
 * Reconcile expected subscription revenue against actual payment revenue.
 *
 * @param subscriptions - Active subscriptions from Chargebee (and/or Stripe)
 * @param payments - Payment records from Stripe
 * @param fxRates - Historical FX rates for currency conversion
 * @param options - Reconciliation options (date range, tolerance, etc.)
 * @returns Detailed reconciliation result with line items and breakdown
 */
export async function reconcileRevenue(
  subscriptions: ChargebeeSubscription[],
  payments: StripePayment[],
  fxRates: FXRate[],
  options: RevenueReconciliationOptions,
): Promise<RevenueReconciliationResult> {
  const tolerance = options.toleranceUSD ?? 0.5;
  const periodPayments = payments.filter((payment) =>
    isWithinPeriod(payment.payment_date, options.startDate, options.endDate),
  );
  const paymentsBySubscription = new Map<string, StripePayment[]>();
  const paymentsByCustomer = new Map<string, StripePayment[]>();

  for (const payment of periodPayments) {
    const subscriptionKey = payment.subscription_id;
    if (subscriptionKey) {
      const group = paymentsBySubscription.get(subscriptionKey) ?? [];
      group.push(payment);
      paymentsBySubscription.set(subscriptionKey, group);
    }

    const customerGroup = paymentsByCustomer.get(payment.customer_id) ?? [];
    customerGroup.push(payment);
    paymentsByCustomer.set(payment.customer_id, customerGroup);
  }

  let expectedRevenue = 0;
  let actualRevenue = 0;
  let prorations = 0;
  let discounts = 0;
  let fxDifferences = 0;
  let timingDifferences = 0;
  const lineItems: RevenueReconciliationResult['lineItems'] = [];

  for (const subscription of subscriptions) {
    if (!options.includeTrials && subscription.status === 'in_trial') continue;
    if (!subscriptionOverlapsPeriod(subscription, options.startDate, options.endDate)) continue;

    const expected = getExpectedMonthlyRevenue(subscription, options.startDate, options.endDate, fxRates);
    expectedRevenue += expected;

    const matchingPayments =
      paymentsBySubscription.get(subscription.subscription_id) ??
      paymentsByCustomer.get(subscription.customer.customer_id) ??
      [];
    const actual = matchingPayments.reduce(
      (sum, payment) => sum + getPaymentAmountUSD(payment, fxRates),
      0,
    );
    actualRevenue += actual;

    const prorationImpact = getProrationImpact(subscription, options.startDate, options.endDate);
    prorations += Math.abs(prorationImpact);
    discounts += getDiscountImpact(subscription, options.startDate);

    const nativeActual = matchingPayments.reduce((sum, payment) => sum + signedAmount(payment), 0);
    if (
      matchingPayments.some((payment) => payment.currency.toLowerCase() !== 'usd') ||
      subscription.plan.currency.toLowerCase() !== 'usd'
    ) {
      fxDifferences += Math.abs(actual - nativeActual);
    }

    const difference = actual - expected;
    if (Math.abs(difference) > tolerance) {
      lineItems.push({
        customerId: subscription.customer.customer_id,
        customerName: subscription.customer.company,
        expected: roundMoney(expected),
        actual: roundMoney(actual),
        difference: roundMoney(difference),
        reason:
          matchingPayments.length === 0
            ? 'No matching payment collected in period'
            : prorationImpact !== 0
              ? 'Proration or mid-cycle plan change'
              : 'Collected amount differs from subscription expectation',
      });
      if (matchingPayments.length === 0) timingDifferences += Math.abs(difference);
    }
  }

  actualRevenue += periodPayments
    .filter(
      (payment) =>
        !subscriptions.some(
          (subscription) =>
            subscription.subscription_id === payment.subscription_id ||
            subscription.customer.customer_id === payment.customer_id,
        ),
    )
    .reduce((sum, payment) => sum + getPaymentAmountUSD(payment, fxRates), 0);

  const difference = actualRevenue - expectedRevenue;
  const explained = prorations + discounts + fxDifferences + timingDifferences;

  return {
    expectedRevenue: roundMoney(expectedRevenue),
    actualRevenue: roundMoney(actualRevenue),
    difference: roundMoney(difference),
    differencePercent:
      expectedRevenue === 0 ? 0 : Number(((difference / expectedRevenue) * 100).toFixed(2)),
    lineItems: lineItems.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)),
    breakdown: {
      prorations: roundMoney(prorations),
      discounts: roundMoney(discounts),
      fxDifferences: roundMoney(fxDifferences),
      timingDifferences: roundMoney(timingDifferences),
      unexplained: roundMoney(Math.max(0, Math.abs(difference) - explained)),
    },
  };
}

function isWithinPeriod(date: string, startDate: Date, endDate: Date): boolean {
  const value = new Date(date).getTime();
  return value >= startDate.getTime() && value < endDate.getTime();
}

function subscriptionOverlapsPeriod(
  subscription: ChargebeeSubscription,
  startDate: Date,
  endDate: Date,
): boolean {
  const start = new Date(subscription.current_term_start).getTime();
  const end = new Date(subscription.current_term_end).getTime();
  return start < endDate.getTime() && end >= startDate.getTime() && subscription.status !== 'cancelled';
}

function getExpectedMonthlyRevenue(
  subscription: ChargebeeSubscription,
  startDate: Date,
  endDate: Date,
  fxRates: FXRate[],
): number {
  const monthly = getSubscriptionMonthlyAmount(subscription);
  const prorationImpact = getProrationImpact(subscription, startDate, endDate);
  return convertToUSD(monthly - prorationImpact, subscription.plan.currency, startDate, fxRates);
}

function getSubscriptionMonthlyAmount(subscription: ChargebeeSubscription): number {
  if (subscription.mrr > 0) return subscription.mrr;

  const periods =
    subscription.plan.billing_period_unit === 'year'
      ? subscription.plan.billing_period * 12
      : subscription.plan.billing_period;
  return periods > 0 ? subscription.plan.price / periods : subscription.plan.price;
}

function getProrationImpact(
  subscription: ChargebeeSubscription,
  startDate: Date,
  endDate: Date,
): number {
  return subscription.plan_changes
    .filter((change) => isWithinPeriod(change.change_date, startDate, endDate))
    .reduce((sum, change) => sum + Math.abs(change.proration_amount ?? 0), 0);
}

function getDiscountImpact(subscription: ChargebeeSubscription, periodStart: Date): number {
  const monthly = getSubscriptionMonthlyAmount(subscription);
  return subscription.coupons.reduce((sum, coupon) => {
    const validFrom = new Date(coupon.valid_from).getTime();
    const validTill = coupon.valid_till ? new Date(coupon.valid_till).getTime() : Number.POSITIVE_INFINITY;
    if (validFrom > periodStart.getTime() || validTill < periodStart.getTime()) return sum;
    if (coupon.discount_type === 'percentage') return sum + monthly * (coupon.discount_value / 100);
    return sum + coupon.discount_value;
  }, 0);
}

function signedAmount(payment: StripePayment): number {
  const sign = payment.status === 'refunded' || payment.status === 'disputed' ? -1 : 1;
  return sign * payment.amount;
}

function getPaymentAmountUSD(payment: StripePayment, fxRates: FXRate[]): number {
  if (payment.status === 'failed' || payment.status === 'pending') return 0;
  return convertToUSD(signedAmount(payment), payment.currency, new Date(payment.payment_date), fxRates);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
