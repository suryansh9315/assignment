import type {
  HealthResponse,
  ReconciliationResult,
  Discrepancy,
  PipelineQuality as PipelineQualityType,
  ARRResult,
  RevenueSummaryResult,
  NRRResponse,
  ChurnMetrics,
  UnitEconomics,
  CohortResponse,
  MetricsOverview,
  ScenarioInput,
  ScenarioResult,
  ScenarioPreset,
  CustomerHealth,
  AuditEntry,
  ReconciliationFilters,
  ApiResponse,
} from '@/types';

const API_BASE = '/api';

// ── Fetch helpers ────────────────────────────────────────────────────────────

class ApiClientError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    throw new ApiClientError(
      `API request failed: ${response.status} ${response.statusText}`,
      response.status,
      body,
    );
  }

  return response.json() as Promise<T>;
}

function buildQueryString(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  if (entries.length === 0) return '';
  const searchParams = new URLSearchParams();
  for (const [key, value] of entries) {
    searchParams.set(key, String(value));
  }
  return `?${searchParams.toString()}`;
}

// ── Health ───────────────────────────────────────────────────────────────────

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export function runReconciliation(
  options?: { dateStart?: string; dateEnd?: string; tolerance?: number },
): Promise<ReconciliationResult> {
  return request<ReconciliationResult>('/reconciliation/run', {
    method: 'POST',
    body: JSON.stringify(options ?? {}),
  });
}

export function getDiscrepancies(
  filters?: ReconciliationFilters,
): Promise<ApiResponse<Discrepancy[]>> {
  const qs = filters ? buildQueryString(filters as unknown as Record<string, unknown>) : '';
  return request<ApiResponse<Discrepancy[]>>(`/reconciliation/discrepancies${qs}`);
}

export function getDiscrepancy(id: string): Promise<Discrepancy> {
  return request<Discrepancy>(`/reconciliation/discrepancies/${id}`);
}

export function resolveDiscrepancy(
  id: string,
  note: string,
): Promise<Discrepancy> {
  return request<Discrepancy>(`/reconciliation/discrepancies/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ resolutionNote: note }),
  });
}

export function getDuplicates(
  classification?: string,
): Promise<ApiResponse<unknown[]>> {
  const qs = classification ? buildQueryString({ classification }) : '';
  return request<ApiResponse<Discrepancy[]>>(`/reconciliation/duplicates${qs}`);
}

export function getPipelineQuality(): Promise<PipelineQualityType> {
  return request<PipelineQualityType>('/reconciliation/pipeline');
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export function getARR(options?: {
  date?: string;
  segmentBy?: string;
  excludeTrials?: boolean;
}): Promise<ARRResult> {
  const qs = options ? buildQueryString(options) : '';
  return request<ARRResult>(`/metrics/arr${qs}`);
}

export function getRevenueSummary(options?: {
  startMonth?: string;
  endMonth?: string;
  excludeTrials?: boolean;
}): Promise<RevenueSummaryResult> {
  const qs = options ? buildQueryString(options) : '';
  return request<RevenueSummaryResult>(`/metrics/revenue-summary${qs}`);
}

export function getNRR(options: {
  startDate: string;
  endDate: string;
  segmentBy?: string;
}): Promise<NRRResponse> {
  const qs = buildQueryString(options);
  return request<NRRResponse>(`/metrics/nrr${qs}`);
}

export function getChurn(options: {
  startDate: string;
  endDate: string;
}): Promise<ChurnMetrics> {
  const qs = buildQueryString(options);
  return request<ChurnMetrics>(`/metrics/churn${qs}`);
}

export function getUnitEconomics(period: string): Promise<UnitEconomics> {
  const qs = buildQueryString({ period });
  return request<UnitEconomics>(`/metrics/unit-economics${qs}`);
}

export function getCohorts(options?: {
  startMonth?: string;
  endMonth?: string;
  granularity?: string;
}): Promise<CohortResponse> {
  const qs = options ? buildQueryString(options) : '';
  return request<CohortResponse>(`/metrics/cohorts${qs}`);
}

export function getMetricsOverview(): Promise<MetricsOverview> {
  return request<MetricsOverview>('/metrics/overview');
}

// ── Customer Health ──────────────────────────────────────────────────────────

export function getCustomerHealth(options?: {
  grade?: string;
  minScore?: number;
  maxScore?: number;
  sort?: string;
  page?: number;
  limit?: number;
}): Promise<ApiResponse<CustomerHealth[]>> {
  const qs = options ? buildQueryString(options) : '';
  return request<ApiResponse<CustomerHealth[]>>(`/metrics/customer-health${qs}`);
}

// ── Scenarios ────────────────────────────────────────────────────────────────

export function runScenario(input: ScenarioInput): Promise<ScenarioResult> {
  return request<ScenarioResult>('/scenarios/run', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getScenarioPresets(): Promise<ScenarioPreset[]> {
  return request<ScenarioPreset[]>('/scenarios/presets');
}

export function compareScenarios(
  inputs: ScenarioInput[],
): Promise<ScenarioResult[]> {
  return request<ScenarioResult[]>('/scenarios/compare', {
    method: 'POST',
    body: JSON.stringify(inputs),
  });
}

// ── Audit Trail ──────────────────────────────────────────────────────────────

export function getAuditTrail(options?: {
  entity?: string;
  entityId?: string;
  action?: string;
  page?: number;
  limit?: number;
}): Promise<ApiResponse<AuditEntry[]>> {
  const qs = options ? buildQueryString(options) : '';
  return request<ApiResponse<AuditEntry[]>>(`/audit${qs}`);
}
