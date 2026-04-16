import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCSV } from '../ingestion/csv-loader.js';
import { loadJSONL } from '../ingestion/json-loader.js';
import { loadChargebeeSubscriptions } from '../ingestion/chargebee.js';
import { loadSalesforceData } from '../ingestion/salesforce.js';
import { loadStripePayments } from '../ingestion/stripe.js';
import type { ChargebeeSubscription, ProductEvent } from '../ingestion/types.js';
import { normalizeCompanyName } from '../utils/normalization.js';
import { RiskLevel, type HealthScore, type HealthScoringOptions, type HealthSignal } from './types.js';

/**
 * Multi-signal customer health scoring model.
 *
 * Combines product usage, support sentiment, billing health, NPS, and
 * engagement trends into a single composite score (0-100) for each
 * customer account.
 *
 * Signal definitions:
 *
 * 1. **Product Usage** (default weight: 0.30)
 *    - Days active in last 30 days (DAU/MAU ratio)
 *    - Number of unique features used
 *    - Key feature engagement (API, integrations, exports)
 *    - Trend: increasing, stable, or declining
 *
 * 2. **Support Sentiment** (default weight: 0.20)
 *    - Number of open tickets (more = worse)
 *    - Average satisfaction rating on resolved tickets
 *    - Ticket severity distribution (many urgent tickets = bad)
 *    - Time since last ticket (very long = either great or disengaged)
 *
 * 3. **Billing Health** (default weight: 0.20)
 *    - Payment failure rate in last 90 days
 *    - Outstanding invoices / overdue amounts
 *    - Involuntary churn signals (card expiry, repeated failures)
 *    - Discount dependency (high discount = risk at renewal)
 *
 * 4. **NPS Score** (default weight: 0.15)
 *    - Most recent NPS response (promoter/passive/detractor)
 *    - NPS trend over time
 *    - Recency of last response (stale NPS is less reliable)
 *
 * 5. **Engagement Trend** (default weight: 0.15)
 *    - Login frequency trend (last 30 vs prior 30 days)
 *    - Feature breadth trend
 *    - Stakeholder breadth (number of unique users)
 *    - Executive sponsor engagement
 *
 * The final score is computed as:
 *   score = SUM(signal.weight * signal.value) / SUM(signal.weight)
 *
 * Risk levels are derived from the composite score:
 *   - 80-100: LOW risk
 *   - 50-79:  MEDIUM risk
 *   - 25-49:  HIGH risk
 *   - 0-24:   CRITICAL risk
 *
 * @param options - Scoring options (weight overrides, filters, etc.)
 * @returns Array of health scores, one per qualifying account
 */
export async function calculateHealthScores(
  options?: HealthScoringOptions,
): Promise<HealthScore[]> {
  const dataDir = getDataDir();
  const [subscriptions, stripePayments, [, accounts], supportTickets, npsResponses, productEvents] =
    await Promise.all([
      loadChargebeeSubscriptions(dataDir),
      loadStripePayments(dataDir),
      loadSalesforceData(dataDir),
      loadSupportTickets(dataDir),
      loadNpsResponses(dataDir),
      loadJSONL<ProductEvent>(join(dataDir, 'product_events.jsonl')),
    ]);

  const referenceDates = getDatasetReferenceDates({
    subscriptions,
    stripePayments,
    supportTickets,
    npsResponses,
    productEvents,
  });
  const asOfDate = referenceDates.overall;
  const trendWindowDays = options?.trendWindowDays ?? 30;
  const currentWindowStart = shiftDays(referenceDates.product, -(trendWindowDays - 1));
  const previousWindowStart = shiftDays(currentWindowStart, -trendWindowDays);
  const previousWindowEnd = shiftDays(currentWindowStart, -1);
  const supportWindowStart = shiftDays(referenceDates.support, -89);
  const billingWindowStart = shiftDays(referenceDates.billing, -89);
  const normalizedWeights = getWeights(options?.weights);
  const subscriptionsByAccount = buildSubscriptionIndex(subscriptions, accounts);
  const stripePaymentsByAccount = buildStripePaymentIndex(stripePayments, accounts);
  const supportByAccount = groupBy(
    supportTickets,
    (ticket) => ticket.accountId,
    (ticket) => ticket.accountId !== null,
  );
  const npsByAccount = groupBy(
    npsResponses,
    (response) => response.accountId,
    (response) => response.accountId !== null,
  );
  const usageCurrent = aggregateUsage(productEvents, currentWindowStart, asOfDate);
  const usagePrevious = aggregateUsage(productEvents, previousWindowStart, previousWindowEnd);

  const results: HealthScore[] = [];

  for (const account of accounts) {
    const subscription = subscriptionsByAccount.get(account.account_id) ?? null;
    const currentMrr = subscription?.mrr ?? Math.max(0, account.annual_revenue / 12);
    if (currentMrr < (options?.minMRR ?? 0)) continue;
    if (options?.segments?.length && !options.segments.includes(account.segment)) continue;

    const currentUsage = usageCurrent.get(account.account_id) ?? emptyUsageSummary(account.account_id);
    const previousUsage = usagePrevious.get(account.account_id) ?? emptyUsageSummary(account.account_id);
    const accountSupport = supportByAccount.get(account.account_id) ?? [];
    const accountNps = npsByAccount.get(account.account_id) ?? [];
    const accountPayments = stripePaymentsByAccount.get(account.account_id) ?? [];

    const usageSignal = buildUsageSignal(currentUsage, previousUsage, normalizedWeights.productUsage);
    const engagementSignal = buildEngagementSignal(
      currentUsage,
      previousUsage,
      account.employee_count,
      normalizedWeights.engagement,
      referenceDates.product,
    );
    const supportSignal = buildSupportSignal(
      accountSupport,
      supportWindowStart,
      referenceDates.support,
      normalizedWeights.supportSentiment,
    );
    const billingSignal = buildBillingSignal(
      accountPayments,
      subscription,
      billingWindowStart,
      referenceDates.billing,
      normalizedWeights.billingHealth,
    );
    const npsSignal = buildNpsSignal(accountNps, referenceDates.nps, normalizedWeights.nps);
    const signals = [usageSignal, supportSignal, billingSignal, npsSignal, engagementSignal];
    const weightedSum = signals.reduce((sum, signal) => sum + signal.value * signal.weight, 0);
    const totalWeight = signals.reduce((sum, signal) => sum + signal.weight, 0);
    const score = totalWeight === 0 ? 0 : Math.round(weightedSum / totalWeight);
    const riskLevel = deriveRiskLevel(score);

    results.push({
      accountId: account.account_id,
      accountName: account.account_name,
      score,
      signals,
      riskLevel,
      lastUpdated: asOfDate.toISOString(),
      mrr: round2(currentMrr),
      plan: subscription?.plan.plan_name ?? 'Unmapped',
      segment: account.segment,
      daysUntilRenewal: subscription
        ? getDaysUntil(new Date(subscription.current_term_end), referenceDates.billing)
        : null,
      riskSummary: buildRiskSummary(signals, riskLevel),
    });
  }

  return results.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return b.mrr - a.mrr;
  });
}

type WeightConfig = Required<NonNullable<HealthScoringOptions['weights']>>;

type RawSupportTicket = {
  ticket_id: string;
  account_id?: string;
  account_name: string;
  category?: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'pending' | 'resolved' | 'closed';
  created_at: string;
  resolved_at?: string;
  csat_score?: string;
  escalated?: string;
  tags?: string;
};

type SupportTicketRecord = {
  accountId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'pending' | 'resolved' | 'closed';
  csatScore: number | null;
  escalated: boolean;
};

type RawNpsResponse = {
  survey_id: string;
  account_id?: string;
  respondent_email: string;
  score: string;
  comment?: string;
  survey_date: string;
};

type NpsResponseRecord = {
  accountId: string | null;
  score: number;
  surveyDate: string;
};

type UsageSummary = {
  accountId: string;
  totalEvents: number;
  uniqueUsers: number;
  uniqueFeatures: number;
  daysActive: number;
  keyFeatureEvents: number;
  lastActivity: string | null;
};

function getDataDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, '../../../../data');
}

function getWeights(overrides?: HealthScoringOptions['weights']): WeightConfig {
  return {
    productUsage: overrides?.productUsage ?? 0.3,
    supportSentiment: overrides?.supportSentiment ?? 0.2,
    billingHealth: overrides?.billingHealth ?? 0.2,
    nps: overrides?.nps ?? 0.15,
    engagement: overrides?.engagement ?? 0.15,
  };
}

function shiftDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function getDatasetReferenceDates(input: {
  subscriptions: ChargebeeSubscription[];
  stripePayments: { payment_date: string }[];
  supportTickets: SupportTicketRecord[];
  npsResponses: NpsResponseRecord[];
  productEvents: ProductEvent[];
}): { overall: Date; product: Date; support: Date; nps: Date; billing: Date } {
  const billingTimestamps = [
    ...input.subscriptions.map((item) => new Date(item.current_term_start).getTime()),
    ...input.subscriptions.map((item) => new Date(item.current_term_end).getTime()),
    ...input.stripePayments.map((item) => new Date(item.payment_date).getTime()),
  ].filter((value) => Number.isFinite(value));
  const supportTimestamps = input.supportTickets
    .map((item) => new Date(item.createdAt).getTime())
    .filter((value) => Number.isFinite(value));
  const npsTimestamps = input.npsResponses
    .map((item) => new Date(item.surveyDate).getTime())
    .filter((value) => Number.isFinite(value));
  const productTimestamps = input.productEvents
    .map((item) => new Date(item.timestamp).getTime())
    .filter((value) => Number.isFinite(value));
  const timestamps = [
    ...billingTimestamps,
    ...supportTimestamps,
    ...npsTimestamps,
    ...productTimestamps,
  ];
  return {
    overall: new Date(maxTimestamp(timestamps)),
    product: new Date(maxTimestamp(productTimestamps)),
    support: new Date(maxTimestamp(supportTimestamps)),
    nps: new Date(maxTimestamp(npsTimestamps)),
    billing: new Date(maxTimestamp(billingTimestamps)),
  };
}

async function loadSupportTickets(dataDir: string): Promise<SupportTicketRecord[]> {
  const accountNameToAccountId = new Map<string, string>();
  const [, accounts] = await loadSalesforceData(dataDir);
  for (const account of accounts) {
    accountNameToAccountId.set(normalizeCompanyName(account.account_name), account.account_id);
  }

  return loadCSV<SupportTicketRecord>(join(dataDir, 'support_tickets.csv'), {
    transform: (row) => {
      const raw = row as unknown as RawSupportTicket;
      const accountId =
        normalizeAccountId(raw.account_id) ??
        accountNameToAccountId.get(normalizeCompanyName(raw.account_name)) ??
        null;

      return {
        accountId,
        createdAt: new Date(raw.created_at).toISOString(),
        resolvedAt: raw.resolved_at ? new Date(raw.resolved_at).toISOString() : null,
        priority: raw.priority.toLowerCase() as SupportTicketRecord['priority'],
        status: raw.status.toLowerCase() as SupportTicketRecord['status'],
        csatScore: raw.csat_score ? Number(raw.csat_score) : null,
        escalated: String(raw.escalated).toLowerCase() === 'true',
      };
    },
  });
}

async function loadNpsResponses(dataDir: string): Promise<NpsResponseRecord[]> {
  const [, accounts] = await loadSalesforceData(dataDir);
  const websiteDomainToAccountId = new Map<string, string>();
  for (const account of accounts) {
    websiteDomainToAccountId.set(normalizeDomain(account.website), account.account_id);
  }

  return loadCSV<NpsResponseRecord>(join(dataDir, 'nps_surveys.csv'), {
    transform: (row) => {
      const raw = row as unknown as RawNpsResponse;
      const respondentDomain = normalizeDomain(raw.respondent_email.split('@')[1] ?? '');
      return {
        accountId: normalizeAccountId(raw.account_id) ?? websiteDomainToAccountId.get(respondentDomain) ?? null,
        score: Number(raw.score),
        surveyDate: new Date(raw.survey_date).toISOString(),
      };
    },
  });
}

function normalizeAccountId(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('ACC-')) return trimmed;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return null;
  return `ACC-${Math.trunc(numeric).toString().padStart(5, '0')}`;
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

function groupBy<T>(
  values: T[],
  getKey: (value: T) => string | null,
  predicate: (value: T) => boolean = () => true,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const value of values) {
    if (!predicate(value)) continue;
    const key = getKey(value);
    if (!key) continue;
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(value);
    } else {
      map.set(key, [value]);
    }
  }
  return map;
}

function buildSubscriptionIndex(
  subscriptions: ChargebeeSubscription[],
  accounts: Awaited<ReturnType<typeof loadSalesforceData>>[1],
): Map<string, ChargebeeSubscription> {
  const accountsByName = new Map<string, string>();
  for (const account of accounts) {
    accountsByName.set(normalizeCompanyName(account.account_name), account.account_id);
  }

  const index = new Map<string, ChargebeeSubscription>();
  for (const subscription of subscriptions) {
    if (!['active', 'non_renewing', 'paused'].includes(subscription.status)) continue;
    const accountId = accountsByName.get(normalizeCompanyName(subscription.customer.company));
    if (!accountId) continue;
    const existing = index.get(accountId);
    if (!existing || existing.mrr < subscription.mrr) {
      index.set(accountId, subscription);
    }
  }
  return index;
}

function buildStripePaymentIndex(
  payments: Awaited<ReturnType<typeof loadStripePayments>>,
  accounts: Awaited<ReturnType<typeof loadSalesforceData>>[1],
): Map<string, Awaited<ReturnType<typeof loadStripePayments>>> {
  const accountsByName = new Map<string, string>();
  for (const account of accounts) {
    accountsByName.set(normalizeCompanyName(account.account_name), account.account_id);
  }

  const mapped: Array<(typeof payments)[number] & { accountId: string }> = [];
  for (const payment of payments) {
    const accountId = accountsByName.get(normalizeCompanyName(payment.customer_name));
    if (!accountId) continue;
    mapped.push({ ...payment, accountId });
  }

  return groupBy(mapped, (payment) => payment.accountId);
}

function aggregateUsage(events: ProductEvent[], start: Date, end: Date): Map<string, UsageSummary> {
  const map = new Map<string, UsageSummary>();
  const startMs = start.getTime();
  const endMs = end.getTime();

  for (const event of events) {
    const eventTime = new Date(event.timestamp).getTime();
    if (eventTime < startMs || eventTime > endMs) continue;

    const existing = map.get(event.account_id) ?? {
      accountId: event.account_id,
      totalEvents: 0,
      uniqueUsers: 0,
      uniqueFeatures: 0,
      daysActive: 0,
      keyFeatureEvents: 0,
      lastActivity: null,
    };

    const userSet = (existing as UsageSummary & { _users?: Set<string> })._users ?? new Set<string>();
    const featureSet =
      (existing as UsageSummary & { _features?: Set<string> })._features ?? new Set<string>();
    const daySet = (existing as UsageSummary & { _days?: Set<string> })._days ?? new Set<string>();

    userSet.add(event.user_id);
    featureSet.add(event.feature);
    daySet.add(event.timestamp.slice(0, 10));

    existing.totalEvents += 1;
    if (['api', 'exports', 'integrations', 'reports', 'billing'].includes(event.feature)) {
      existing.keyFeatureEvents += 1;
    }
    existing.lastActivity =
      !existing.lastActivity || existing.lastActivity < event.timestamp ? event.timestamp : existing.lastActivity;

    (existing as UsageSummary & { _users?: Set<string> })._users = userSet;
    (existing as UsageSummary & { _features?: Set<string> })._features = featureSet;
    (existing as UsageSummary & { _days?: Set<string> })._days = daySet;
    existing.uniqueUsers = userSet.size;
    existing.uniqueFeatures = featureSet.size;
    existing.daysActive = daySet.size;

    map.set(event.account_id, existing);
  }

  return map;
}

function emptyUsageSummary(accountId: string): UsageSummary {
  return {
    accountId,
    totalEvents: 0,
    uniqueUsers: 0,
    uniqueFeatures: 0,
    daysActive: 0,
    keyFeatureEvents: 0,
    lastActivity: null,
  };
}

function buildUsageSignal(current: UsageSummary, previous: UsageSummary, weight: number): HealthSignal {
  const daysScore = clamp((current.daysActive / 20) * 45, 0, 45);
  const breadthScore = clamp((current.uniqueFeatures / 6) * 25, 0, 25);
  const intensityScore = clamp((current.totalEvents / 120) * 20, 0, 20);
  const keyFeatureScore = clamp((current.keyFeatureEvents / 25) * 10, 0, 10);
  const value = Math.round(daysScore + breadthScore + intensityScore + keyFeatureScore);
  const trend = compareMetric(current.totalEvents, previous.totalEvents);

  return {
    name: 'Product Usage',
    weight,
    value,
    source: 'product_events',
    rawValue: `${current.daysActive} active days / ${current.totalEvents} events`,
    trend,
  };
}

function buildEngagementSignal(
  current: UsageSummary,
  previous: UsageSummary,
  employeeCount: number,
  weight: number,
  asOfDate: Date,
): HealthSignal {
  const lastActivityDays = current.lastActivity
    ? getDaysBetween(new Date(current.lastActivity), asOfDate)
    : 999;
  const recencyScore =
    lastActivityDays <= 3 ? 45 : lastActivityDays <= 7 ? 35 : lastActivityDays <= 14 ? 22 : lastActivityDays <= 30 ? 10 : 0;
  const breadthRatio = employeeCount > 0 ? current.uniqueUsers / Math.max(5, Math.min(employeeCount, 100)) : 0;
  const breadthScore = clamp(breadthRatio * 35, 0, 35);
  const cadenceScore = clamp((current.daysActive / 15) * 20, 0, 20);
  const value = Math.round(recencyScore + breadthScore + cadenceScore);

  return {
    name: 'Engagement',
    weight,
    value,
    source: 'product_events',
    rawValue: `${current.uniqueUsers} active users`,
    trend: compareMetric(current.uniqueUsers, previous.uniqueUsers),
  };
}

function buildSupportSignal(
  tickets: SupportTicketRecord[],
  windowStart: Date,
  asOfDate: Date,
  weight: number,
): HealthSignal {
  const recentTickets = tickets.filter((ticket) => new Date(ticket.createdAt) >= windowStart);
  const openTickets = recentTickets.filter((ticket) => ['open', 'pending'].includes(ticket.status)).length;
  const severeTickets = recentTickets.filter((ticket) => ['high', 'urgent'].includes(ticket.priority)).length;
  const escalations = recentTickets.filter((ticket) => ticket.escalated).length;
  const csatScores = recentTickets
    .map((ticket) => ticket.csatScore)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const averageCsat =
    csatScores.length > 0 ? csatScores.reduce((sum, value) => sum + value, 0) / csatScores.length : null;
  const daysSinceLastTicket = recentTickets.length
    ? getDaysBetween(new Date(recentTickets.reduce((latest, ticket) => (latest > ticket.createdAt ? latest : ticket.createdAt), recentTickets[0]!.createdAt)), asOfDate)
    : 999;

  let value = 100;
  value -= Math.min(30, recentTickets.length * 6);
  value -= Math.min(24, openTickets * 8);
  value -= Math.min(18, severeTickets * 6);
  value -= Math.min(12, escalations * 6);
  if (averageCsat !== null) value -= clamp((5 - averageCsat) * 10, 0, 30);
  if (recentTickets.length === 0 || daysSinceLastTicket > 45) value += 6;

  return {
    name: 'Support Burden',
    weight,
    value: clamp(Math.round(value), 0, 100),
    source: 'support_tickets',
    rawValue: `${recentTickets.length} tickets / ${openTickets} open`,
    trend: recentTickets.length >= 5 ? 'declining' : recentTickets.length >= 2 ? 'stable' : 'improving',
  };
}

function buildBillingSignal(
  payments: Awaited<ReturnType<typeof loadStripePayments>>,
  subscription: ChargebeeSubscription | null,
  windowStart: Date,
  asOfDate: Date,
  weight: number,
): HealthSignal {
  const recentPayments = payments.filter((payment) => new Date(payment.payment_date) >= windowStart);
  const failed = recentPayments.filter((payment) => payment.status === 'failed').length;
  const disputed = recentPayments.filter((payment) => payment.status === 'disputed').length;
  const refunded = recentPayments.filter((payment) => payment.status === 'refunded').length;
  const succeeded = recentPayments.filter((payment) => payment.status === 'succeeded').length;
  const latestFailure = recentPayments
    .filter((payment) => payment.status === 'failed')
    .sort((a, b) => b.payment_date.localeCompare(a.payment_date))[0];

  let value = 100;
  value -= failed * 18;
  value -= disputed * 25;
  value -= refunded * 8;
  if (latestFailure && getDaysBetween(new Date(latestFailure.payment_date), asOfDate) <= 30) value -= 15;
  if (subscription?.status === 'non_renewing') value -= 30;
  if (subscription?.status === 'paused') value -= 20;
  if (subscription?.cancel_reason) value -= 20;
  if (succeeded >= 3 && failed === 0 && disputed === 0) value += 5;

  return {
    name: 'Billing Health',
    weight,
    value: clamp(Math.round(value), 0, 100),
    source: 'stripe_payments,chargebee_subscriptions',
    rawValue: `${failed} failed / ${succeeded} succeeded`,
    trend: failed > 1 || disputed > 0 ? 'declining' : succeeded > 0 ? 'stable' : 'improving',
  };
}

function buildNpsSignal(
  responses: NpsResponseRecord[],
  asOfDate: Date,
  weight: number,
): HealthSignal {
  if (responses.length === 0) {
    return {
      name: 'NPS',
      weight,
      value: 55,
      source: 'nps_surveys',
      rawValue: 'no response',
      trend: 'stable',
    };
  }

  const sorted = [...responses].sort((a, b) => b.surveyDate.localeCompare(a.surveyDate));
  const latest = sorted[0]!;
  const daysOld = getDaysBetween(new Date(latest.surveyDate), asOfDate);
  const recencyPenalty = daysOld <= 60 ? 0 : daysOld <= 120 ? 5 : daysOld <= 180 ? 10 : 15;
  const value = clamp(Math.round(latest.score * 10 - recencyPenalty), 0, 100);
  const previous = sorted[1];

  return {
    name: 'NPS',
    weight,
    value,
    source: 'nps_surveys',
    rawValue: latest.score,
    trend: previous ? compareMetric(latest.score, previous.score) : 'stable',
  };
}

function compareMetric(current: number, previous: number): HealthSignal['trend'] {
  if (previous <= 0 && current > 0) return 'improving';
  if (current >= previous * 1.1) return 'improving';
  if (current <= previous * 0.9) return 'declining';
  return 'stable';
}

function deriveRiskLevel(score: number): RiskLevel {
  if (score >= 80) return RiskLevel.LOW;
  if (score >= 50) return RiskLevel.MEDIUM;
  if (score >= 25) return RiskLevel.HIGH;
  return RiskLevel.CRITICAL;
}

function buildRiskSummary(signals: HealthSignal[], riskLevel: RiskLevel): string {
  const weakest = [...signals].sort((a, b) => a.value - b.value).slice(0, 2);
  const weakSummary = weakest.map((signal) => `${signal.name.toLowerCase()} (${signal.value})`).join(', ');

  if (riskLevel === RiskLevel.LOW) {
    return `Healthy account with no major warning signal; weakest area is ${weakSummary}.`;
  }
  if (riskLevel === RiskLevel.MEDIUM) {
    return `Needs proactive follow-up. Main drag comes from ${weakSummary}.`;
  }
  if (riskLevel === RiskLevel.HIGH) {
    return `Material churn risk within the next renewal cycle, driven by ${weakSummary}.`;
  }
  return `Critical retention risk. Immediate intervention is warranted given ${weakSummary}.`;
}

function getDaysUntil(target: Date, asOfDate: Date): number {
  return Math.max(0, Math.ceil((target.getTime() - asOfDate.getTime()) / 86_400_000));
}

function getDaysBetween(past: Date, asOfDate: Date): number {
  return Math.max(0, Math.floor((asOfDate.getTime() - past.getTime()) / 86_400_000));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function maxTimestamp(values: number[]): number {
  if (values.length === 0) return Date.now();
  return Math.max(...values);
}
