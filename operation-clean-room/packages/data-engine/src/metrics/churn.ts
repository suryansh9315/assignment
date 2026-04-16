import type { ChurnResult, MetricOptions } from './types.js';
import { getUnifiedARRRecords } from './arr.js';

/**
 * Churn metrics calculation.
 *
 * Churn can be measured in multiple ways, each telling a different story:
 *
 * - **Gross revenue churn**: Percentage of starting-period revenue lost to
 *   cancellations and downgrades, *before* accounting for expansion from
 *   remaining customers.  Formula:
 *     Gross Churn = (Churned Revenue + Contraction) / Starting Revenue
 *
 * - **Net revenue churn**: Percentage of starting-period revenue lost *after*
 *   accounting for expansion.  Can be negative if expansion exceeds churn
 *   (which is the goal for healthy SaaS companies).  Formula:
 *     Net Churn = (Churned Revenue + Contraction - Expansion) / Starting Revenue
 *
 * - **Logo churn (customer churn)**: Percentage of customers who cancelled,
 *   regardless of revenue.  A company losing many small customers has high
 *   logo churn but may have low revenue churn.  Formula:
 *     Logo Churn = Customers Cancelled / Starting Customer Count
 *
 * - **Revenue churn**: Absolute dollar amount of recurring revenue lost
 *   to cancellations in the period.
 *
 * Segmentation is critical for churn analysis:
 * - By **cancellation reason**: Helps identify systemic product or service issues.
 * - By **segment**: Enterprise customers may churn differently than SMBs.
 * - By **plan**: Usage-based plans may have higher variability.
 * - By **tenure**: New customers often churn at higher rates ("early churn").
 *
 * @param startDate - Beginning of the measurement period
 * @param endDate - End of the measurement period
 * @param options - Calculation options
 * @returns Comprehensive churn metrics with breakdowns
 */
export async function calculateChurn(
  startDate: Date,
  endDate: Date,
  options?: MetricOptions,
): Promise<ChurnResult> {
  const [startRecords, endRecords] = await Promise.all([
    getUnifiedARRRecords(startDate, options),
    getUnifiedARRRecords(endDate, options),
  ]);
  const start = summarize(startRecords);
  const end = summarize(endRecords);
  const startingARR = Array.from(start.values()).reduce((sum, record) => sum + record.arr, 0);
  const startingCustomers = start.size;
  let revenueChurned = 0;
  let contraction = 0;
  let expansion = 0;
  let logoChurnCount = 0;

  const churnedRecords: typeof startRecords = [];
  const changedRecords: { record: (typeof startRecords)[number]; revenueChurn: number }[] = [];

  for (const [customerKey, starting] of start.entries()) {
    const ending = end.get(customerKey);
    const endingARR = ending?.arr ?? 0;
    const delta = endingARR - starting.arr;

    if (endingARR === 0) {
      revenueChurned += starting.arr;
      logoChurnCount += 1;
      churnedRecords.push(...starting.records);
    } else if (delta < 0) {
      contraction += Math.abs(delta);
      changedRecords.push({ record: starting.records[0]!, revenueChurn: Math.abs(delta) });
    } else if (delta > 0) {
      expansion += delta;
    }
  }

  const churnInputs = [
    ...churnedRecords.map((record) => ({ record, revenueChurn: record.arr })),
    ...changedRecords,
  ];

  return {
    grossChurn: startingARR === 0 ? 0 : Number((((revenueChurned + contraction) / startingARR) * 100).toFixed(2)),
    netChurn:
      startingARR === 0
        ? 0
        : Number((((revenueChurned + contraction - expansion) / startingARR) * 100).toFixed(2)),
    logoChurnRate:
      startingCustomers === 0 ? 0 : Number(((logoChurnCount / startingCustomers) * 100).toFixed(2)),
    logoChurnCount,
    revenueChurned: Math.round(revenueChurned),
    byReason: buildBreakdown(churnInputs, () => 'snapshot_loss', startingARR),
    bySegment: buildBreakdown(churnInputs, (record) => record.account?.segment ?? 'unmapped', startingARR),
    byPlan: buildBreakdown(churnInputs, (record) => record.planName, startingARR),
    byTenure: buildBreakdown(churnInputs, (record) => getTenureBucket(record.startDate, endDate), startingARR),
    periodStart: startDate.toISOString(),
    periodEnd: endDate.toISOString(),
  };
}

function summarize(records: Awaited<ReturnType<typeof getUnifiedARRRecords>>) {
  const summary = new Map<string, { arr: number; records: typeof records }>();
  for (const record of records) {
    const current = summary.get(record.customerKey);
    summary.set(record.customerKey, {
      arr: (current?.arr ?? 0) + record.arr,
      records: [...(current?.records ?? []), record],
    });
  }
  return summary;
}

function buildBreakdown(
  inputs: { record: Awaited<ReturnType<typeof getUnifiedARRRecords>>[number]; revenueChurn: number }[],
  labelFn: (record: Awaited<ReturnType<typeof getUnifiedARRRecords>>[number]) => string,
  startingARR: number,
) {
  const groups = new Map<string, { customers: Set<string>; revenue: number }>();
  for (const input of inputs) {
    const label = labelFn(input.record);
    const group = groups.get(label) ?? { customers: new Set<string>(), revenue: 0 };
    group.customers.add(input.record.customerKey);
    group.revenue += input.revenueChurn;
    groups.set(label, group);
  }

  return Array.from(groups.entries()).map(([label, group]) => ({
    label,
    logoChurn: group.customers.size,
    revenueChurn: Math.round(group.revenue),
    churnRate: startingARR === 0 ? 0 : Number(((group.revenue / startingARR) * 100).toFixed(2)),
  }));
}

function getTenureBucket(startDate: string, endDate: Date): string {
  const months =
    (endDate.getUTCFullYear() - new Date(startDate).getUTCFullYear()) * 12 +
    (endDate.getUTCMonth() - new Date(startDate).getUTCMonth());
  if (months < 3) return '0-3 months';
  if (months < 6) return '3-6 months';
  if (months < 12) return '6-12 months';
  return '12+ months';
}
