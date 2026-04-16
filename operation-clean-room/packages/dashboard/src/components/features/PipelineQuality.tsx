import { Activity, AlertTriangle, BadgeDollarSign, Gauge } from 'lucide-react';
import { getPipelineQuality } from '@/api/client';
import { useApi } from '@/hooks/useApi';
import { Card } from '@/components/ui/Card';
import { Table } from '@/components/ui/Table';

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

type ZombieRow = Record<string, unknown> & {
  id: string;
  accountName: string;
  stage: string;
  amount: number;
  daysSinceActivity: number;
};

type MismatchRow = Record<string, unknown> & {
  id: string;
  accountName: string;
  issue: string;
  crmValue: string | number;
  billingValue: string | number;
  billingSystems: string[];
  percentDelta: number;
  direction: 'over-reporting' | 'under-reporting';
};

function formatCurrencyValue(value: string | number | null | undefined): string {
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) ? currencyFormatter.format(numericValue) : 'n/a';
}

function formatBillingSystems(value: string[] | null | undefined): string {
  if (!Array.isArray(value) || value.length === 0) return 'n/a';
  return Array.from(new Set(value)).join(', ');
}

export function PipelineQuality() {
  const { data, isLoading, error } = useApi(['reconciliation', 'pipeline'], getPipelineQuality);
  const zombies: ZombieRow[] =
    data?.zombieDeals.map((deal) => ({ id: deal.opportunityId, ...deal })) ?? [];
  const mismatches: MismatchRow[] =
    data?.mismatches.map((item) => ({ id: item.opportunityId, ...item })) ?? [];

  return (
    <div className="space-y-6 p-6">
      <div className="border-b border-slate-800 pb-5">
        <p className="metric-label mb-2">CRM Audit</p>
        <h1 className="text-2xl font-semibold text-slate-100">Pipeline Quality</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-400">
          Closed-won opportunities are checked against the active total across Stripe, Chargebee,
          and Meridian legacy billing, with mismatches flagged once billing drifts more than 2%
          from CRM.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-5 text-sm text-red-200">
          {error.message}
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Card
              title="Health Score"
              value={isLoading ? 'Loading' : data?.summary.pipelineHealthScore ?? 0}
              icon={<Gauge size={18} />}
            />
            <Card
              title="Zombie Deals"
              value={isLoading ? 'Loading' : data?.summary.totalZombieDeals ?? 0}
              icon={<AlertTriangle size={18} />}
            />
            <Card
              title="Zombie Value"
              value={isLoading ? 'Loading' : currencyFormatter.format(data?.summary.totalZombieValue ?? 0)}
              icon={<BadgeDollarSign size={18} />}
            />
            <Card
              title="Unbooked MRR"
              value={isLoading ? 'Loading' : currencyFormatter.format(data?.summary.totalUnbookedMRR ?? 0)}
              icon={<Activity size={18} />}
            />
          </div>

          <section className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-5">
            <h2 className="mb-4 text-lg font-semibold text-slate-100">Zombie Deals</h2>
            <Table
              data={zombies}
              rowKey={(row) => row.id}
              emptyMessage="No stale open opportunities crossed the zombie threshold."
              columns={[
                { key: 'accountName', label: 'Account', sortable: true },
                { key: 'stage', label: 'Stage', sortable: true },
                {
                  key: 'amount',
                  label: 'Amount',
                  sortable: true,
                  render: (value) => currencyFormatter.format(Number(value ?? 0)),
                  className: 'text-right font-mono',
                },
                { key: 'daysSinceActivity', label: 'Days stale', sortable: true },
              ]}
            />
          </section>

          <section className="card rounded-lg border border-slate-700/50 bg-slate-800/80 p-5">
            <h2 className="mb-4 text-lg font-semibold text-slate-100">Billing Mismatches</h2>
            <Table
              data={mismatches}
              rowKey={(row) => row.id}
              emptyMessage="No closed-won billing mismatches found."
              columns={[
                { key: 'accountName', label: 'Account', sortable: true },
                { key: 'issue', label: 'Finding' },
                {
                  key: 'billingSystems',
                  label: 'Billing systems',
                  width: '10rem',
                  className: 'max-w-[10rem] whitespace-normal break-words text-xs text-slate-400',
                  render: (value) => formatBillingSystems(Array.isArray(value) ? value as string[] : undefined),
                },
                {
                  key: 'crmValue',
                  label: 'CRM value',
                  className: 'text-right font-mono',
                  render: (value) => formatCurrencyValue(value as string | number | null | undefined),
                },
                {
                  key: 'billingValue',
                  label: 'Billing value',
                  className: 'text-right font-mono',
                  render: (value) => formatCurrencyValue(value as string | number | null | undefined),
                },
                {
                  key: 'percentDelta',
                  label: 'Delta %',
                  className: 'text-right font-mono',
                  render: (value) => `${Number(value ?? 0).toFixed(2)}%`,
                },
                { key: 'direction', label: 'Direction', sortable: true },
              ]}
            />
          </section>
        </>
      )}
    </div>
  );
}
