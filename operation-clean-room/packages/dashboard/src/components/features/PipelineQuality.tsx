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
};

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
          Closed-won opportunities are checked against billing, and stale open deals are separated
          from board-ready pipeline.
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
              value={data?.summary.totalZombieDeals ?? 0}
              icon={<AlertTriangle size={18} />}
            />
            <Card
              title="Zombie Value"
              value={currencyFormatter.format(data?.summary.totalZombieValue ?? 0)}
              icon={<BadgeDollarSign size={18} />}
            />
            <Card
              title="Unbooked MRR"
              value={currencyFormatter.format(data?.summary.totalUnbookedMRR ?? 0)}
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
                { key: 'crmValue', label: 'CRM value', className: 'text-right font-mono' },
                { key: 'billingValue', label: 'Billing value', className: 'text-right font-mono' },
              ]}
            />
          </section>
        </>
      )}
    </div>
  );
}
