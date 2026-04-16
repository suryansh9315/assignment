/* ─────────────────────────────────────────────────────────────────────────────
 * Shared frontend types
 *
 * Mirrors the backend domain models and adds dashboard-specific types for
 * UI state, charting, and navigation.
 * ───────────────────────────────────────────────────────────────────────────── */

// ── Health ───────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  uptime: number;
}

// ── Revenue & ARR ────────────────────────────────────────────────────────────

export interface ARRBreakdown {
  label?: string;
  arr?: number;
  customerCount?: number;
  percentOfTotal?: number;
  total: number;
  newBusiness: number;
  expansion: number;
  contraction: number;
  churn: number;
}

export interface ARRSegmentBreakdown {
  label: string;
  arr: number;
  customerCount: number;
  percentOfTotal: number;
}

export interface ARRResult {
  total: number;
  bySegment: ARRSegmentBreakdown[];
  byPlan: ARRSegmentBreakdown[];
  byRegion: ARRSegmentBreakdown[];
  byCohort: ARRSegmentBreakdown[];
  asOfDate: string;
  totalCustomers: number;
  avgARRPerCustomer: number;
  medianARRPerCustomer: number;
}

export interface MonthlyRevenueSummary {
  month: string;
  arr: number;
  mrrRunRate: number;
  newBusiness: number;
  expansion: number;
  contraction: number;
  churn: number;
  customerCount: number;
  byPlan: ARRSegmentBreakdown[];
}

export interface RevenueTimingIssue {
  id: string;
  source: 'chargebee' | 'stripe' | 'legacy';
  customerName: string;
  description: string;
  amount: number;
  date: string;
  severity: 'medium' | 'high';
}

export interface RevenueSummaryResult {
  asOfDate: string;
  currentARR: ARRResult;
  monthly: MonthlyRevenueSummary[];
  planMix: ARRSegmentBreakdown[];
  timingIssues: RevenueTimingIssue[];
}

export interface RevenueOverview {
  currentARR: number;
  previousARR: number;
  arrGrowthRate: number;
  mrr: number;
  nrr: number;
  grossRetention: number;
  ltv: number;
  cac: number;
  ltvCacRatio: number;
  paybackMonths: number;
}

// ── Churn ────────────────────────────────────────────────────────────────────

export interface ChurnMetrics {
  grossChurn: number;
  netChurn: number;
  logoChurnRate: number;
  logoChurnCount: number;
  revenueChurned: number;
  byReason?: unknown[];
  bySegment?: unknown[];
  byPlan?: unknown[];
  byTenure?: unknown[];
  periodStart: string;
  periodEnd: string;
}

// ── NRR ──────────────────────────────────────────────────────────────────────

export interface NRRResponse {
  percentage: number;
  expansion: number;
  contraction: number;
  churn: number;
  startingARR: number;
  endingARR: number;
  breakdown: unknown[];
  periodStart: string;
  periodEnd: string;
}

// ── Unit Economics ────────────────────────────────────────────────────────────

export interface UnitEconomics {
  cac: number;
  ltv: number;
  ltvCacRatio: number;
  paybackMonths: number;
  grossMargin?: number;
  arpa?: number;
  byChannel?: {
    channel: string;
    cac: number;
    ltv: number;
    ltvCacRatio: number;
    paybackMonths: number;
    customersAcquired: number;
    totalSpend: number;
  }[];
  period: string;
}

// ── Cohorts ──────────────────────────────────────────────────────────────────

export interface CohortRow {
  cohort?: string;
  cohortMonth?: string;
  size?: number;
  customers?: number;
  retention: number[];
  revenue: number[] | number;
  customerRetention?: number[];
  avgRevenueAtSignup?: number;
  avgRevenueLatest?: number;
}

export type CohortResponse = CohortRow[];

// ── Reconciliation & Discrepancies ───────────────────────────────────────────

export type DiscrepancySeverity = 'critical' | 'high' | 'medium' | 'low';
export type DiscrepancyType =
  | 'amount_mismatch'
  | 'missing_account'
  | 'date_mismatch'
  | 'status_mismatch'
  | 'duplicate_account'
  | 'orphan_record'
  | 'fx_discrepancy';
export type DiscrepancyStatus = 'open' | 'investigating' | 'resolved' | 'dismissed';

export interface Discrepancy {
  id: string;
  type: DiscrepancyType;
  severity: DiscrepancySeverity;
  sourceA: {
    system: string;
    recordId: string;
    value: string | number | null;
  };
  sourceB: {
    system: string;
    recordId: string;
    value: string | number | null;
  };
  customerName: string;
  amount: number | null;
  percentDelta?: number | null;
  direction?: string | null;
  scope?: 'billing_vs_crm' | 'billing_vs_billing' | 'duplicate_review' | 'pipeline_review';
  description: string;
  detectedAt: string;
  resolved: boolean;
  resolutionNote: string | null;
}

export interface ReconciliationResult {
  discrepancies: Discrepancy[];
  summary: {
    totalDiscrepancies: number;
    bySeverity: Record<DiscrepancySeverity, number>;
    byType: Record<DiscrepancyType, number>;
    totalAmountImpact: number;
    recordsProcessed: Record<string, number>;
  };
  metadata: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
    options: Record<string, unknown>;
  };
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

export interface PipelineDeal {
  id: string;
  name: string;
  stage: string;
  amount: number;
  probability: number;
  daysInStage: number;
  lastActivity: string;
  isZombie: boolean;
  healthScore: number;
}

export interface PipelineQuality {
  zombieDeals: {
    opportunityId: string;
    accountName: string;
    amount: number;
    stage: string;
    daysSinceActivity: number;
  }[];
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
  unbookedRevenue: {
    subscriptionId: string;
    customerName: string;
    mrr: number;
    system: string;
  }[];
  summary: {
    totalZombieDeals: number;
    totalZombieValue: number;
    totalMismatches: number;
    totalUnbookedMRR: number;
    pipelineHealthScore: number;
  };
}

// ── Customer Health ──────────────────────────────────────────────────────────

export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface CustomerHealth {
  customerId: string;
  name: string;
  healthScore: number;
  grade: HealthGrade;
  signals: {
    usage: number;
    support: number;
    payment: number;
    engagement: number;
    nps: number | null;
  };
  arr: number;
  plan: string;
  churnRisk: number;
  lastActivity: string;
}

// ── Scenarios ────────────────────────────────────────────────────────────────

export interface ScenarioInput {
  label?: string;
  churnRateDelta: number;
  expansionRateDelta: number;
  newBusinessDelta: number;
  priceDelta: number;
  costDelta: number;
}

export interface ScenarioProjection {
  month: string;
  arr: number;
  mrr: number;
  customers: number;
}

export interface ScenarioResult {
  label: string;
  input: ScenarioInput;
  projections: ScenarioProjection[];
  endingARR: number;
  arrChange: number;
  arrChangePercent: number;
  impactBreakdown: {
    churnImpact: number;
    expansionImpact: number;
    newBusinessImpact: number;
    priceImpact: number;
  };
}

export interface ScenarioPreset {
  id: string;
  label: string;
  description: string;
  input: ScenarioInput;
}

// ── Audit Trail ──────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  entity: string;
  entityId: string;
  userId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

// ── Metrics Overview ─────────────────────────────────────────────────────────

export interface MetricsOverview {
  arr: ARRBreakdown;
  nrr: number;
  churn: ChurnMetrics;
  unitEconomics: UnitEconomics;
  customerCount: number;
  discrepancyCount: number;
  healthDistribution: Record<HealthGrade, number>;
}

// ── Frontend-Specific Types ──────────────────────────────────────────────────

export interface FilterState {
  dateRange: {
    start: string;
    end: string;
  };
  plan: string | null;
  region: string | null;
  segment: string | null;
}

export interface ChartDataPoint {
  label: string;
  [key: string]: string | number;
}

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

export interface TableColumn<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (value: unknown, row: T) => React.ReactNode;
  className?: string;
  width?: string;
}

export interface NavigationItem {
  path: string;
  label: string;
  icon: string;
  badge?: string | number;
}

export interface SortState {
  key: string;
  direction: 'asc' | 'desc';
}

// ── API Response Wrappers ────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface ReconciliationFilters extends PaginationParams {
  severity?: DiscrepancySeverity;
  type?: DiscrepancyType;
  status?: DiscrepancyStatus;
  sort?: string;
}
