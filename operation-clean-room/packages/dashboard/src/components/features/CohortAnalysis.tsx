import {
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  Line,
  LineChart,
} from 'recharts';
import { getARR, getChurn, getCohorts, getNRR, getUnitEconomics } from '@/api/client';
import { useApi } from '@/hooks/useApi';
import { Card } from '@/components/ui/Card';
import { Table } from '@/components/ui/Table';
import type { CohortRow as ApiCohortRow } from '@/types';

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

type CohortTableRow = Record<string, unknown> & {
  id: string;
  cohort: string;
  customers: number;
  revenue: number;
  month0: number;
  month3: number | null;
  month6: number | null;
  latest: number;
  periodsTracked: number;
};

type QuarterWindow = {
  label: string;
  period: string;
  startDate: string;
  endDate: string;
};

function formatQuarterWindow(asOfDateIso: string | undefined): QuarterWindow {
  const asOfDate = asOfDateIso ? new Date(asOfDateIso) : new Date();
  const currentQuarterStartMonth = Math.floor(asOfDate.getUTCMonth() / 3) * 3;
  const currentQuarterStart = new Date(Date.UTC(asOfDate.getUTCFullYear(), currentQuarterStartMonth, 1));
  const previousQuarterStart = new Date(currentQuarterStart);
  previousQuarterStart.setUTCMonth(previousQuarterStart.getUTCMonth() - 3);
  const previousQuarterEnd = new Date(currentQuarterStart);
  const quarterNumber = Math.floor(previousQuarterStart.getUTCMonth() / 3) + 1;

  return {
    label: `Q${quarterNumber} ${previousQuarterStart.getUTCFullYear()}`,
    period: `${previousQuarterStart.getUTCFullYear()}-Q${quarterNumber}`,
    startDate: previousQuarterStart.toISOString().slice(0, 10),
    endDate: previousQuarterEnd.toISOString().slice(0, 10),
  };
}

function formatRetention(value: number | null | undefined): string {
  return value == null ? 'n/a' : `${value.toFixed(1)}%`;
}

function toRows(cohorts: ApiCohortRow[]): CohortTableRow[] {
  return cohorts.map((row) => ({
    id: row.cohortMonth ?? row.cohort ?? 'unknown',
    cohort: row.cohortMonth ?? row.cohort ?? 'Unknown',
    customers: row.customers ?? row.size ?? 0,
    revenue: typeof row.revenue === 'number' ? row.revenue : 0,
    month0: row.retention[0] ?? 0,
    month3: row.retention.length > 3 ? row.retention[3] ?? null : null,
    month6: row.retention.length > 6 ? row.retention[6] ?? null : null,
    latest: row.retention[row.retention.length - 1] ?? 0,
    periodsTracked: row.retention.length,
  }));
}

function buildCurveData(cohorts: ApiCohortRow[]) {
  const selected = cohorts
    .filter((row) => row.retention.length > 1)
    .slice(-6);
  const maxPeriods = selected.reduce((max, row) => Math.max(max, row.retention.length), 0);

  return Array.from({ length: maxPeriods }, (_, index) => {
    const point: Record<string, string | number | null> = {
      monthOffset: `M${index}`,
    };

    for (const row of selected) {
      point[row.cohortMonth ?? row.cohort ?? 'Unknown'] = row.retention[index] ?? null;
    }

    return point;
  });
}

const chartPalette = ['#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#14b8a6', '#f97316'];

export function CohortAnalysis() {
  const arr = useApi(['metrics', 'arr', 'cohort-analysis'], () => getARR(), {
    staleTime: 5 * 60 * 1000,
  });
  const quarterWindow = formatQuarterWindow(arr.data?.asOfDate);
  const cohorts = useApi(['metrics', 'cohorts', '2024-01'], () =>
    getCohorts({ startMonth: '2024-01' }),
  );
  const nrr = useApi(
    ['metrics', 'nrr', quarterWindow.startDate, quarterWindow.endDate],
    () => getNRR({ startDate: quarterWindow.startDate, endDate: quarterWindow.endDate }),
    { enabled: arr.isSuccess },
  );
  const churn = useApi(
    ['metrics', 'churn', quarterWindow.startDate, quarterWindow.endDate],
    () => getChurn({ startDate: quarterWindow.startDate, endDate: quarterWindow.endDate }),
    { enabled: arr.isSuccess },
  );
  const unitEconomics = useApi(
    ['metrics', 'unit-economics', quarterWindow.period],
    () => getUnitEconomics(quarterWindow.period),
    { enabled: arr.isSuccess },
  );

  const cohortRows = cohorts.data ?? [];
  const rows = toRows(cohortRows);
  const chartData = buildCurveData(cohortRows);
  const displayedCohorts = cohortRows.filter((row) => row.retention.length > 1).slice(-6);
  const hasError = arr.error || cohorts.error || nrr.error || churn.error || unitEconomics.error;

  return (
    <div className="space-y-6 p-6">
      <div className="border-b border-slate-800 pb-5">
        <p className="metric-label mb-2">Retention Metrics</p>
        <h1 className="text-2xl font-semibold text-slate-100">Cohort Analysis</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-400">
          Revenue retention follows original signup month, with curves plotted by month offset and
          summary cards aligned to the latest completed quarter before the current ARR snapshot.
        </p>
      </div>

      {hasError ? (
        <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-5 text-sm text-red-200">
          {(arr.error ?? cohorts.error ?? nrr.error ?? churn.error ?? unitEconomics.error)?.message}
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Card
              title={`${quarterWindow.label} NRR`}
              value={nrr.isLoading ? 'Loading' : formatRetention(nrr.data?.percentage)}
            />
            <Card
              title={`${quarterWindow.label} Gross Churn`}
              value={churn.isLoading ? 'Loading' : formatRetention(churn.data?.grossChurn)}
            />
            <Card
              title={`${quarterWindow.label} Logo Churn`}
              value={churn.isLoading ? 'Loading' : formatRetention(churn.data?.logoChurnRate)}
            />
            <Card
              title={`${quarterWindow.period} LTV / CAC`}
              value={
                unitEconomics.isLoading
                  ? 'Loading'
                  : `${(unitEconomics.data?.ltvCacRatio ?? 0).toFixed(1)}x`
              }
            />
          </div>

          <section className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-5">
            <h2 className="mb-2 text-lg font-semibold text-slate-100">Retention Curves</h2>
            <p className="mb-5 text-sm text-slate-400">
              Showing the six most recent cohorts with at least two observed months.
            </p>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="monthOffset" tick={{ fill: '#64748b', fontSize: 11 }} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 11 }} unit="%" />
                  <Tooltip formatter={(value) => formatRetention(typeof value === 'number' ? value : Number(value))} />
                  {displayedCohorts.map((row, index) => (
                    <Line
                      key={row.cohortMonth ?? row.cohort ?? String(index)}
                      type="monotone"
                      dataKey={row.cohortMonth ?? row.cohort ?? `Cohort ${index + 1}`}
                      stroke={chartPalette[index % chartPalette.length]}
                      connectNulls={false}
                      dot={false}
                      strokeWidth={2}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <Table
            data={rows}
            rowKey={(row) => row.id}
            emptyMessage="No cohorts were returned for the selected window."
            columns={[
              { key: 'cohort', label: 'Cohort', sortable: true },
              { key: 'customers', label: 'Customers', sortable: true },
              {
                key: 'revenue',
                label: 'Signup ARR',
                sortable: true,
                render: (value) => currencyFormatter.format(Number(value ?? 0)),
                className: 'text-right font-mono',
              },
              {
                key: 'month0',
                label: 'Month 0',
                render: (value) => formatRetention(typeof value === 'number' ? value : Number(value)),
                className: 'text-right font-mono',
              },
              {
                key: 'month3',
                label: 'Month 3',
                render: (value) =>
                  formatRetention(typeof value === 'number' || value == null ? value : Number(value)),
                className: 'text-right font-mono',
              },
              {
                key: 'month6',
                label: 'Month 6',
                render: (value) =>
                  formatRetention(typeof value === 'number' || value == null ? value : Number(value)),
                className: 'text-right font-mono',
              },
              {
                key: 'latest',
                label: 'Latest',
                render: (value) => formatRetention(typeof value === 'number' ? value : Number(value)),
                className: 'text-right font-mono',
              },
              { key: 'periodsTracked', label: 'Periods', sortable: true, className: 'text-right font-mono' },
            ]}
          />
        </>
      )}
    </div>
  );
}
