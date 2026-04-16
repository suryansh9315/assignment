import type { CohortData, MetricOptions } from './types.js';
import { getDefaultARRAsOfDate, getUnifiedARRRecords } from './arr.js';
import type { UnifiedARRRecord } from './arr.js';

/**
 * Cohort retention analysis.
 *
 * Groups customers by their signup month and tracks how their revenue
 * and engagement change over time.  This is one of the most important
 * analyses for understanding long-term business health.
 *
 * How it works:
 * 1. **Define cohorts**: Group all customers by the month they first became
 *    paying customers (i.e., their trial-to-paid conversion date or first
 *    payment date, NOT the trial start date).
 *
 * 2. **Track revenue retention**: For each cohort, calculate what percentage
 *    of their Month 0 revenue is retained in Month 1, Month 2, etc.
 *    - Values above 100% indicate net expansion (the cohort is growing).
 *    - A "smile" curve (dips then recovers) is a positive signal.
 *
 * 3. **Track logo retention**: Same as revenue retention but counting
 *    customers instead of dollars.  Logo retention is always <= 100%.
 *
 * Key considerations:
 * - **Incomplete cohorts**: The most recent cohort will have fewer data
 *   points.  Don't show Month 12 retention for a cohort that's only
 *   3 months old.
 *
 * - **Reactivations**: A customer who churns and returns should appear in
 *   their original cohort, with the churned months showing as 0% retention
 *   and the return month showing the revival.
 *
 * - **FX normalization**: Use a consistent FX rate (e.g., the rate at cohort
 *   creation) to avoid FX-driven retention fluctuations.
 *
 * - **Segmented cohorts**: Optionally break down cohorts by plan, segment,
 *   or acquisition channel for more granular insights.
 *
 * @param options - Calculation options including date range and segmentation
 * @returns Array of cohort data, one entry per cohort month
 */
export async function buildCohortAnalysis(
  options?: MetricOptions,
): Promise<CohortData[]> {
  const endDate = options?.endDate ?? getLastCompleteMonthEnd(await getDefaultARRAsOfDate());
  const startDate = options?.startDate ?? new Date(Date.UTC(2024, 0, 31, 23, 59, 59));
  const snapshots = new Map<string, Awaited<ReturnType<typeof getUnifiedARRRecords>>>();
  let cursor = monthStart(startDate);
  const final = monthStart(endDate);

  while (cursor.getTime() <= final.getTime()) {
    const month = formatMonth(cursor);
    snapshots.set(month, await getUnifiedARRRecords(monthEnd(month), options));
    cursor = addMonths(cursor, 1);
  }

  const firstSeen = new Map<string, { month: string; name: string; arr: number }>();
  for (const [month, records] of snapshots.entries()) {
    const customers = summarize(records);
    for (const [customerKey, customer] of customers.entries()) {
      if (!firstSeen.has(customerKey)) {
        firstSeen.set(customerKey, { month, name: customer.name, arr: customer.arr });
      }
    }
  }

  const cohortMonths = [...new Set(Array.from(firstSeen.values()).map((item) => item.month))].sort();
  return cohortMonths.map((cohortMonth) => {
    const members = Array.from(firstSeen.entries()).filter(([, item]) => item.month === cohortMonth);
    const startingRevenue = members.reduce((sum, [, item]) => sum + item.arr, 0);
    const retention: number[] = [];
    const customerRetention: number[] = [];

    for (const month of snapshots.keys()) {
      if (month < cohortMonth) continue;
      const customers = summarize(snapshots.get(month)!);
      const retainedRevenue = members.reduce(
        (sum, [customerKey]) => sum + (customers.get(customerKey)?.arr ?? 0),
        0,
      );
      const retainedCustomers = members.filter(([customerKey]) => (customers.get(customerKey)?.arr ?? 0) > 0).length;
      retention.push(startingRevenue === 0 ? 0 : Number(((retainedRevenue / startingRevenue) * 100).toFixed(1)));
      customerRetention.push(
        members.length === 0 ? 0 : Number(((retainedCustomers / members.length) * 100).toFixed(1)),
      );
    }

    const latestRevenue = retention.length === 0 ? 0 : (retention[retention.length - 1]! / 100) * startingRevenue;
    const latestCustomers =
      customerRetention.length === 0
        ? 0
        : Math.round((customerRetention[customerRetention.length - 1]! / 100) * members.length);

    return {
      cohortMonth,
      customers: members.length,
      revenue: Math.round(startingRevenue),
      retention,
      customerRetention,
      avgRevenueAtSignup: members.length === 0 ? 0 : Math.round(startingRevenue / members.length),
      avgRevenueLatest: latestCustomers === 0 ? 0 : Math.round(latestRevenue / latestCustomers),
    };
  });
}

function summarize(records: Awaited<ReturnType<typeof getUnifiedARRRecords>>) {
  const grouped = new Map<
    string,
    {
      name: string;
      bySource: Map<UnifiedARRRecord['source'], number>;
    }
  >();

  for (const record of records) {
    const current = grouped.get(record.customerKey) ?? {
      name: record.companyName,
      bySource: new Map<UnifiedARRRecord['source'], number>(),
    };
    current.bySource.set(record.source, (current.bySource.get(record.source) ?? 0) + record.arr);
    grouped.set(record.customerKey, current);
  }

  const summary = new Map<string, { name: string; arr: number }>();
  for (const [customerKey, customer] of grouped.entries()) {
    summary.set(customerKey, {
      name: customer.name,
      arr: getPreferredARR(customer.bySource),
    });
  }

  return summary;
}

function getPreferredARR(bySource: Map<UnifiedARRRecord['source'], number>): number {
  const chargebee = bySource.get('chargebee');
  if (chargebee != null && chargebee > 0) return chargebee;

  const stripe = bySource.get('stripe');
  if (stripe != null && stripe > 0) return stripe;

  return bySource.get('legacy') ?? 0;
}

function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function monthEnd(month: string): Date {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, monthNumber!, 0, 23, 59, 59));
}

function formatMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function getLastCompleteMonthEnd(date: Date): Date {
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59));
  if (date.getUTCDate() === monthEnd.getUTCDate()) {
    return monthEnd;
  }

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0, 23, 59, 59));
}
