import type { PipelineAnalysisResult } from './types.js';
import type { SalesforceOpportunity, ChargebeeSubscription, StripePayment } from '../ingestion/types.js';
import { normalizeCompanyName } from '../utils/normalization.js';

/**
 * CRM pipeline quality analysis.
 *
 * Identifies data quality issues in the Salesforce pipeline by cross-
 * referencing CRM data against billing system data.  Key analyses:
 *
 * - **Zombie deals**: Open opportunities that have had no stage change,
 *   amount update, or close-date change in 90+ days.  These inflate
 *   pipeline value and distort forecasts.
 *
 * - **Stage mismatches**: Opportunities marked as "Closed Won" in
 *   Salesforce but with no corresponding active subscription in the
 *   billing system (or vice versa -- active subscriptions with no
 *   "Closed Won" opportunity).
 *
 * - **Amount discrepancies**: The opportunity ACV in Salesforce differs
 *   significantly from the subscription MRR * 12 in the billing system.
 *
 * - **Unbooked revenue**: Subscriptions in Stripe or Chargebee that
 *   have no matching opportunity in Salesforce, meaning revenue is
 *   being collected but not tracked in the CRM.
 *
 * - **Pipeline-to-billing lag**: Opportunities that were closed recently
 *   but subscription activation is delayed, or subscriptions that were
 *   activated before the opportunity was marked as closed.
 *
 * @module reconciliation/pipeline
 */

/** Options for pipeline quality analysis. */
export interface PipelineAnalysisOptions {
  /** Number of days with no activity to flag as zombie. Defaults to 90. */
  zombieThresholdDays?: number;
  /** Tolerance for ACV vs billing amount comparison (as a fraction). Defaults to 0.10 (10%). */
  amountToleranceFraction?: number;
  /** Whether to include closed-lost opportunities in the analysis. Defaults to false. */
  includeClosedLost?: boolean;
  /** Snapshot date used to decide which deals/subscriptions are current. Defaults to latest source date. */
  asOfDate?: Date;
}

/**
 * Analyze CRM pipeline quality against billing data.
 *
 * @param opportunities - Salesforce opportunity records
 * @param subscriptions - Active subscriptions from billing systems
 * @param options - Analysis options
 * @returns Pipeline quality analysis with zombie deals, mismatches, and unbooked revenue
 */
export async function analyzePipelineQuality(
  opportunities: SalesforceOpportunity[],
  subscriptions: (ChargebeeSubscription | StripePayment)[],
  options?: PipelineAnalysisOptions,
): Promise<PipelineAnalysisResult> {
  const zombieThresholdDays = options?.zombieThresholdDays ?? 90;
  const tolerance = options?.amountToleranceFraction ?? 0.1;
  const asOfDate = options?.asOfDate ?? getAnalysisDate(opportunities, subscriptions);
  const billing = buildBillingIndex(subscriptions, asOfDate);
  const closedWon = opportunities.filter(
    (opp) => opp.stage.toLowerCase() === 'closed won' && isOpportunityActiveAsOf(opp, asOfDate),
  );
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
  for (const opp of closedWon) {
    const billingRecord = billing.byName.get(normalizeCompanyName(opp.account_name));
    if (!billingRecord) {
      mismatches.push({
        opportunityId: opp.opportunity_id,
        accountName: opp.account_name,
        issue: 'Closed-won CRM opportunity has no active billing record',
        crmValue: opp.acv,
        billingValue: 0,
      });
      continue;
    }

    const billingARR = billingRecord.mrr * 12;
    const base = Math.max(Math.abs(opp.acv), Math.abs(billingARR), 1);
    if (Math.abs(opp.acv - billingARR) / base > tolerance) {
      mismatches.push({
        opportunityId: opp.opportunity_id,
        accountName: opp.account_name,
        issue: 'CRM ACV differs from active billing ARR',
        crmValue: Math.round(opp.acv),
        billingValue: Math.round(billingARR),
      });
    }
  }

  const closedWonNames = new Set(closedWon.map((opp) => normalizeCompanyName(opp.account_name)));
  const unbookedRevenue = Array.from(billing.byName.values())
    .filter((record) => !closedWonNames.has(record.customerKey))
    .map((record) => ({
      subscriptionId: record.subscriptionId,
      customerName: record.customerName,
      mrr: Math.round(record.mrr),
      system: record.system,
    }))
    .sort((a, b) => b.mrr - a.mrr);

  const totalZombieValue = zombieDeals.reduce((sum, deal) => sum + deal.amount, 0);
  const totalUnbookedMRR = unbookedRevenue.reduce((sum, record) => sum + record.mrr, 0);
  const penalty = zombieDeals.length * 1.5 + mismatches.length * 2 + unbookedRevenue.length * 0.5;

  return {
    zombieDeals,
    mismatches,
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

type BillingRecord = {
  customerKey: string;
  customerName: string;
  subscriptionId: string;
  mrr: number;
  system: string;
  date: string;
};

function buildBillingIndex(subscriptions: (ChargebeeSubscription | StripePayment)[], asOfDate: Date) {
  const byName = new Map<string, BillingRecord>();

  for (const item of subscriptions) {
    if (!isBillingRecordActiveAsOf(item, asOfDate)) continue;

    const record = isChargebeeSubscription(item)
      ? {
          customerKey: normalizeCompanyName(item.customer.company),
          customerName: item.customer.company,
          subscriptionId: item.subscription_id,
          mrr: item.mrr,
          system: 'chargebee',
          date: item.current_term_start,
        }
      : {
          customerKey: normalizeCompanyName(item.customer_name),
          customerName: item.customer_name,
          subscriptionId: item.subscription_id ?? item.payment_id,
          mrr: item.status === 'succeeded' ? item.amount : 0,
          system: 'stripe',
          date: item.payment_date,
        };

    if (record.mrr <= 0) continue;
    const existing = byName.get(record.customerKey);
    if (!existing || record.mrr > existing.mrr) byName.set(record.customerKey, record);
  }

  return { byName };
}

function isChargebeeSubscription(
  value: ChargebeeSubscription | StripePayment,
): value is ChargebeeSubscription {
  return 'subscription_id' in value && 'customer' in value;
}

function isBillingRecordActiveAsOf(
  value: ChargebeeSubscription | StripePayment,
  asOfDate: Date,
): boolean {
  if (isChargebeeSubscription(value)) {
    return (
      (value.status === 'active' || value.status === 'non_renewing') &&
      new Date(value.current_term_start).getTime() <= asOfDate.getTime() &&
      asOfDate.getTime() <= new Date(value.current_term_end).getTime()
    );
  }

  if (value.status !== 'succeeded') return false;
  const paymentDate = new Date(value.payment_date);
  const activeUntil = new Date(paymentDate);
  activeUntil.setUTCDate(activeUntil.getUTCDate() + 45);
  return paymentDate.getTime() <= asOfDate.getTime() && asOfDate.getTime() <= activeUntil.getTime();
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
  subscriptions: (ChargebeeSubscription | StripePayment)[],
): Date {
  const timestamps = [
    ...opportunities.map((opp) => new Date(opp.close_date).getTime()),
    ...subscriptions.map((item) =>
      new Date(isChargebeeSubscription(item) ? item.current_term_start : item.payment_date).getTime(),
    ),
  ].filter(Number.isFinite);
  return new Date(Math.max(...timestamps, Date.now()));
}

function diffDays(startDate: Date, endDate: Date): number {
  return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000));
}
