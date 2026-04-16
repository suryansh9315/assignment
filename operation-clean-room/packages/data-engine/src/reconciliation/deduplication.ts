import type { DuplicateResult, MatchConfidence } from './types.js';
import type { StripePayment, ChargebeeSubscription } from '../ingestion/types.js';
import { normalizeCompanyName } from '../utils/normalization.js';

type StripeSubscriptionRecord = {
  customerId: string;
  customerName: string;
  subscriptionId: string;
  status: string;
  startDate: string;
  endDate: string | null;
  mrr: number;
  rawName: string;
};

const DEFAULT_NAME_THRESHOLD = 0.7;
const DEFAULT_MIGRATION_GAP_DAYS = 30;

function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function diffDays(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function sortDateStrings(dates: string[]): string[] {
  return [...dates].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
}

function isChargebeeIncluded(
  subscription: ChargebeeSubscription,
  includeCancelled: boolean,
): boolean {
  return includeCancelled || subscription.status !== 'cancelled';
}

function getStripeCycleDays(payments: StripePayment[]): number {
  const sortedDates = sortDateStrings(payments.map((payment) => payment.payment_date));
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

function aggregateStripeSubscriptions(stripeData: StripePayment[]): StripeSubscriptionRecord[] {
  const grouped = new Map<string, StripePayment[]>();

  for (const payment of stripeData) {
    const subscriptionId = payment.subscription_id ?? payment.customer_id;
    const key = `${payment.customer_id}::${subscriptionId}`;
    const group = grouped.get(key) ?? [];
    group.push(payment);
    grouped.set(key, group);
  }

  return Array.from(grouped.values()).map((payments) => {
    const sortedByDate = [...payments].sort(
      (a, b) => new Date(a.payment_date).getTime() - new Date(b.payment_date).getTime(),
    );
    const latest = sortedByDate[sortedByDate.length - 1]!;
    const cycleDays = getStripeCycleDays(sortedByDate);
    const positiveAmounts = sortedByDate
      .map((payment) => payment.amount)
      .filter((amount) => amount > 0);

    return {
      customerId: latest.customer_id,
      customerName: latest.customer_name,
      subscriptionId: latest.subscription_id ?? latest.customer_id,
      status:
        latest.status === 'failed'
          ? 'inactive'
          : latest.status === 'pending'
            ? 'pending'
            : 'active',
      startDate: sortedByDate[0]!.payment_date,
      endDate: addDays(latest.payment_date, cycleDays),
      mrr:
        positiveAmounts.length === 0
          ? 0
          : positiveAmounts.reduce((sum, amount) => sum + amount, 0) / positiveAmounts.length,
      rawName: normalizeCompanyName(latest.customer_name),
    };
  });
}

function computeNameSimilarity(nameA: string, nameB: string): number {
  if (nameA.length === 0 || nameB.length === 0) return 0;
  if (nameA === nameB) return 1;
  if (nameA.includes(nameB) || nameB.includes(nameA)) return 0.9;

  const tokensA = new Set(nameA.split(' ').filter(Boolean));
  const tokensB = new Set(nameB.split(' ').filter(Boolean));
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;

  return union === 0 ? 0 : intersection / union;
}

function buildConfidence(
  stripeRecord: StripeSubscriptionRecord,
  chargebeeRecord: ChargebeeSubscription,
): MatchConfidence {
  const matchedFields: string[] = [];
  const unmatchedFields: string[] = [];
  let score = 0;

  const stripeName = stripeRecord.rawName;
  const chargebeeName = normalizeCompanyName(chargebeeRecord.customer.company);
  const nameSimilarity = computeNameSimilarity(stripeName, chargebeeName);

  if (nameSimilarity >= 0.95) {
    matchedFields.push('company_name_exact');
    score += 0.65;
  } else if (nameSimilarity >= 0.7) {
    matchedFields.push('company_name_fuzzy');
    score += 0.5 * nameSimilarity;
  } else {
    unmatchedFields.push('company_name');
  }

  const mrrBase = Math.max(stripeRecord.mrr, chargebeeRecord.mrr, 1);
  const mrrDifferenceFraction = Math.abs(stripeRecord.mrr - chargebeeRecord.mrr) / mrrBase;
  if (mrrDifferenceFraction <= 0.1) {
    matchedFields.push('mrr_close');
    score += 0.2;
  } else {
    unmatchedFields.push('mrr');
  }

  const stripePlanHint = normalizeCompanyName(stripeRecord.subscriptionId);
  const chargebeePlanHint = normalizeCompanyName(chargebeeRecord.plan.plan_name);
  if (
    stripePlanHint.includes(chargebeePlanHint) ||
    chargebeePlanHint.includes(stripePlanHint) ||
    stripeRecord.subscriptionId === chargebeeRecord.subscription_id
  ) {
    matchedFields.push('plan_hint');
    score += 0.05;
  }

  if (stripeRecord.customerId === chargebeeRecord.customer.customer_id) {
    matchedFields.push('customer_id');
    score += 0.1;
  } else {
    unmatchedFields.push('customer_id');
  }

  return {
    score: Math.min(1, score),
    matchedFields,
    unmatchedFields,
  };
}

function calculateOverlap(
  stripeStartDate: string,
  stripeEndDate: string | null,
  chargebeeStartDate: string,
  chargebeeEndDate: string | null,
): { hasOverlap: boolean; overlapDays: number } {
  if (!stripeEndDate || !chargebeeEndDate) {
    return { hasOverlap: false, overlapDays: 0 };
  }

  const overlapStart = new Date(
    Math.max(new Date(stripeStartDate).getTime(), new Date(chargebeeStartDate).getTime()),
  );
  const overlapEnd = new Date(
    Math.min(new Date(stripeEndDate).getTime(), new Date(chargebeeEndDate).getTime()),
  );

  if (overlapEnd.getTime() < overlapStart.getTime()) {
    return { hasOverlap: false, overlapDays: 0 };
  }

  return {
    hasOverlap: true,
    overlapDays: Math.max(1, diffDays(overlapStart.toISOString(), overlapEnd.toISOString()) + 1),
  };
}

/**
 * Cross-system duplicate detection.
 *
 * Identifies accounts and subscriptions that exist in multiple billing
 * systems (Stripe and Chargebee) with overlapping active periods.  This
 * is a critical reconciliation step because:
 *
 * - **Double-counting revenue**: If the same customer has active
 *   subscriptions in both Stripe and Chargebee, ARR will be overstated
 *   unless duplicates are identified and de-duplicated.
 *
 * - **Migration artifacts**: When customers were migrated from one billing
 *   system to another, the old subscription may not have been properly
 *   cancelled, resulting in a "ghost" subscription that inflates metrics.
 *
 * - **Intentional dual subscriptions**: In rare cases a customer may
 *   legitimately have subscriptions in both systems (e.g., different
 *   products or business units).  The deduplication engine should flag
 *   these but allow classification.
 *
 * The classifier should distinguish between:
 * - `true_duplicate`: Same customer, overlapping active periods, same product.
 * - `migration`: Same customer, sequential subscriptions with a gap,
 *   indicating a system migration.
 * - `uncertain`: Cannot be definitively classified; needs human review.
 *
 * @module reconciliation/deduplication
 */

/** Options for duplicate detection. */
export interface DeduplicationOptions {
  /** Name match confidence threshold (0-1). Defaults to 0.7. */
  nameThreshold?: number;
  /** Maximum gap in days between subscriptions to consider a migration. Defaults to 30. */
  migrationGapDays?: number;
  /** Whether to include cancelled subscriptions. Defaults to true. */
  includeCancelled?: boolean;
}

/**
 * Detect potential duplicates across Stripe and Chargebee.
 *
 * @param stripeData - Stripe payment/subscription data
 * @param chargebeeData - Chargebee subscription data
 * @param options - Detection options
 * @returns Array of detected duplicates with classification
 */
export async function detectDuplicates(
  stripeData: StripePayment[],
  chargebeeData: ChargebeeSubscription[],
  options?: DeduplicationOptions,
): Promise<DuplicateResult[]> {
  const nameThreshold = options?.nameThreshold ?? DEFAULT_NAME_THRESHOLD;
  const includeCancelled = options?.includeCancelled ?? true;
  const stripeSubscriptions = aggregateStripeSubscriptions(stripeData);
  const duplicates: DuplicateResult[] = [];

  for (const stripeRecord of stripeSubscriptions) {
    for (const chargebeeRecord of chargebeeData) {
      if (!isChargebeeIncluded(chargebeeRecord, includeCancelled)) {
        continue;
      }

      const confidence = buildConfidence(stripeRecord, chargebeeRecord);
      if (confidence.score < nameThreshold) {
        continue;
      }

      const overlap = calculateOverlap(
        stripeRecord.startDate,
        stripeRecord.endDate,
        chargebeeRecord.current_term_start,
        chargebeeRecord.current_term_end,
      );

      const duplicate: DuplicateResult = {
        stripeRecord: {
          customerId: stripeRecord.customerId,
          customerName: stripeRecord.customerName,
          subscriptionId: stripeRecord.subscriptionId,
          status: stripeRecord.status,
          startDate: stripeRecord.startDate,
          endDate: stripeRecord.endDate,
          mrr: Math.round(stripeRecord.mrr),
        },
        chargebeeRecord: {
          customerId: chargebeeRecord.customer.customer_id,
          customerName: chargebeeRecord.customer.company,
          subscriptionId: chargebeeRecord.subscription_id,
          status: chargebeeRecord.status,
          startDate: chargebeeRecord.current_term_start,
          endDate: chargebeeRecord.current_term_end,
          mrr: chargebeeRecord.mrr,
        },
        confidence,
        hasOverlap: overlap.hasOverlap,
        overlapDays: overlap.overlapDays,
        classification: 'uncertain',
      };

      duplicate.classification = classifyDuplicate(duplicate, options);
      if (duplicate.classification !== 'uncertain' || duplicate.hasOverlap) {
        duplicates.push(duplicate);
      }
    }
  }

  return duplicates.sort((a, b) => b.confidence.score - a.confidence.score);
}

/**
 * Classify a detected duplicate as a true duplicate, migration, or uncertain.
 *
 * Classification rules:
 * - **true_duplicate**: Both subscriptions are active and overlap by more
 *   than 7 days with the same or similar plan.
 * - **migration**: Subscriptions are sequential (one ends, another begins)
 *   with a gap of less than `migrationGapDays`.
 * - **uncertain**: Neither rule applies clearly; requires human review.
 *
 * @param duplicate - A detected duplicate result
 * @returns Classification label
 */
export function classifyDuplicate(
  duplicate: DuplicateResult,
  options?: DeduplicationOptions,
): 'true_duplicate' | 'migration' | 'uncertain' {
  const migrationGapDays = options?.migrationGapDays ?? DEFAULT_MIGRATION_GAP_DAYS;
  const stripeActive = duplicate.stripeRecord.status === 'active';
  const chargebeeActive =
    duplicate.chargebeeRecord.status === 'active' ||
    duplicate.chargebeeRecord.status === 'non_renewing' ||
    duplicate.chargebeeRecord.status === 'in_trial';
  const mrrBase = Math.max(duplicate.stripeRecord.mrr, duplicate.chargebeeRecord.mrr, 1);
  const mrrDifferenceFraction =
    Math.abs(duplicate.stripeRecord.mrr - duplicate.chargebeeRecord.mrr) / mrrBase;

  if (
    duplicate.hasOverlap &&
    duplicate.overlapDays > 7 &&
    stripeActive &&
    chargebeeActive &&
    mrrDifferenceFraction <= 0.5
  ) {
    return 'true_duplicate';
  }

  if (duplicate.stripeRecord.endDate) {
    const gapDays = diffDays(duplicate.stripeRecord.endDate, duplicate.chargebeeRecord.startDate);
    if (!duplicate.hasOverlap && gapDays >= 0 && gapDays <= migrationGapDays) {
      return 'migration';
    }
  }

  return 'uncertain';
}
