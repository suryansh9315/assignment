import { ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, Line, LineChart } from 'recharts';
import { getChurn, getCohorts, getNRR, getUnitEconomics } from '@/api/client';
import { useApi } from '@/hooks/useApi';
import { Card } from '@/components/ui/Card';
import { Table } from '@/components/ui/Table';

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

type CohortRow = Record<string, unknown> & {
  id: string;
  cohort: string;
  customers: number;
  revenue: number;
  month0: number;
  month3: number;
  month6: number;
  latest: number;
};

export function CohortAnalysis() {
  const cohorts = useApi(['metrics', 'cohorts'], () =>
    getCohorts({ startMonth: '2024-01' }),
  );
  const nrr = useApi(['metrics', 'nrr', 'q4'], () =>
    getNRR({ startDate: '2024-10-01', endDate: '2025-01-01' }),
  );
  const churn = useApi(['metrics', 'churn', 'q4'], () =>
    getChurn({ startDate: '2024-10-01', endDate: '2025-01-01' }),
  );
  const unitEconomics = useApi(['metrics', 'unit-economics', '2024-Q4'], () =>
    getUnitEconomics('2024-Q4'),
  );

  const rows: CohortRow[] = (cohorts.data ?? []).map((row) => {
    const revenue = Array.isArray(row.revenue) ? Number(row.revenue[0] ?? 0) : row.revenue;
    return {
      id: row.cohortMonth ?? row.cohort ?? 'unknown',
      cohort: row.cohortMonth ?? row.cohort ?? 'Unknown',
      customers: row.customers ?? row.size ?? 0,
      revenue,
      month0: row.retention[0] ?? 0,
      month3: row.retention[3] ?? 0,
      month6: row.retention[6] ?? 0,
      latest: row.retention[row.retention.length - 1] ?? 0,
    };
  });
  const chartData = rows.slice(0, 8).map((row) => ({
    cohort: row.cohort,
    'Month 0': row.month0,
    'Month 3': row.month3,
    'Month 6': row.month6,
    Latest: row.latest,
  }));

  return (
    <div className="space-y-6 p-6">
      <div className="border-b border-slate-800 pb-5">
        <p className="metric-label mb-2">Retention Metrics</p>
        <h1 className="text-2xl font-semibold text-slate-100">Cohort Analysis</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-400">
          Revenue retention follows the original signup month and compares active ARR snapshots
          through the latest billing month.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card title="Q4 NRR" value={`${(nrr.data?.percentage ?? 0).toFixed(1)}%`} />
        <Card title="Gross Churn" value={`${(churn.data?.grossChurn ?? 0).toFixed(1)}%`} />
        <Card title="Logo Churn" value={`${(churn.data?.logoChurnRate ?? 0).toFixed(1)}%`} />
        <Card
          title="LTV / CAC"
          value={`${(unitEconomics.data?.ltvCacRatio ?? 0).toFixed(1)}x`}
        />
      </div>

      <section className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-5">
        <h2 className="mb-5 text-lg font-semibold text-slate-100">Retention Curves</h2>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="cohort" tick={{ fill: '#64748b', fontSize: 11 }} />
              <YAxis tick={{ fill: '#64748b', fontSize: 11 }} unit="%" />
              <Tooltip />
              <Line type="monotone" dataKey="Month 0" stroke="#22c55e" />
              <Line type="monotone" dataKey="Month 3" stroke="#3b82f6" />
              <Line type="monotone" dataKey="Month 6" stroke="#f59e0b" />
              <Line type="monotone" dataKey="Latest" stroke="#ec4899" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <Table
        data={rows}
        rowKey={(row) => row.id}
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
          { key: 'month3', label: 'Month 3', render: (value) => `${Number(value ?? 0).toFixed(1)}%` },
          { key: 'month6', label: 'Month 6', render: (value) => `${Number(value ?? 0).toFixed(1)}%` },
          { key: 'latest', label: 'Latest', render: (value) => `${Number(value ?? 0).toFixed(1)}%` },
        ]}
      />
    </div>
  );
}
