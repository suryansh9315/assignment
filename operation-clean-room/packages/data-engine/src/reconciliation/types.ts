/**
 * Types for the reconciliation engine.
 *
 * The reconciliation process compares data across multiple source systems
 * (Stripe, Chargebee, Salesforce, legacy billing) to identify discrepancies,
 * duplicates, and data quality issues.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Classification of reconciliation discrepancies. */
export enum DiscrepancyType {
  /** Same customer exists in multiple billing systems with overlapping subscriptions. */
  DUPLICATE_ACCOUNT = 'duplicate_account',
  /** Customer exists in one system but has no match in another expected system. */
  MISSING_ACCOUNT = 'missing_account',
  /** Revenue/amount values differ between two systems beyond the tolerance threshold. */
  AMOUNT_MISMATCH = 'amount_mismatch',
  /** Dates (start, end, renewal) differ between systems beyond tolerance. */
  DATE_MISMATCH = 'date_mismatch',
  /** Subscription or payment status disagrees between systems. */
  STATUS_MISMATCH = 'status_mismatch',
  /** A record in one system has no corresponding parent/reference in another. */
  ORPHAN_RECORD = 'orphan_record',
  /** FX conversion produces a different amount than what was recorded. */
  FX_DISCREPANCY = 'fx_discrepancy',
}

/** Severity classification for discrepancies. */
export enum Severity {
  /** Informational; no revenue impact expected. */
  LOW = 'low',
  /** Minor issue; small revenue impact or data quality concern. */
  MEDIUM = 'medium',
  /** Significant issue; material revenue impact or customer-facing risk. */
  HIGH = 'high',
  /** Urgent issue; large revenue misstatement or compliance risk. */
  CRITICAL = 'critical',
}

// ---------------------------------------------------------------------------
// Core discrepancy types
// ---------------------------------------------------------------------------

/** A single detected discrepancy between two data sources. */
export interface Discrepancy {
  /** Unique identifier for this discrepancy. */
  id: string;
  /** Classification of the discrepancy. */
  type: DiscrepancyType;
  /** How severe is this discrepancy? */
  severity: Severity;
  /** The first data source involved. */
  sourceA: {
    system: string;
    recordId: string;
    value: string | number | null;
  };
  /** The second data source involved. */
  sourceB: {
    system: string;
    recordId: string;
    value: string | number | null;
  };
  /** Customer or account name associated with this discrepancy. */
  customerName: string;
  /** Dollar amount of the discrepancy (absolute difference), if applicable. */
  amount: number | null;
  /** Percent delta relative to the larger absolute side, if applicable. */
  percentDelta?: number | null;
  /** Human-readable direction of the mismatch. */
  direction?: string | null;
  /** Categorizes whether the discrepancy is CRM-facing, cross-billing, or duplicate review. */
  scope?: 'billing_vs_crm' | 'billing_vs_billing' | 'duplicate_review' | 'pipeline_review';
  /** Human-readable description of what was found. */
  description: string;
  /** ISO-8601 timestamp when this discrepancy was detected. */
  detectedAt: string;
  /** Whether this discrepancy has been reviewed and resolved. */
  resolved: boolean;
  /** Free-text note added when the discrepancy is resolved. */
  resolutionNote: string | null;
}

// ---------------------------------------------------------------------------
// Match confidence
// ---------------------------------------------------------------------------

/** Confidence assessment for an entity-resolution match. */
export interface MatchConfidence {
  /** Overall confidence score from 0 (no match) to 1 (perfect match). */
  score: number;
  /** Fields that matched between the two entities. */
  matchedFields: string[];
  /** Fields that did NOT match or were missing from one side. */
  unmatchedFields: string[];
}

/** A single match result from the entity resolution engine. */
export interface MatchResult {
  /** Entity from source A. */
  entityA: {
    id: string;
    source: string;
    [key: string]: unknown;
  };
  /** Entity from source B. */
  entityB: {
    id: string;
    source: string;
    [key: string]: unknown;
  };
  /** Match confidence details. */
  confidence: MatchConfidence;
}

// ---------------------------------------------------------------------------
// Reconciliation result
// ---------------------------------------------------------------------------

/** Summary statistics for a reconciliation run. */
export interface ReconciliationSummary {
  /** Total number of discrepancies found. */
  totalDiscrepancies: number;
  /** Breakdown by severity. */
  bySeverity: Record<Severity, number>;
  /** Breakdown by discrepancy type. */
  byType: Record<DiscrepancyType, number>;
  /** Total dollar amount of all amount-based discrepancies. */
  totalAmountImpact: number;
  /** Number of records processed from each source. */
  recordsProcessed: Record<string, number>;
}

/** Full result of a reconciliation run. */
export interface ReconciliationResult {
  /** All detected discrepancies. */
  discrepancies: Discrepancy[];
  /** Aggregate summary statistics. */
  summary: ReconciliationSummary;
  /** Metadata about the reconciliation run. */
  metadata: {
    /** ISO-8601 timestamp when the run started. */
    startedAt: string;
    /** ISO-8601 timestamp when the run completed. */
    completedAt: string;
    /** Duration in milliseconds. */
    durationMs: number;
    /** Options that were used for the run. */
    options: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/** A detected duplicate across billing systems. */
export interface DuplicateResult {
  /** Records from the first system. */
  stripeRecord: {
    customerId: string;
    customerName: string;
    subscriptionId: string;
    status: string;
    startDate: string;
    endDate: string | null;
    mrr: number;
  };
  /** Records from the second system. */
  chargebeeRecord: {
    customerId: string;
    customerName: string;
    subscriptionId: string;
    status: string;
    startDate: string;
    endDate: string | null;
    mrr: number;
  };
  /** Match confidence between the two records. */
  confidence: MatchConfidence;
  /** Whether the subscriptions have overlapping active periods. */
  hasOverlap: boolean;
  /** Number of days of overlap, if any. */
  overlapDays: number;
  /** Classification of the duplicate. */
  classification: 'true_duplicate' | 'migration' | 'uncertain';
}

// ---------------------------------------------------------------------------
// Pipeline analysis
// ---------------------------------------------------------------------------

/** Result of CRM pipeline quality analysis. */
export interface PipelineAnalysisResult {
  /** Opportunities with no activity for 90+ days. */
  zombieDeals: {
    opportunityId: string;
    accountName: string;
    amount: number;
    stage: string;
    daysSinceActivity: number;
  }[];
  /** Opportunities whose stage/amount conflicts with billing data. */
  mismatches: {
    opportunityId: string;
    accountName: string;
    issue: string;
    crmValue: string | number;
    billingValue: string | number;
    billingSystems: string[];
    percentDelta: number;
    direction: 'over-reporting' | 'under-reporting';
  }[];
  /** Subscriptions in billing systems with no matching CRM opportunity. */
  unbookedRevenue: {
    subscriptionId: string;
    customerName: string;
    mrr: number;
    system: string;
  }[];
  /** Summary stats. */
  summary: {
    totalZombieDeals: number;
    totalZombieValue: number;
    totalMismatches: number;
    totalUnbookedMRR: number;
    pipelineHealthScore: number;
  };
}

// ---------------------------------------------------------------------------
// Revenue reconciliation
// ---------------------------------------------------------------------------

/** Result of revenue reconciliation between subscriptions and payments. */
export interface RevenueReconciliationResult {
  /** Expected revenue from active subscriptions in the period. */
  expectedRevenue: number;
  /** Actual revenue collected from payments in the period. */
  actualRevenue: number;
  /** Difference (actual - expected). */
  difference: number;
  /** Percentage difference. */
  differencePercent: number;
  /** Individual line-item discrepancies. */
  lineItems: {
    customerId: string;
    customerName: string;
    expected: number;
    actual: number;
    difference: number;
    reason: string;
  }[];
  /** Breakdown of the difference by cause. */
  breakdown: {
    prorations: number;
    discounts: number;
    fxDifferences: number;
    timingDifferences: number;
    unexplained: number;
  };
}
