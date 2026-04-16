import {
  AlertTriangle,
  BarChart3,
  DollarSign,
  FileWarning,
  Users,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getRevenueSummary } from '@/api/client';
import { useApi } from '@/hooks/useApi';
import { Card } from '@/components/ui/Card';
import type { RevenueSummaryResult } from '@/types';

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const compactCurrencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

const movementColors = {
  newBusiness: '#22c55e',
  expansion: '#3b82f6',
  contraction: '#f59e0b',
  churn: '#ef4444',
};

const planColors = ['#3b82f6', '#22c55e', '#f59e0b', '#14b8a6', '#ec4899'];

type TooltipPayload = {
  name?: string;
  value?: number;
  color?: string;
  payload?: Record<string, unknown>;
};

type OutlierSummary = {
  hasOutlier: boolean;
  outlierMonth: string | null;
  outlierValue: number;
  previousPeak: number;
  ratioToPreviousPeak: number;
  fullDomainMax: number;
  baselineDomainMax: number;
};

function formatCurrency(value: number): string {
  return currencyFormatter.format(value);
}

function formatCompactCurrency(value: number): string {
  return compactCurrencyFormatter.format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function roundAxisMax(value: number): number {
  if (value <= 0) return 0;

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;

  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function getMonthLabel(month: string): string {
  const [year, monthNumber] = month.split('-');
  const date = new Date(Number(year), Number(monthNumber) - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function getOutlierSummary(points: Array<{ month: string; value: number }>): OutlierSummary {
  const sorted = [...points].sort((a, b) => b.value - a.value);
  const largest = sorted[0];
  const secondLargest = sorted[1];

  if (!largest) {
    return {
      hasOutlier: false,
      outlierMonth: null,
      outlierValue: 0,
      previousPeak: 0,
      ratioToPreviousPeak: 0,
      fullDomainMax: 0,
      baselineDomainMax: 0,
    };
  }

  if (!secondLargest) {
    const domain = roundAxisMax(largest.value * 1.1);
    return {
      hasOutlier: false,
      outlierMonth: largest.month,
      outlierValue: largest.value,
      previousPeak: largest.value,
      ratioToPreviousPeak: 1,
      fullDomainMax: domain,
      baselineDomainMax: domain,
    };
  }

  const hasOutlier =
    largest.value >= secondLargest.value * 4 && largest.value - secondLargest.value >= 100_000;

  return {
    hasOutlier,
    outlierMonth: largest.month,
    outlierValue: largest.value,
    previousPeak: secondLargest.value,
    ratioToPreviousPeak:
      secondLargest.value === 0 ? 0 : Number((largest.value / secondLargest.value).toFixed(1)),
    fullDomainMax: roundAxisMax(largest.value * 1.08),
    baselineDomainMax: roundAxisMax((hasOutlier ? secondLargest.value : largest.value) * 1.15),
  };
}

function getARRChange(data: RevenueSummaryResult): number {
  const firstMonth = data.monthly[0];
  const lastMonth = data.monthly[data.monthly.length - 1];
  if (!firstMonth || !lastMonth || firstMonth.arr === 0) return 0;

  return ((lastMonth.arr - firstMonth.arr) / firstMonth.arr) * 100;
}

function getLatestMonthlyGrowth(data: RevenueSummaryResult): number {
  const latest = data.monthly[data.monthly.length - 1];
  const previous = data.monthly[data.monthly.length - 2];
  if (!latest || !previous || previous.arr === 0) return 0;

  return ((latest.arr - previous.arr) / previous.arr) * 100;
}

function getMovementData(data: RevenueSummaryResult) {
  return data.monthly.map((point) => ({
    month: getMonthLabel(point.month),
    newBusiness: point.newBusiness,
    expansion: point.expansion,
    contraction: -point.contraction,
    churn: -point.churn,
  }));
}

function getPlanTrendData(data: RevenueSummaryResult) {
  const planLabels = data.planMix.slice(0, 5).map((plan) => plan.label);

  return data.monthly.map((point) => {
    const row: Record<string, string | number> = { month: getMonthLabel(point.month) };
    for (const label of planLabels) {
      row[label] = point.byPlan.find((plan) => plan.label === label)?.arr ?? 0;
    }
    return row;
  });
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 shadow-xl">
      <div className="mb-1 font-mono text-xs font-semibold text-slate-300">{label}</div>
      <div className="space-y-1">
        {payload.map((item) => (
          <div key={item.name} className="flex items-center justify-between gap-5 text-xs">
            <span className="flex items-center gap-2 text-slate-400">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              {item.name}
            </span>
            <span className="font-mono text-slate-100">
              {formatCompactCurrency(Number(item.value ?? 0))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OutlierNotice({
  summary,
  label,
}: {
  summary: OutlierSummary;
  label: string;
}) {
  if (!summary.hasOutlier || !summary.outlierMonth) return null;

  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-950/20 px-3 py-2 text-xs text-sky-100">
      <span className="font-semibold text-sky-200">{label} baseline zoom:</span>{' '}
      {getMonthLabel(summary.outlierMonth)} reaches {formatCompactCurrency(summary.outlierValue)},
      about {summary.ratioToPreviousPeak}x the prior peak of{' '}
      {formatCompactCurrency(summary.previousPeak)}. The companion zoom keeps earlier months readable.
    </div>
  );
}

function LoadingState() {
  return (
    <div className="p-6">
      <div className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-8 text-center">
        <div className="mx-auto mb-4 h-10 w-10 animate-pulse rounded-md bg-slate-700" />
        <h2 className="mb-2 text-xl font-semibold text-slate-300">Revenue Summary</h2>
        <p className="text-slate-500">Loading clean ARR from billing systems...</p>
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="p-6">
      <div className="card rounded-lg border border-red-500/40 bg-red-950/30 p-8 text-center">
        <AlertTriangle className="mx-auto mb-3 text-red-300" />
        <h2 className="mb-2 text-xl font-semibold text-red-100">Revenue Summary Failed</h2>
        <p className="text-sm text-red-200">{message}</p>
      </div>
    </div>
  );
}

export function RevenueSummary() {
  const { data, isLoading, error } = useApi(
    ['metrics', 'revenue-summary', '2024-01'],
    () => getRevenueSummary({ startMonth: '2024-01' }),
  );

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!data) return null;

  const arrChange = getARRChange(data);
  const latestGrowth = getLatestMonthlyGrowth(data);
  const latestMonth = data.monthly[data.monthly.length - 1];
  const arrChartData = data.monthly.map((point) => ({
    month: getMonthLabel(point.month),
    ARR: point.arr,
    'MRR run rate': point.mrrRunRate,
  }));
  const movementData = getMovementData(data);
  const planTrendData = getPlanTrendData(data);
  const planLabels = data.planMix.slice(0, 5).map((plan) => plan.label);
  const arrOutlier = getOutlierSummary(
    data.monthly.map((point) => ({ month: point.month, value: point.arr })),
  );
  const movementOutlier = getOutlierSummary(
    movementData.map((point, index) => ({
      month: data.monthly[index]?.month ?? point.month,
      value:
        Math.max(point.newBusiness + point.expansion, Math.abs(point.contraction) + Math.abs(point.churn)),
    })),
  );
  const planTrendOutlier = getOutlierSummary(
    data.monthly.map((point) => ({
      month: point.month,
      value: point.byPlan.reduce((sum, plan) => sum + plan.arr, 0),
    })),
  );
  const movementNegativePeak = Math.max(
    ...movementData.map((point) => Math.abs(point.contraction) + Math.abs(point.churn)),
    0,
  );
  const movementFullDomain = Math.max(
    movementOutlier.fullDomainMax,
    roundAxisMax(movementNegativePeak * 1.1),
  );
  const movementBaselineDomain = Math.max(
    movementOutlier.baselineDomainMax,
    roundAxisMax(movementNegativePeak * 1.1),
  );

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 border-b border-slate-800 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="metric-label mb-2">Board Revenue View</p>
          <h1 className="text-2xl font-semibold text-slate-100">Revenue Summary</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            ARR is rebuilt from Chargebee, non-duplicative Stripe streams, and legacy
            invoices, with trials excluded and timing issues separated for review.
          </p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3">
          <div className="metric-label">As of</div>
          <div className="font-mono text-sm text-slate-200">
            {new Date(data.asOfDate).toLocaleDateString()}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card
          title="Clean ARR"
          value={formatCurrency(data.currentARR.total)}
          change={arrChange}
          changeLabel="since Jan 2024"
          icon={<DollarSign size={18} />}
        />
        <Card
          title="MRR Run Rate"
          value={formatCurrency(latestMonth?.mrrRunRate ?? 0)}
          change={latestGrowth}
          changeLabel="latest month"
          icon={<BarChart3 size={18} />}
        />
        <Card
          title="Paying Customers"
          value={data.currentARR.totalCustomers.toLocaleString()}
          icon={<Users size={18} />}
        >
          <p className="mt-2 text-xs text-slate-500">
            Median ARR {formatCurrency(data.currentARR.medianARRPerCustomer)}
          </p>
        </Card>
        <Card
          title="Timing Flags"
          value={data.timingIssues.length}
          icon={<FileWarning size={18} />}
          className={data.timingIssues.some((issue) => issue.severity === 'high') ? 'glow-border-amber' : ''}
        >
          <p className="mt-2 text-xs text-slate-500">Not full ASC 606 revenue recognition</p>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-5">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-slate-100">ARR and MRR Run Rate</h2>
            <p className="mt-1 text-sm text-slate-500">
              Month-end ARR snapshots with monthly recurring run-rate shown for explainability.
            </p>
          </div>
          <div className="space-y-4">
            <OutlierNotice summary={arrOutlier} label="ARR and MRR" />
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={arrChartData}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} />
                  <YAxis
                    tickFormatter={formatCompactCurrency}
                    tick={{ fill: '#64748b', fontSize: 11 }}
                    tickLine={false}
                    width={72}
                    domain={[0, arrOutlier.fullDomainMax]}
                    allowDataOverflow
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ color: '#94a3b8', fontSize: 12 }} />
                  <Area
                    dataKey="ARR"
                    name="ARR"
                    stroke="#3b82f6"
                    fill="#3b82f6"
                    fillOpacity={0.15}
                    strokeWidth={2}
                  />
                  <Area
                    dataKey="MRR run rate"
                    name="MRR run rate"
                    stroke="#22c55e"
                    fill="#22c55e"
                    fillOpacity={0.08}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            {arrOutlier.hasOutlier ? (
              <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Baseline Zoom
                </div>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={arrChartData}>
                      <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} />
                      <YAxis
                        tickFormatter={formatCompactCurrency}
                        tick={{ fill: '#64748b', fontSize: 11 }}
                        tickLine={false}
                        width={72}
                        domain={[0, arrOutlier.baselineDomainMax]}
                        allowDataOverflow
                      />
                      <Tooltip content={<ChartTooltip />} />
                      <Area
                        dataKey="ARR"
                        name="ARR"
                        stroke="#3b82f6"
                        fill="#3b82f6"
                        fillOpacity={0.15}
                        strokeWidth={2}
                      />
                      <Area
                        dataKey="MRR run rate"
                        name="MRR run rate"
                        stroke="#22c55e"
                        fill="#22c55e"
                        fillOpacity={0.08}
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        <section className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-5">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-slate-100">Plan Mix</h2>
            <p className="mt-1 text-sm text-slate-500">
              Current ARR by plan tier, including Meridian legacy naming.
            </p>
          </div>
          <div className="space-y-4">
            {data.planMix.map((plan, index) => (
              <div key={plan.label}>
                <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                  <span className="truncate text-slate-300">{plan.label}</span>
                  <span className="font-mono text-slate-100">{formatCurrency(plan.arr)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-900">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${plan.percentOfTotal}%`,
                      backgroundColor: planColors[index % planColors.length],
                    }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-xs text-slate-500">
                  <span>{plan.customerCount} customers</span>
                  <span>{formatPercent(plan.percentOfTotal)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-5">
        <div className="mb-5 flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">ARR Waterfall</h2>
            <p className="mt-1 text-sm text-slate-500">
              Monthly movement split into new business, expansion, contraction, and churn.
            </p>
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-400">
            Contraction and churn are plotted below zero.
          </div>
        </div>
        <div className="space-y-4">
          <OutlierNotice summary={movementOutlier} label="Waterfall" />
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={movementData}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} />
                <YAxis
                  tickFormatter={formatCompactCurrency}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  tickLine={false}
                  width={72}
                  domain={[-movementFullDomain, movementFullDomain]}
                  allowDataOverflow
                />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ color: '#94a3b8', fontSize: 12 }} />
                <Bar dataKey="newBusiness" name="New business" stackId="positive" fill={movementColors.newBusiness} />
                <Bar dataKey="expansion" name="Expansion" stackId="positive" fill={movementColors.expansion} />
                <Bar dataKey="contraction" name="Contraction" stackId="negative" fill={movementColors.contraction} />
                <Bar dataKey="churn" name="Churn" stackId="negative" fill={movementColors.churn} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {movementOutlier.hasOutlier ? (
            <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Baseline Zoom
              </div>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={movementData}>
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} />
                    <YAxis
                      tickFormatter={formatCompactCurrency}
                      tick={{ fill: '#64748b', fontSize: 11 }}
                      tickLine={false}
                      width={72}
                      domain={[-movementBaselineDomain, movementBaselineDomain]}
                      allowDataOverflow
                    />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="newBusiness" name="New business" stackId="positive" fill={movementColors.newBusiness} />
                    <Bar dataKey="expansion" name="Expansion" stackId="positive" fill={movementColors.expansion} />
                    <Bar dataKey="contraction" name="Contraction" stackId="negative" fill={movementColors.contraction} />
                    <Bar dataKey="churn" name="Churn" stackId="negative" fill={movementColors.churn} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
        <section className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-5">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-slate-100">Plan Tier Trend</h2>
            <p className="mt-1 text-sm text-slate-500">Month-end ARR by current plan family.</p>
          </div>
          <div className="space-y-4">
            <OutlierNotice summary={planTrendOutlier} label="Plan tier" />
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={planTrendData}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} />
                  <YAxis
                    tickFormatter={formatCompactCurrency}
                    tick={{ fill: '#64748b', fontSize: 11 }}
                    tickLine={false}
                    width={72}
                    domain={[0, planTrendOutlier.fullDomainMax]}
                    allowDataOverflow
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ color: '#94a3b8', fontSize: 12 }} />
                  {planLabels.map((label, index) => (
                    <Bar key={label} dataKey={label} stackId="plan" name={label}>
                      {planTrendData.map((row) => (
                        <Cell
                          key={`${label}-${row.month}`}
                          fill={planColors[index % planColors.length]}
                        />
                      ))}
                    </Bar>
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            {planTrendOutlier.hasOutlier ? (
              <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Baseline Zoom
                </div>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={planTrendData}>
                      <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} />
                      <YAxis
                        tickFormatter={formatCompactCurrency}
                        tick={{ fill: '#64748b', fontSize: 11 }}
                        tickLine={false}
                        width={72}
                        domain={[0, planTrendOutlier.baselineDomainMax]}
                        allowDataOverflow
                      />
                      <Tooltip content={<ChartTooltip />} />
                      {planLabels.map((label, index) => (
                        <Bar key={label} dataKey={label} stackId="plan" name={label}>
                          {planTrendData.map((row) => (
                            <Cell
                              key={`${label}-${row.month}`}
                              fill={planColors[index % planColors.length]}
                            />
                          ))}
                        </Bar>
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        <section className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-5">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-slate-100">Recognition Timing Review</h2>
            <p className="mt-1 text-sm text-slate-500">
              Items to keep out of clean ARR narrative until Finance reviews timing.
            </p>
          </div>
          <div className="max-h-80 overflow-auto rounded-lg border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="table-header">
                <tr>
                  <th className="px-3 py-2 font-medium text-slate-400">Customer</th>
                  <th className="px-3 py-2 font-medium text-slate-400">Source</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-400">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.timingIssues.map((issue) => (
                  <tr key={`${issue.source}-${issue.id}`} className="table-row">
                    <td className="px-3 py-3">
                      <div className="font-medium text-slate-200">{issue.customerName}</div>
                      <div className="mt-1 line-clamp-2 text-xs text-slate-500">
                        {issue.description}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-300">
                        {issue.source}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-slate-100">
                      {formatCurrency(issue.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
