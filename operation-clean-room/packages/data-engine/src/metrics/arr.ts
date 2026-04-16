import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ARRResult,
  MetricOptions,
  MonthlyRevenueSummary,
  RevenueSummaryResult,
  RevenueTimingIssue,
} from './types.js';
import { loadChargebeeSubscriptions } from '../ingestion/chargebee.js';
import { loadSalesforceData } from '../ingestion/salesforce.js';
import { loadStripePayments } from '../ingestion/stripe.js';
import { loadLegacyInvoices } from '../ingestion/legacy.js';
import type {
  ChargebeeSubscription,
  LegacyInvoice,
  SalesforceAccount,
  StripePayment,
} from '../ingestion/types.js';
import { detectDuplicates } from '../reconciliation/deduplication.js';
import { normalizeCompanyName } from '../utils/normalization.js';

export type ARRSource = 'chargebee' | 'stripe' | 'legacy';

export type UnifiedARRRecord = {
  source: ARRSource;
  customerKey: string;
  companyName: string;
  planName: string;
  arr: number;
  startDate: string;
  endDate: string | null;
  account: SalesforceAccount | null;
  sourceRecordId: string;
};

type StripeSubscriptionRecord = {
  customerId: string;
  customerName: string;
  subscriptionId: string;
  startDate: string;
  endDate: string;
  arr: number;
  planName: string;
};

type LegacyRecurringRecord = {
  customerName: string;
  customerKey: string;
  startDate: string;
  endDate: string;
  arr: number;
  planName: string;
  sourceRecordId: string;
  hasStripeReference: boolean;
};

function getDefaultDataDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, '../../../../data');
}

export async function getDefaultARRAsOfDate(): Promise<Date> {
  const subscriptions = await loadChargebeeSubscriptions(getDefaultDataDir());
  const activeDates = subscriptions
    .filter(
      (subscription) =>
        subscription.status === 'active' ||
        subscription.status === 'non_renewing' ||
        subscription.status === 'in_trial',
    )
    .map((subscription) => new Date(subscription.current_term_start).getTime())
    .filter((timestamp) => Number.isFinite(timestamp));

  if (activeDates.length === 0) {
    return new Date();
  }

  return new Date(Math.max(...activeDates));
}

function sortDateStrings(dates: string[]): string[] {
  return [...dates].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
}

function diffDays(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getMedianGapDays(dates: string[]): number {
  const sortedDates = sortDateStrings(dates);
  if (sortedDates.length < 2) {
    return 30;
  }

  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    const gap = diffDays(sortedDates[i - 1]!, sortedDates[i]!);
    if (gap > 0) gaps.push(gap);
  }

  if (gaps.length === 0) return 30;

  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 30;
}

function parsePlanName(value: string | null | undefined): string {
  const normalized = (value ?? '').toLowerCase();
  if (normalized.includes('enterprise')) return 'Enterprise';
  if (normalized.includes('scale')) return 'Scale';
  if (normalized.includes('growth') || normalized.includes('platform')) return 'Growth';
  if (normalized.includes('starter') || normalized.includes('basic')) return 'Starter';
  if (normalized.includes('meridian')) return 'Meridian Legacy';
  return 'Unknown';
}

function inferStripePlanName(payments: StripePayment[]): string {
  for (let i = payments.length - 1; i >= 0; i--) {
    const payment = payments[i]!;
    const planName = parsePlanName(payment.description);
    if (planName !== 'Unknown') {
      return planName;
    }
  }

  return 'Unknown';
}

function buildAccountIndex(accounts: SalesforceAccount[]): Map<string, SalesforceAccount> {
  const index = new Map<string, SalesforceAccount>();

  for (const account of accounts) {
    const key = normalizeCompanyName(account.account_name);
    if (!index.has(key)) {
      index.set(key, account);
    }
  }

  return index;
}

function isWithinDateRange(
  startDate: string,
  endDate: string | null,
  asOfDate: Date,
): boolean {
  const asOf = asOfDate.getTime();
  const start = new Date(startDate).getTime();
  const end = endDate == null ? Number.POSITIVE_INFINITY : new Date(endDate).getTime();

  if (Number.isNaN(start) || Number.isNaN(end)) {
    return false;
  }

  return start <= asOf && asOf <= end;
}

function shouldIncludeChargebeeSubscription(
  subscription: ChargebeeSubscription,
  asOfDate: Date,
  options?: MetricOptions,
): boolean {
  const excludeTrials = options?.excludeTrials ?? true;
  const excludeChurned = options?.excludeChurned ?? true;

  if (!isWithinDateRange(subscription.current_term_start, subscription.current_term_end, asOfDate)) {
    return false;
  }

  if (excludeTrials && subscription.status === 'in_trial') {
    return false;
  }

  if (excludeChurned && subscription.status === 'cancelled') {
    return false;
  }

  return subscription.status !== 'paused' && subscription.status !== 'future';
}

function getChargebeeARR(subscription: ChargebeeSubscription): number {
  const mrrUsd = subscription.metadata['mrr_usd'];
  const monthlyRevenue =
    typeof mrrUsd === 'number' && Number.isFinite(mrrUsd) ? mrrUsd : subscription.mrr;

  return Math.round(monthlyRevenue * 12);
}

function aggregateStripeSubscriptions(payments: StripePayment[]): StripeSubscriptionRecord[] {
  const grouped = new Map<string, StripePayment[]>();

  for (const payment of payments) {
    if (payment.status === 'failed') continue;

    const subscriptionId = payment.subscription_id ?? payment.customer_id;
    const key = `${payment.customer_id}::${subscriptionId}`;
    const group = grouped.get(key) ?? [];
    group.push(payment);
    grouped.set(key, group);
  }

  return Array.from(grouped.values()).map((group) => {
    const sortedPayments = [...group].sort(
      (a, b) => new Date(a.payment_date).getTime() - new Date(b.payment_date).getTime(),
    );
    const latest = sortedPayments[sortedPayments.length - 1]!;
    const cycleDays = getMedianGapDays(sortedPayments.map((payment) => payment.payment_date));
    const positiveAmounts = sortedPayments.map((payment) => payment.amount).filter((amount) => amount > 0);

    return {
      customerId: latest.customer_id,
      customerName: latest.customer_name,
      subscriptionId: latest.subscription_id ?? latest.customer_id,
      startDate: sortedPayments[0]!.payment_date,
      endDate: addDays(latest.payment_date, cycleDays),
      arr:
        positiveAmounts.length === 0
          ? 0
          : Math.round((positiveAmounts.reduce((sum, amount) => sum + amount, 0) / positiveAmounts.length) * 12),
      planName: inferStripePlanName(sortedPayments),
    };
  });
}

function aggregateLegacyRecurringRevenue(invoices: LegacyInvoice[]): LegacyRecurringRecord[] {
  const grouped = new Map<string, LegacyInvoice[]>();

  for (const invoice of invoices) {
    if (invoice.status === 'void' || invoice.status === 'unpaid') continue;

    const key = normalizeCompanyName(invoice.customer_name);
    const group = grouped.get(key) ?? [];
    group.push(invoice);
    grouped.set(key, group);
  }

  return Array.from(grouped.entries()).map(([customerKey, group]) => {
    const sortedInvoices = [...group].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    const latest = sortedInvoices[sortedInvoices.length - 1]!;
    const cycleDays = getMedianGapDays(sortedInvoices.map((invoice) => invoice.date));
    const positiveAmounts = sortedInvoices.map((invoice) => invoice.amount).filter((amount) => amount > 0);

    return {
      customerName: latest.customer_name,
      customerKey,
      startDate: sortedInvoices[0]!.date,
      endDate: addDays(latest.date, cycleDays),
      arr:
        positiveAmounts.length === 0
          ? 0
          : Math.round((positiveAmounts.reduce((sum, amount) => sum + amount, 0) / positiveAmounts.length) * 12),
      planName: parsePlanName(latest.description),
      sourceRecordId: latest.id,
      hasStripeReference: sortedInvoices.some((invoice) => invoice.payment_ref != null),
    };
  });
}

function buildBreakdown(
  records: UnifiedARRRecord[],
  labelFn: (record: UnifiedARRRecord) => string,
  totalARR: number,
) {
  const groups = new Map<string, UnifiedARRRecord[]>();

  for (const record of records) {
    const label = labelFn(record);
    const existing = groups.get(label) ?? [];
    existing.push(record);
    groups.set(label, existing);
  }

  return Array.from(groups.entries())
    .map(([label, groupedRecords]) => {
      const arr = groupedRecords.reduce((sum, record) => sum + record.arr, 0);
      return {
        label,
        arr,
        customerCount: new Set(groupedRecords.map((record) => record.customerKey)).size,
        percentOfTotal: totalARR === 0 ? 0 : Number(((arr / totalARR) * 100).toFixed(2)),
      };
    })
    .sort((a, b) => b.arr - a.arr);
}

export async function getUnifiedARRRecords(
  date: Date,
  options?: MetricOptions,
): Promise<UnifiedARRRecord[]> {
  const dataDir = getDefaultDataDir();
  const [chargebeeSubscriptions, stripePayments, legacyInvoices, [, salesforceAccounts]] =
    await Promise.all([
      loadChargebeeSubscriptions(dataDir),
      loadStripePayments(dataDir),
      loadLegacyInvoices(dataDir),
      loadSalesforceData(dataDir),
    ]);

  const duplicates = await detectDuplicates(stripePayments, chargebeeSubscriptions, {
    includeCancelled: false,
  });
  const duplicateStripeSubscriptionIds = new Set(
    duplicates
      .filter((duplicate) => duplicate.classification === 'true_duplicate')
      .map((duplicate) => duplicate.stripeRecord.subscriptionId),
  );

  const accountIndex = buildAccountIndex(salesforceAccounts);

  const chargebeeRecords: UnifiedARRRecord[] = chargebeeSubscriptions
    .filter((subscription) => shouldIncludeChargebeeSubscription(subscription, date, options))
    .map((subscription) => ({
      source: 'chargebee' as const,
      customerKey: normalizeCompanyName(subscription.customer.company),
      companyName: subscription.customer.company,
      planName: parsePlanName(subscription.plan.plan_name),
      arr: getChargebeeARR(subscription),
      startDate: subscription.current_term_start,
      endDate: subscription.current_term_end,
      account: accountIndex.get(normalizeCompanyName(subscription.customer.company)) ?? null,
      sourceRecordId: subscription.subscription_id,
    }));

  const activeChargebeeCustomerKeys = new Set(chargebeeRecords.map((record) => record.customerKey));

  const stripeRecords: UnifiedARRRecord[] = aggregateStripeSubscriptions(stripePayments)
    .filter((subscription) => !duplicateStripeSubscriptionIds.has(subscription.subscriptionId))
    .filter((subscription) => isWithinDateRange(subscription.startDate, subscription.endDate, date))
    .map((subscription) => ({
      source: 'stripe' as const,
      customerKey: normalizeCompanyName(subscription.customerName),
      companyName: subscription.customerName,
      planName: subscription.planName,
      arr: subscription.arr,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      account: accountIndex.get(normalizeCompanyName(subscription.customerName)) ?? null,
      sourceRecordId: subscription.subscriptionId,
    }));

  const activeStripeCustomerKeys = new Set(stripeRecords.map((record) => record.customerKey));

  const legacyRecords: UnifiedARRRecord[] = aggregateLegacyRecurringRevenue(legacyInvoices)
    .filter((record) => isWithinDateRange(record.startDate, record.endDate, date))
    .filter((record) => !record.hasStripeReference)
    .filter((record) => !activeChargebeeCustomerKeys.has(record.customerKey))
    .filter((record) => !activeStripeCustomerKeys.has(record.customerKey))
    .map((record) => ({
      source: 'legacy' as const,
      customerKey: record.customerKey,
      companyName: record.customerName,
      planName: record.planName,
      arr: record.arr,
      startDate: record.startDate,
      endDate: record.endDate,
      account: accountIndex.get(record.customerKey) ?? null,
      sourceRecordId: record.sourceRecordId,
    }));

  return [...chargebeeRecords, ...stripeRecords, ...legacyRecords].filter(
    (record) => record.arr > 0,
  );
}

/**
 * Annual Recurring Revenue (ARR) calculation.
 *
 * ARR is the annualized value of all active recurring subscriptions.
 * Calculation must handle several edge cases:
 *
 * - **Trials**: Subscriptions in trial status should be excluded by default
 *   (configurable via options).  Trials that convert mid-month need careful
 *   handling -- the ARR should reflect only the post-conversion period.
 *
 * - **Multi-year deals**: Some subscriptions are billed annually or multi-
 *   annually.  The ARR for a 2-year deal at $24,000 is $12,000 (annualized),
 *   not $24,000.  Use the plan's billing period to normalize.
 *
 * - **Prorations**: Mid-month plan changes create prorated invoices.  ARR
 *   should reflect the *current* plan rate, not the prorated amount.
 *
 * - **FX conversion**: Non-USD subscriptions must be converted using the
 *   FX rate as of the calculation date.  This means ARR can fluctuate even
 *   with no subscription changes if exchange rates move.
 *
 * - **Addons**: Recurring addons contribute to ARR and should be included.
 *
 * - **Discounts**: Active coupons reduce the effective ARR.  Expired coupons
 *   mean the customer's ARR increases to the list price.
 *
 * - **Paused subscriptions**: Typically excluded from ARR but may be included
 *   if the pause is temporary and the customer is expected to resume.
 *
 * @param date - The as-of date for the ARR calculation
 * @param options - Calculation options (segmentation, exclusions, etc.)
 * @returns ARR result with total and breakdowns
 */
export async function calculateARR(
  date: Date,
  options?: MetricOptions,
): Promise<ARRResult> {
  const unifiedRecords = await getUnifiedARRRecords(date, options);

  const total = unifiedRecords.reduce((sum, record) => sum + record.arr, 0);
  const arrValues = unifiedRecords.map((record) => record.arr).sort((a, b) => a - b);
  const totalCustomers = new Set(unifiedRecords.map((record) => record.customerKey)).size;
  const medianARRPerCustomer =
    arrValues.length === 0
      ? 0
      : arrValues.length % 2 === 1
        ? arrValues[Math.floor(arrValues.length / 2)]!
        : Math.round(
            (arrValues[arrValues.length / 2 - 1]! + arrValues[arrValues.length / 2]!) / 2,
          );

  return {
    total,
    bySegment: buildBreakdown(unifiedRecords, (record) => record.account?.segment ?? 'unmapped', total),
    byPlan: buildBreakdown(unifiedRecords, (record) => record.planName, total),
    byRegion: buildBreakdown(
      unifiedRecords,
      (record) => record.account?.billing_country ?? 'unmapped',
      total,
    ),
    byCohort: buildBreakdown(unifiedRecords, (record) => record.startDate.slice(0, 7), total),
    asOfDate: date.toISOString(),
    totalCustomers,
    avgARRPerCustomer: totalCustomers === 0 ? 0 : Math.round(total / totalCustomers),
    medianARRPerCustomer,
  };
}

function getMonthEnd(month: string): Date {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, monthNumber!, 0, 23, 59, 59));
}

function getMonthStart(month: string): Date {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, monthNumber! - 1, 1));
}

function formatMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function summarizeByCustomer(records: UnifiedARRRecord[]): Map<string, { arr: number; firstSeen: string }> {
  const summary = new Map<string, { arr: number; firstSeen: string }>();

  for (const record of records) {
    const current = summary.get(record.customerKey);
    summary.set(record.customerKey, {
      arr: (current?.arr ?? 0) + record.arr,
      firstSeen:
        current == null || new Date(record.startDate) < new Date(current.firstSeen)
          ? record.startDate
          : current.firstSeen,
    });
  }

  return summary;
}

function calculateMonthlyMovements(
  month: string,
  currentRecords: UnifiedARRRecord[],
  previousRecords: UnifiedARRRecord[],
): Pick<MonthlyRevenueSummary, 'newBusiness' | 'expansion' | 'contraction' | 'churn'> {
  const current = summarizeByCustomer(currentRecords);
  const previous = summarizeByCustomer(previousRecords);
  const allCustomerKeys = new Set([...current.keys(), ...previous.keys()]);
  const monthStart = getMonthStart(month).getTime();
  let newBusiness = 0;
  let expansion = 0;
  let contraction = 0;
  let churn = 0;

  for (const customerKey of allCustomerKeys) {
    const currentCustomer = current.get(customerKey);
    const previousCustomer = previous.get(customerKey);
    const currentARR = currentCustomer?.arr ?? 0;
    const previousARR = previousCustomer?.arr ?? 0;
    const delta = currentARR - previousARR;

    if (previousARR === 0 && currentCustomer != null) {
      const firstSeen = new Date(currentCustomer.firstSeen).getTime();
      if (firstSeen >= monthStart) {
        newBusiness += currentARR;
      } else {
        expansion += currentARR;
      }
    } else if (currentARR === 0 && previousARR > 0) {
      churn += previousARR;
    } else if (delta > 0) {
      expansion += delta;
    } else if (delta < 0) {
      contraction += Math.abs(delta);
    }
  }

  return { newBusiness, expansion, contraction, churn };
}

async function detectRevenueTimingIssues(asOfDate: Date): Promise<RevenueTimingIssue[]> {
  const dataDir = getDefaultDataDir();
  const [chargebeeSubscriptions, stripePayments, legacyInvoices] = await Promise.all([
    loadChargebeeSubscriptions(dataDir),
    loadStripePayments(dataDir),
    loadLegacyInvoices(dataDir),
  ]);
  const issues: RevenueTimingIssue[] = [];

  for (const subscription of chargebeeSubscriptions) {
    if (
      subscription.plan.billing_period_unit === 'year' &&
      shouldIncludeChargebeeSubscription(subscription, asOfDate)
    ) {
      issues.push({
        id: subscription.subscription_id,
        source: 'chargebee',
        customerName: subscription.customer.company,
        description: 'Annual prepayment should not be treated as one month of earned revenue.',
        amount: getChargebeeARR(subscription),
        date: subscription.current_term_start,
        severity: 'medium',
      });
    }
  }

  for (const payment of stripePayments) {
    if (payment.status === 'refunded' || payment.status === 'disputed') {
      issues.push({
        id: payment.payment_id,
        source: 'stripe',
        customerName: payment.customer_name,
        description: `${payment.status} payment should be reviewed before inclusion in recognized revenue.`,
        amount: Math.abs(payment.amount),
        date: payment.payment_date,
        severity: payment.status === 'disputed' ? 'high' : 'medium',
      });
    }
  }

  for (const invoice of legacyInvoices) {
    if (invoice.status === 'overdue' || invoice.status === 'partially_paid') {
      issues.push({
        id: invoice.id,
        source: 'legacy',
        customerName: invoice.customer_name,
        description: `${invoice.status.replace('_', ' ')} legacy invoice may have collection timing risk.`,
        amount: invoice.amount,
        date: invoice.date,
        severity: invoice.status === 'overdue' ? 'high' : 'medium',
      });
    }
  }

  return issues
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
      return Math.abs(b.amount) - Math.abs(a.amount);
    })
    .slice(0, 12);
}

export async function calculateRevenueSummary(options?: {
  startMonth?: string;
  endMonth?: string;
  excludeTrials?: boolean;
}): Promise<RevenueSummaryResult> {
  const defaultAsOf = await getDefaultARRAsOfDate();
  const startMonth = options?.startMonth ?? '2024-01';
  const endMonth = options?.endMonth ?? formatMonth(defaultAsOf);
  const metricOptions: MetricOptions = {
    excludeTrials: options?.excludeTrials ?? true,
    excludeChurned: true,
  };
  const monthly: MonthlyRevenueSummary[] = [];
  let previousRecords: UnifiedARRRecord[] = [];
  let cursor = getMonthStart(startMonth);
  const finalMonth = getMonthStart(endMonth);

  while (cursor.getTime() <= finalMonth.getTime()) {
    const month = formatMonth(cursor);
    const records = await getUnifiedARRRecords(getMonthEnd(month), metricOptions);
    const arr = records.reduce((sum, record) => sum + record.arr, 0);
    const movements = calculateMonthlyMovements(month, records, previousRecords);

    monthly.push({
      month,
      arr,
      mrrRunRate: Math.round(arr / 12),
      ...movements,
      customerCount: new Set(records.map((record) => record.customerKey)).size,
      byPlan: buildBreakdown(records, (record) => record.planName, arr),
    });

    previousRecords = records;
    cursor = addMonths(cursor, 1);
  }

  const currentARR = await calculateARR(getMonthEnd(endMonth), metricOptions);
  const timingIssues = await detectRevenueTimingIssues(getMonthEnd(endMonth));

  return {
    asOfDate: currentARR.asOfDate,
    currentARR,
    monthly,
    planMix: currentARR.byPlan,
    timingIssues,
  };
}
