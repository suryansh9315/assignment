/**
 * Types for SaaS metrics calculations.
 *
 * All monetary values are in USD unless otherwise noted.  Metrics follow
 * standard SaaS accounting conventions as defined by industry benchmarks
 * (e.g., OpenView, Bessemer, ICONIQ).
 */

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

/** Common options for metric calculations. */
export interface MetricOptions {
  /** Start of the calculation period (inclusive). */
  startDate?: Date;
  /** End of the calculation period (inclusive). */
  endDate?: Date;
  /** Segment dimension to break down by. */
  segmentBy?: 'plan' | 'segment' | 'region' | 'industry' | 'cohort';
  /** Whether to exclude customers currently in trial. Defaults to true. */
  excludeTrials?: boolean;
  /** Whether to exclude churned customers from base calculations. Defaults to true. */
  excludeChurned?: boolean;
  /** Currency to normalize to. Defaults to 'USD'. */
  currency?: string;
}

// ---------------------------------------------------------------------------
// ARR (Annual Recurring Revenue)
// ---------------------------------------------------------------------------

/** Breakdown of ARR by a dimension. */
export interface ARRBreakdown {
  label: string;
  arr: number;
  customerCount: number;
  percentOfTotal: number;
}

/** Result of an ARR calculation. */
export interface ARRResult {
  /** Total ARR in USD. */
  total: number;
  /** ARR broken down by customer segment (enterprise, mid-market, SMB, startup). */
  bySegment: ARRBreakdown[];
  /** ARR broken down by pricing plan. */
  byPlan: ARRBreakdown[];
  /** ARR broken down by geographic region. */
  byRegion: ARRBreakdown[];
  /** ARR broken down by signup cohort (month). */
  byCohort: ARRBreakdown[];
  /** As-of date for the calculation. */
  asOfDate: string;
  /** Total number of paying customers included. */
  totalCustomers: number;
  /** Average ARR per customer. */
  avgARRPerCustomer: number;
  /** Median ARR per customer. */
  medianARRPerCustomer: number;
}

/** Monthly ARR movement and run-rate revenue point for the CFO revenue view. */
export interface MonthlyRevenueSummary {
  month: string;
  arr: number;
  mrrRunRate: number;
  newBusiness: number;
  expansion: number;
  contraction: number;
  churn: number;
  customerCount: number;
  byPlan: ARRBreakdown[];
}

/** Timing issue surfaced for board/audit review rather than full revenue recognition. */
export interface RevenueTimingIssue {
  id: string;
  source: 'chargebee' | 'stripe' | 'legacy';
  customerName: string;
  description: string;
  amount: number;
  date: string;
  severity: 'medium' | 'high';
}

/** CFO-facing ARR and revenue summary payload. */
export interface RevenueSummaryResult {
  asOfDate: string;
  currentARR: ARRResult;
  monthly: MonthlyRevenueSummary[];
  planMix: ARRBreakdown[];
  timingIssues: RevenueTimingIssue[];
}

// ---------------------------------------------------------------------------
// NRR (Net Revenue Retention)
// ---------------------------------------------------------------------------

/** Detailed breakdown of NRR components. */
export interface NRRBreakdownItem {
  customerName: string;
  startingARR: number;
  endingARR: number;
  change: number;
  changeType: 'expansion' | 'contraction' | 'churn' | 'unchanged';
  reason: string | null;
}

/** Result of an NRR calculation. */
export interface NRRResult {
  /** Net revenue retention as a percentage (e.g. 115 means 115%). */
  percentage: number;
  /** Total expansion revenue (upgrades, add-ons, seat growth). */
  expansion: number;
  /** Total contraction revenue (downgrades, seat reduction, discount increases). */
  contraction: number;
  /** Total churned revenue (fully cancelled subscriptions). */
  churn: number;
  /** Starting ARR for the cohort at the beginning of the period. */
  startingARR: number;
  /** Ending ARR for the same cohort at the end of the period. */
  endingARR: number;
  /** Per-customer breakdown of changes. */
  breakdown: NRRBreakdownItem[];
  /** Period start date. */
  periodStart: string;
  /** Period end date. */
  periodEnd: string;
}

// ---------------------------------------------------------------------------
// Churn
// ---------------------------------------------------------------------------

/** Churn analysis by a dimension. */
export interface ChurnBreakdown {
  label: string;
  /** Number of customers lost. */
  logoChurn: number;
  /** Revenue lost from churned customers. */
  revenueChurn: number;
  /** Churn rate as a percentage. */
  churnRate: number;
}

/** Result of a churn calculation. */
export interface ChurnResult {
  /** Gross revenue churn rate (% of starting revenue lost, before expansion). */
  grossChurn: number;
  /** Net revenue churn rate (% lost after accounting for expansion). */
  netChurn: number;
  /** Logo (customer count) churn rate. */
  logoChurnRate: number;
  /** Number of customers who churned. */
  logoChurnCount: number;
  /** Total revenue churned in USD. */
  revenueChurned: number;
  /** Churn broken down by cancellation reason. */
  byReason: ChurnBreakdown[];
  /** Churn broken down by customer segment. */
  bySegment: ChurnBreakdown[];
  /** Churn broken down by plan. */
  byPlan: ChurnBreakdown[];
  /** Churn broken down by tenure (months since signup). */
  byTenure: ChurnBreakdown[];
  /** Period start date. */
  periodStart: string;
  /** Period end date. */
  periodEnd: string;
}

// ---------------------------------------------------------------------------
// Unit Economics
// ---------------------------------------------------------------------------

/** Unit economics broken down by acquisition channel. */
export interface ChannelEconomics {
  channel: string;
  /** Customer acquisition cost for this channel. */
  cac: number;
  /** Estimated lifetime value of customers from this channel. */
  ltv: number;
  /** LTV / CAC ratio. */
  ltvCacRatio: number;
  /** Months to pay back CAC. */
  paybackMonths: number;
  /** Number of customers acquired through this channel. */
  customersAcquired: number;
  /** Total spend on this channel. */
  totalSpend: number;
}

/** Result of a unit economics calculation. */
export interface UnitEconomics {
  /** Blended customer acquisition cost. */
  cac: number;
  /** Estimated customer lifetime value. */
  ltv: number;
  /** LTV / CAC ratio (target: > 3.0). */
  ltvCacRatio: number;
  /** Months to pay back CAC (target: < 18). */
  paybackMonths: number;
  /** Gross margin percentage used in LTV calculation. */
  grossMargin: number;
  /** Average revenue per account (ARPA) per month. */
  arpa: number;
  /** Breakdown by acquisition channel. */
  byChannel: ChannelEconomics[];
  /** The period for which these economics were calculated. */
  period: string;
}

// ---------------------------------------------------------------------------
// Cohort Analysis
// ---------------------------------------------------------------------------

/** Retention data for a single cohort. */
export interface CohortData {
  /** The month this cohort signed up (YYYY-MM format). */
  cohortMonth: string;
  /** Number of customers in the cohort at signup. */
  customers: number;
  /** Total starting revenue for the cohort. */
  revenue: number;
  /**
   * Retention by period (month offset from signup).
   * Index 0 = month 0 (signup month, always 100%).
   * Index N = month N relative to signup.
   * Value is a percentage (0-100) of the original cohort revenue retained.
   */
  retention: number[];
  /**
   * Customer retention by period (month offset from signup).
   * Same indexing as `retention` but for logo counts.
   */
  customerRetention: number[];
  /** Average revenue per customer at signup. */
  avgRevenueAtSignup: number;
  /** Average revenue per *remaining* customer at the latest period. */
  avgRevenueLatest: number;
}
