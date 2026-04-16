import type { PipelineAnalysisResult } from './types.js';
import type {
  ChargebeeSubscription,
  LegacyInvoice,
  SalesforceOpportunity,
  StripePayment,
} from '../ingestion/types.js';
import { normalizeCompanyName } from '../utils/normalization.js';

export type BillingSnapshot = {
  system: 'chargebee' | 'stripe' | 'legacy';
  customerKey: string;
  customerName: string;
  recordId: string;
  monthlyAmount: number;
  annualAmount: number;
  activeStart: string;
  activeEnd: string | null;
};

export type BillingAccountSummary = {
  customerKey: string;
  customerName: string;
  monthlyAmount: number;
  annualAmount: number;
  systems: BillingSnapshot[];
};

type ActiveOpportunitySummary = {
  accountName: string;
  opportunityId: string;
  opportunityIds: string[];
  acv: number;
};

/**
 * CRM pipeline quality analysis.
 *
 * Closed-won CRM amounts are compared to the total active recurring billing
 * footprint for the same account, while preserving source-system detail for
 * drill-down. Billing coverage now includes Stripe, Chargebee, and Legacy.
 *
 * @module reconciliation/pipeline
 */

/** Options for pipeline quality analysis. */
export interface PipelineAnalysisOptions {
  /** Number of days with no activity to flag as zombie. Defaults to 90. */
  zombieThresholdDays?: number;
  /** Tolerance for ACV vs billing amount comparison (as a fraction). Defaults to 0.02 (2%). */
  amountToleranceFraction?: number;
  /** Whether to include closed-lost opportunities in the analysis. Defaults to false. */
  includeClosedLost?: boolean;
  /** Snapshot date used to decide which deals/subscriptions are current. Defaults to latest source date. */
  asOfDate?: Date;
}

export async function analyzePipelineQuality(
  opportunities: SalesforceOpportunity[],
  billingRecords: (ChargebeeSubscription | StripePayment | LegacyInvoice)[],
  options?: PipelineAnalysisOptions,
): Promise<PipelineAnalysisResult> {
  const zombieThresholdDays = options?.zombieThresholdDays ?? 90;
  const tolerance = options?.amountToleranceFraction ?? 0.02;
  const asOfDate = options?.asOfDate ?? getAnalysisDate(opportunities, billingRecords);
  const billingSnapshots = buildBillingSnapshots(billingRecords, asOfDate);
  const billing = summarizeBillingByAccount(billingSnapshots);
  const closedWon = opportunities.filter(
    (opp) => opp.stage.toLowerCase() === 'closed won' && isOpportunityActiveAsOf(opp, asOfDate),
  );
  const crm = summarizeOpportunities(closedWon);
  const openOpportunities = opportunities.filter((opp) =>
    options?.includeClosedLost
      ? opp.stage.toLowerCase() !== 'closed won'
      : !opp.stage.toLowerCase().startsWith('closed'),
  );

  const zombieDeals = openOpportunities
    .map((opp) => ({
      opportunityId: opp.opportunity_id,
      accountName: opp.account_name,
      amount: opp.amount,
      stage: opp.stage,
      daysSinceActivity: diffDays(getLastActivityDate(opp), asOfDate),
    }))
    .filter((deal) => deal.daysSinceActivity >= zombieThresholdDays)
    .sort((a, b) => b.amount - a.amount);

  const mismatches: PipelineAnalysisResult['mismatches'] = [];
  const accountKeys = new Set([...crm.keys(), ...billing.keys()]);
  for (const customerKey of accountKeys) {
    const crmRecord = crm.get(customerKey);
    const billingRecord = billing.get(customerKey);
    const crmValue = Math.round(crmRecord?.acv ?? 0);
    const billingValue = Math.round(billingRecord?.annualAmount ?? 0);
    const base = Math.max(Math.abs(crmValue), Math.abs(billingValue), 1);
    const percentDelta = Number((((billingValue - crmValue) / base) * 100).toFixed(2));

    if (Math.abs(percentDelta) <= tolerance * 100) continue;

    const billingSystems = billingRecord?.systems.map((item) => item.system) ?? [];
    mismatches.push({
      opportunityId: crmRecord?.opportunityId ?? `billing-${customerKey}`,
      accountName: crmRecord?.accountName ?? billingRecord?.customerName ?? customerKey,
      issue:
        crmRecord == null
          ? 'Active billing has no matching closed-won CRM amount'
          : billingRecord == null
            ? 'Closed-won CRM amount has no active billing record'
            : 'Active billing total differs from CRM ACV',
      crmValue,
      billingValue,
      billingSystems,
      percentDelta: Math.abs(percentDelta),
      direction: billingValue > crmValue ? 'over-reporting' : 'under-reporting',
    });
  }

  const unbookedRevenue = Array.from(billing.values())
    .filter((record) => !crm.has(record.customerKey))
    .flatMap((record) =>
      record.systems.map((system) => ({
        subscriptionId: system.recordId,
        customerName: system.customerName,
        mrr: Math.round(system.monthlyAmount),
        system: system.system,
      })),
    )
    .sort((a, b) => b.mrr - a.mrr);

  const totalZombieValue = zombieDeals.reduce((sum, deal) => sum + deal.amount, 0);
  const totalUnbookedMRR = unbookedRevenue.reduce((sum, record) => sum + record.mrr, 0);
  const penalty = zombieDeals.length * 1.5 + mismatches.length * 2 + unbookedRevenue.length * 0.5;

  return {
    zombieDeals,
    mismatches: mismatches.sort((a, b) => Number(billingMagnitude(b) - billingMagnitude(a))),
    unbookedRevenue,
    summary: {
      totalZombieDeals: zombieDeals.length,
      totalZombieValue: Math.round(totalZombieValue),
      totalMismatches: mismatches.length,
      totalUnbookedMRR: Math.round(totalUnbookedMRR),
      pipelineHealthScore: Math.max(0, Math.round(100 - penalty)),
    },
  };
}

export function buildBillingSnapshots(
  billingRecords: (ChargebeeSubscription | StripePayment | LegacyInvoice)[],
  asOfDate: Date,
): BillingSnapshot[] {
  const chargebee = billingRecords.filter(isChargebeeSubscription);
  const stripe = billingRecords.filter(isStripePayment);
  const legacy = billingRecords.filter(isLegacyInvoice);

  const snapshots: BillingSnapshot[] = [
    ...chargebee
      .filter((subscription) => isChargebeeActiveAsOf(subscription, asOfDate))
      .map((subscription) => ({
        system: 'chargebee' as const,
        customerKey: normalizeCompanyName(subscription.customer.company),
        customerName: subscription.customer.company,
        recordId: subscription.subscription_id,
        monthlyAmount: roundMoney(getChargebeeMRR(subscription)),
        annualAmount: roundMoney(getChargebeeMRR(subscription) * 12),
        activeStart: subscription.current_term_start,
        activeEnd: subscription.current_term_end,
      })),
    ...aggregateStripeSnapshots(stripe).filter((snapshot) => isSnapshotActiveAsOf(snapshot, asOfDate)),
    ...aggregateLegacySnapshots(legacy).filter((snapshot) => isSnapshotActiveAsOf(snapshot, asOfDate)),
  ];

  return snapshots.filter((snapshot) => snapshot.monthlyAmount > 0);
}

export function summarizeBillingByAccount(
  snapshots: BillingSnapshot[],
): Map<string, BillingAccountSummary> {
  const summary = new Map<string, BillingAccountSummary>();

  for (const snapshot of snapshots) {
    const existing = summary.get(snapshot.customerKey);
    if (!existing) {
      summary.set(snapshot.customerKey, {
        customerKey: snapshot.customerKey,
        customerName: snapshot.customerName,
        monthlyAmount: snapshot.monthlyAmount,
        annualAmount: snapshot.annualAmount,
        systems: [snapshot],
      });
      continue;
    }

    existing.monthlyAmount = roundMoney(existing.monthlyAmount + snapshot.monthlyAmount);
    existing.annualAmount = roundMoney(existing.annualAmount + snapshot.annualAmount);
    existing.systems.push(snapshot);
  }

  return summary;
}

function summarizeOpportunities(
  opportunities: SalesforceOpportunity[],
): Map<string, ActiveOpportunitySummary> {
  const summary = new Map<string, ActiveOpportunitySummary>();

  for (const opportunity of opportunities) {
    const customerKey = normalizeCompanyName(opportunity.account_name);
    const existing = summary.get(customerKey);
    if (!existing) {
      summary.set(customerKey, {
        accountName: opportunity.account_name,
        opportunityId: opportunity.opportunity_id,
        opportunityIds: [opportunity.opportunity_id],
        acv: Math.round(opportunity.acv),
      });
      continue;
    }

    existing.acv = Math.round(existing.acv + opportunity.acv);
    existing.opportunityIds.push(opportunity.opportunity_id);
  }

  return summary;
}

function billingMagnitude(
  mismatch: PipelineAnalysisResult['mismatches'][number],
): number {
  return Math.max(Math.abs(Number(mismatch.crmValue)), Math.abs(Number(mismatch.billingValue)));
}

function aggregateStripeSnapshots(payments: StripePayment[]): BillingSnapshot[] {
  const grouped = new Map<string, StripePayment[]>();

  for (const payment of payments) {
    if (payment.status === 'failed' || payment.status === 'pending') continue;
    const subscriptionId = payment.subscription_id ?? payment.customer_id;
    const key = `${payment.customer_id}::${subscriptionId}`;
    const group = grouped.get(key) ?? [];
    group.push(payment);
    grouped.set(key, group);
  }

  return Array.from(grouped.values()).map((group) => {
    const sorted = [...group].sort(
      (a, b) => new Date(a.payment_date).getTime() - new Date(b.payment_date).getTime(),
    );
    const latest = sorted[sorted.length - 1]!;
    const positiveAmounts = sorted
      .filter((payment) => payment.status === 'succeeded' && payment.amount > 0)
      .map((payment) => payment.amount);
    const monthlyAmount =
      positiveAmounts.length === 0
        ? 0
        : positiveAmounts.reduce((sum, amount) => sum + amount, 0) / positiveAmounts.length;
    const cycleDays = getMedianGapDays(
      sorted
        .filter((payment) => payment.status === 'succeeded')
        .map((payment) => payment.payment_date),
    );

    return {
      system: 'stripe' as const,
      customerKey: normalizeCompanyName(latest.customer_name),
      customerName: latest.customer_name,
      recordId: latest.subscription_id ?? latest.payment_id,
      monthlyAmount: roundMoney(monthlyAmount),
      annualAmount: roundMoney(monthlyAmount * 12),
      activeStart: sorted[0]!.payment_date,
      activeEnd: addDays(latest.payment_date, cycleDays),
    };
  });
}

function aggregateLegacySnapshots(invoices: LegacyInvoice[]): BillingSnapshot[] {
  const grouped = new Map<string, LegacyInvoice[]>();

  for (const invoice of invoices) {
    if (invoice.status === 'void' || invoice.status === 'unpaid') continue;
    const customerKey = normalizeCompanyName(invoice.customer_name);
    const group = grouped.get(customerKey) ?? [];
    group.push(invoice);
    grouped.set(customerKey, group);
  }

  return Array.from(grouped.entries()).map(([customerKey, group]) => {
    const sorted = [...group].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const latest = sorted[sorted.length - 1]!;
    const positiveAmounts = sorted.map((invoice) => invoice.amount).filter((amount) => amount > 0);
    const monthlyAmount =
      positiveAmounts.length === 0
        ? 0
        : positiveAmounts.reduce((sum, amount) => sum + amount, 0) / positiveAmounts.length;
    const cycleDays = getMedianGapDays(sorted.map((invoice) => invoice.date));

    return {
      system: 'legacy' as const,
      customerKey,
      customerName: latest.customer_name,
      recordId: latest.id,
      monthlyAmount: roundMoney(monthlyAmount),
      annualAmount: roundMoney(monthlyAmount * 12),
      activeStart: sorted[0]!.date,
      activeEnd: addDays(latest.date, cycleDays),
    };
  });
}

function getChargebeeMRR(subscription: ChargebeeSubscription): number {
  const mrrUsd = subscription.metadata['mrr_usd'];
  return typeof mrrUsd === 'number' && Number.isFinite(mrrUsd) ? mrrUsd : subscription.mrr;
}

function isSnapshotActiveAsOf(snapshot: BillingSnapshot, asOfDate: Date): boolean {
  const start = new Date(snapshot.activeStart).getTime();
  const end =
    snapshot.activeEnd == null ? Number.POSITIVE_INFINITY : new Date(snapshot.activeEnd).getTime();
  return start <= asOfDate.getTime() && asOfDate.getTime() <= end;
}

function isChargebeeSubscription(
  value: ChargebeeSubscription | StripePayment | LegacyInvoice,
): value is ChargebeeSubscription {
  return 'subscription_id' in value && 'customer' in value;
}

function isStripePayment(
  value: ChargebeeSubscription | StripePayment | LegacyInvoice,
): value is StripePayment {
  return 'payment_id' in value;
}

function isLegacyInvoice(
  value: ChargebeeSubscription | StripePayment | LegacyInvoice,
): value is LegacyInvoice {
  return 'payment_ref' in value && 'customer_name' in value;
}

function isChargebeeActiveAsOf(subscription: ChargebeeSubscription, asOfDate: Date): boolean {
  return (
    (subscription.status === 'active' || subscription.status === 'non_renewing') &&
    new Date(subscription.current_term_start).getTime() <= asOfDate.getTime() &&
    asOfDate.getTime() <= new Date(subscription.current_term_end).getTime()
  );
}

function isOpportunityActiveAsOf(opportunity: SalesforceOpportunity, asOfDate: Date): boolean {
  const closeDate = new Date(opportunity.close_date);
  const termEnd = new Date(closeDate);
  termEnd.setUTCMonth(termEnd.getUTCMonth() + Math.max(opportunity.contract_term_months, 1));

  return closeDate.getTime() <= asOfDate.getTime() && asOfDate.getTime() <= termEnd.getTime();
}

function getLastActivityDate(opportunity: SalesforceOpportunity): Date {
  const value = opportunity.next_step?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? opportunity.close_date;
  return new Date(value);
}

function getAnalysisDate(
  opportunities: SalesforceOpportunity[],
  billingRecords: (ChargebeeSubscription | StripePayment | LegacyInvoice)[],
): Date {
  const timestamps = [
    ...opportunities.map((opp) => new Date(opp.close_date).getTime()),
    ...billingRecords.map((item) =>
      new Date(
        isChargebeeSubscription(item)
          ? item.current_term_start
          : isStripePayment(item)
            ? item.payment_date
            : item.date,
      ).getTime(),
    ),
  ].filter(Number.isFinite);

  return new Date(Math.max(...timestamps, Date.now()));
}

function getMedianGapDays(dates: string[]): number {
  const sorted = [...dates].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  if (sorted.length < 2) return 30;

  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = diffDays(new Date(sorted[index - 1]!), new Date(sorted[index]!));
    if (gap > 0) gaps.push(gap);
  }

  if (gaps.length === 0) return 30;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 30;
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function diffDays(startDate: Date, endDate: Date): number {
  return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
