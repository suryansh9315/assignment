import { AlertTriangle, Gauge, HeartPulse, LifeBuoy, Wallet } from 'lucide-react';
import { getCustomerHealth } from '@/api/client';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table } from '@/components/ui/Table';
import { useApi } from '@/hooks/useApi';
import type { CustomerHealth as CustomerHealthRow } from '@/types';

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

type TableRow = Record<string, unknown> &
  CustomerHealthRow & {
    id: string;
  };

const gradeBadgeVariant: Record<CustomerHealthRow['grade'], 'success' | 'info' | 'warning' | 'error'> = {
  A: 'success',
  B: 'info',
  C: 'warning',
  D: 'error',
  F: 'error',
};

function formatPercent(value: number): string {
  return `${value.toFixed(0)}%`;
}

function getSignalTone(value: number): string {
  if (value >= 80) return 'bg-emerald-400';
  if (value >= 65) return 'bg-blue-400';
  if (value >= 50) return 'bg-amber-400';
  return 'bg-red-400';
}

function SignalBar({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  const safeValue = value ?? 0;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-500">
        <span>{label}</span>
        <span className="font-mono text-slate-300">{value === null ? 'n/a' : safeValue}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-900">
        <div
          className={`h-full rounded-full ${getSignalTone(safeValue)}`}
          style={{ width: `${Math.max(6, safeValue)}%` }}
        />
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="p-6">
      <div className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-8 text-center">
        <div className="mx-auto mb-4 h-10 w-10 animate-pulse rounded-md bg-slate-700" />
        <h2 className="mb-2 text-xl font-semibold text-slate-300">Customer Health</h2>
        <p className="text-slate-500">Scoring customer usage, support, billing, and NPS signals...</p>
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="p-6">
      <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-6 text-center">
        <AlertTriangle className="mx-auto mb-3 text-red-300" />
        <h2 className="mb-2 text-xl font-semibold text-red-100">Customer Health Failed</h2>
        <p className="text-sm text-red-200">{message}</p>
      </div>
    </div>
  );
}

export function CustomerHealth() {
  const { data, isLoading, error } = useApi(['metrics', 'customer-health'], () =>
    getCustomerHealth({ sort: 'churnRisk:desc' }),
  );

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!data) return null;

  const rows: TableRow[] = data.data.map((row) => ({
    ...row,
    id: row.customerId,
  }));
  const averageScore =
    rows.length > 0 ? Math.round(rows.reduce((sum, row) => sum + row.healthScore, 0) / rows.length) : 0;
  const atRiskRows = rows.filter((row) => row.healthScore < 55);
  const atRiskArr = atRiskRows.reduce((sum, row) => sum + row.arr, 0);
  const lowNpsCount = rows.filter((row) => row.signals.nps !== null && row.signals.nps < 70).length;
  const supportStressCount = rows.filter((row) => row.signals.support < 50).length;
  const distribution = ['A', 'B', 'C', 'D', 'F'].map((grade) => ({
    grade,
    count: rows.filter((row) => row.grade === grade).length,
  }));
  const topRiskRows = rows.slice(0, 8);

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 border-b border-slate-800 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="metric-label mb-2">Board Retention View</p>
          <h1 className="text-2xl font-semibold text-slate-100">Customer Health</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Defensible churn scoring built from product activity, support burden, billing friction,
            and NPS recency. Accounts with multiple weak signals rise to the top of the risk queue.
          </p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3">
          <div className="metric-label">Accounts scored</div>
          <div className="font-mono text-sm text-slate-200">{rows.length}</div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Average Health" value={averageScore} icon={<Gauge size={18} />}>
          <p className="mt-2 text-xs text-slate-500">Weighted across usage, support, billing, NPS, and engagement</p>
        </Card>
        <Card title="At-Risk Accounts" value={atRiskRows.length} icon={<AlertTriangle size={18} />}>
          <p className="mt-2 text-xs text-slate-500">Scores below 55 are flagged for proactive outreach</p>
        </Card>
        <Card title="ARR Exposed" value={currencyFormatter.format(atRiskArr)} icon={<Wallet size={18} />}>
          <p className="mt-2 text-xs text-slate-500">Current ARR tied to D and F grade customers</p>
        </Card>
        <Card title="Low NPS Signals" value={lowNpsCount} icon={<HeartPulse size={18} />}>
          <p className="mt-2 text-xs text-slate-500">{supportStressCount} accounts also show support stress</p>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <section className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-5">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-slate-100">Highest Churn Risk</h2>
            <p className="mt-1 text-sm text-slate-500">
              Highest-risk accounts sorted by combined churn probability and weak-signal concentration.
            </p>
          </div>
          <div className="grid gap-3">
            {topRiskRows.map((row) => (
              <div
                key={row.customerId}
                className="rounded-lg border border-slate-700 bg-slate-900/70 p-4"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-100">{row.name}</h3>
                      <Badge variant={gradeBadgeVariant[row.grade]}>{row.grade}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {row.plan} plan · ARR {currencyFormatter.format(row.arr)}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-right">
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-slate-500">Health</div>
                      <div className="font-mono text-lg text-slate-100">{row.healthScore}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-slate-500">Churn Risk</div>
                      <div className="font-mono text-lg text-red-300">{formatPercent(row.churnRisk)}</div>
                    </div>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                  <SignalBar label="Usage" value={row.signals.usage} />
                  <SignalBar label="Support" value={row.signals.support} />
                  <SignalBar label="Billing" value={row.signals.payment} />
                  <SignalBar label="Engagement" value={row.signals.engagement} />
                  <SignalBar label="NPS" value={row.signals.nps} />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-5">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-slate-100">Portfolio Mix</h2>
            <p className="mt-1 text-sm text-slate-500">
              Grade distribution for the current customer base, useful for board-level retention framing.
            </p>
          </div>
          <div className="space-y-4">
            {distribution.map((item) => {
              const percent = rows.length > 0 ? (item.count / rows.length) * 100 : 0;
              return (
                <div key={item.grade}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <Badge variant={gradeBadgeVariant[item.grade as CustomerHealthRow['grade']]}>
                        {item.grade}
                      </Badge>
                      <span className="text-slate-300">{item.count} accounts</span>
                    </div>
                    <span className="font-mono text-slate-100">{percent.toFixed(1)}%</span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-slate-900">
                    <div
                      className={getSignalTone(
                        item.grade === 'A' ? 90 : item.grade === 'B' ? 72 : item.grade === 'C' ? 55 : 35,
                      )}
                      style={{ width: `${Math.max(percent, item.count > 0 ? 6 : 0)}%`, height: '100%' }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-6 rounded-lg border border-slate-700 bg-slate-900/70 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
              <LifeBuoy size={16} />
              Intervention Triggers
            </div>
            <div className="space-y-3">
              <SignalBar
                label="Weak support signal"
                value={100 - Math.round((supportStressCount / Math.max(rows.length, 1)) * 100)}
              />
              <SignalBar
                label="Weak NPS signal"
                value={100 - Math.round((lowNpsCount / Math.max(rows.length, 1)) * 100)}
              />
              <SignalBar
                label="At-risk coverage gap"
                value={100 - Math.round((atRiskRows.length / Math.max(rows.length, 1)) * 100)}
              />
            </div>
          </div>
        </section>
      </div>

      <section className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-5">
        <div className="mb-5">
          <h2 className="text-lg font-semibold text-slate-100">Customer-Level Detail</h2>
          <p className="mt-1 text-sm text-slate-500">
            Use this table to identify which specific signal is pushing each account toward churn risk.
          </p>
        </div>
        <Table
          data={rows}
          rowKey={(row) => row.id}
          emptyMessage="No scored accounts found."
          columns={[
            {
              key: 'name',
              label: 'Customer',
              sortable: true,
              render: (_value, row) => (
                <div>
                  <div className="font-medium text-slate-100">{row.name}</div>
                  <div className="mt-1 text-xs text-slate-500">{row.plan}</div>
                </div>
              ),
            },
            {
              key: 'grade',
              label: 'Grade',
              sortable: true,
              render: (value) => (
                <Badge variant={gradeBadgeVariant[value as CustomerHealthRow['grade']]}>
                  {String(value)}
                </Badge>
              ),
            },
            {
              key: 'healthScore',
              label: 'Health',
              sortable: true,
              className: 'font-mono text-right',
            },
            {
              key: 'churnRisk',
              label: 'Churn Risk',
              sortable: true,
              className: 'font-mono text-right',
              render: (value) => formatPercent(Number(value ?? 0)),
            },
            {
              key: 'arr',
              label: 'ARR',
              sortable: true,
              className: 'font-mono text-right',
              render: (value) => currencyFormatter.format(Number(value ?? 0)),
            },
            {
              key: 'signals',
              label: 'Signal Snapshot',
              render: (value) => {
                const signals = value as CustomerHealthRow['signals'];
                return (
                  <div className="grid min-w-[14rem] gap-2">
                    <SignalBar label="Usage" value={signals.usage} />
                    <SignalBar label="Support" value={signals.support} />
                    <SignalBar label="Billing" value={signals.payment} />
                  </div>
                );
              },
            },
          ]}
        />
      </section>
    </div>
  );
}
