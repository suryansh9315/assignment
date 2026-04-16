import type { NRRResult, MetricOptions } from './types.js';
import { getUnifiedARRRecords } from './arr.js';

/**
 * Net Revenue Retention (NRR) calculation.
 *
 * NRR measures how much revenue is retained and expanded from an existing
 * customer cohort over a period, excluding new business.  The formula is:
 *
 *   NRR = (Starting ARR + Expansion - Contraction - Churn) / Starting ARR
 *
 * Key components:
 *
 * - **Expansion**: Revenue increases from existing customers via upgrades,
 *   additional seats, add-on purchases, or moving to higher-tier plans.
 *   Expansion is measured as the delta between the customer's ARR at the
 *   start and end of the period (only positive deltas).
 *
 * - **Contraction**: Revenue decreases from existing customers via downgrades,
 *   seat removals, or increased discounts.  Contraction is measured as the
 *   absolute value of negative ARR deltas for customers who are still active.
 *
 * - **Churn**: Complete revenue loss from customers who cancelled during the
 *   period.  The churned amount is the customer's ARR at the start of the
 *   period (not the partial period revenue).
 *
 * Important considerations:
 * - The cohort is defined as all customers who were active at `startDate`.
 * - New customers acquired during the period are excluded from NRR.
 * - Reactivated customers (churned and returned) are typically counted as
 *   new business, not expansion.
 * - FX fluctuations on non-USD subscriptions can cause "phantom" expansion
 *   or contraction; consider using a fixed exchange rate for consistency.
 *
 * @param startDate - Beginning of the measurement period
 * @param endDate - End of the measurement period
 * @param options - Calculation options
 * @returns NRR result with percentage and component breakdown
 */
export async function calculateNRR(
  startDate: Date,
  endDate: Date,
  options?: MetricOptions,
): Promise<NRRResult> {
  const [startRecords, endRecords] = await Promise.all([
    getUnifiedARRRecords(startDate, options),
    getUnifiedARRRecords(endDate, options),
  ]);
  const start = summarize(startRecords);
  const end = summarize(endRecords);
  let expansion = 0;
  let contraction = 0;
  let churn = 0;
  const breakdown: NRRResult['breakdown'] = [];

  for (const [customerKey, starting] of start.entries()) {
    const ending = end.get(customerKey);
    const endingARR = ending?.arr ?? 0;
    const change = endingARR - starting.arr;
    let changeType: NRRResult['breakdown'][number]['changeType'] = 'unchanged';

    if (endingARR === 0) {
      churn += starting.arr;
      changeType = 'churn';
    } else if (change > 0) {
      expansion += change;
      changeType = 'expansion';
    } else if (change < 0) {
      contraction += Math.abs(change);
      changeType = 'contraction';
    }

    breakdown.push({
      customerName: ending?.name ?? starting.name,
      startingARR: starting.arr,
      endingARR,
      change,
      changeType,
      reason: changeType === 'unchanged' ? null : `${changeType} between period snapshots`,
    });
  }

  const startingARR = Array.from(start.values()).reduce((sum, record) => sum + record.arr, 0);
  const endingARR = startingARR + expansion - contraction - churn;

  return {
    percentage: startingARR === 0 ? 0 : Number(((endingARR / startingARR) * 100).toFixed(2)),
    expansion: Math.round(expansion),
    contraction: Math.round(contraction),
    churn: Math.round(churn),
    startingARR: Math.round(startingARR),
    endingARR: Math.round(endingARR),
    breakdown: breakdown.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)),
    periodStart: startDate.toISOString(),
    periodEnd: endDate.toISOString(),
  };
}

function summarize(records: Awaited<ReturnType<typeof getUnifiedARRRecords>>) {
  const summary = new Map<string, { name: string; arr: number }>();
  for (const record of records) {
    const current = summary.get(record.customerKey);
    summary.set(record.customerKey, {
      name: current?.name ?? record.companyName,
      arr: (current?.arr ?? 0) + record.arr,
    });
  }
  return summary;
}
