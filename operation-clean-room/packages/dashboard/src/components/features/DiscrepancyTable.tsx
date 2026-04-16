import { AlertTriangle, CheckCircle2, DollarSign, RefreshCw } from 'lucide-react';
import { getDiscrepancies, runReconciliation } from '@/api/client';
import { useApi } from '@/hooks/useApi';
import { Card } from '@/components/ui/Card';
import { Table } from '@/components/ui/Table';
import type { Discrepancy } from '@/types';

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

type Row = Record<string, unknown> & {
  id: string;
  customerName: string;
  severity: string;
  type: string;
  systems: string;
  amount: number;
  exposureScope: 'Billing exposure' | 'Pipeline delta';
  description: string;
  resolved: boolean;
};

function isBillingExposure(item: Discrepancy): boolean {
  return (
    item.sourceA.system === 'chargebee' ||
    item.sourceA.system === 'stripe' ||
    item.sourceB.system === 'chargebee' ||
    item.sourceB.system === 'stripe'
  );
}

function toRows(discrepancies: Discrepancy[]): Row[] {
  return discrepancies.map((item) => ({
    id: item.id,
    customerName: item.customerName,
    severity: item.severity,
    type: item.type.replace(/_/g, ' '),
    systems: `${item.sourceA.system} -> ${item.sourceB.system}`,
    amount: item.amount ?? 0,
    exposureScope: isBillingExposure(item) ? 'Billing exposure' : 'Pipeline delta',
    description: item.description,
    resolved: item.resolved,
  }));
}

export function DiscrepancyTable() {
  const run = useApi(['reconciliation', 'run'], () => runReconciliation(), {
    staleTime: 5 * 60 * 1000,
  });
  const list = useApi(['reconciliation', 'discrepancies'], () => getDiscrepancies({ limit: 100 }), {
    enabled: run.isSuccess,
  });

  const discrepancies = list.data?.data ?? run.data?.discrepancies ?? [];
  const rows = toRows(discrepancies);
  const highRisk = discrepancies.filter(
    (item) => item.severity === 'critical' || item.severity === 'high',
  ).length;
  const totalImpact =
    run.data?.summary.totalAmountImpact ??
    discrepancies
      .filter(isBillingExposure)
      .reduce((sum, item) => sum + Math.abs(item.amount ?? 0), 0);
  const pipelineReviews = discrepancies.filter((item) => !isBillingExposure(item)).length;

  return (
    <div className="space-y-6 p-6">
      <div className="border-b border-slate-800 pb-5">
        <p className="metric-label mb-2">Revenue Reconciliation</p>
        <h1 className="text-2xl font-semibold text-slate-100">Discrepancies</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-400">
          Billing, CRM, and duplicate checks are rebuilt from source exports with every row tied
          back to source systems and record IDs. Billing exposure is the current close-period
          billing risk; pipeline deltas are CRM/bookings cleanup findings and are not included in
          that exposure total.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card
          title="Open Items"
          value={run.isLoading ? 'Loading' : discrepancies.length}
          icon={<AlertTriangle size={18} />}
        />
        <Card title="High Risk" value={highRisk} icon={<RefreshCw size={18} />} />
        <Card
          title="Billing Exposure"
          value={currencyFormatter.format(totalImpact)}
          icon={<DollarSign size={18} />}
        />
        <Card title="Pipeline Reviews" value={pipelineReviews} icon={<DollarSign size={18} />} />
      </div>

      {run.error || list.error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-5 text-sm text-red-200">
          {(run.error ?? list.error)?.message}
        </div>
      ) : (
        <Table
          data={rows}
          rowKey={(row) => row.id}
          emptyMessage="No discrepancies above the configured thresholds."
          columns={[
            { key: 'customerName', label: 'Customer', sortable: true },
            { key: 'severity', label: 'Severity', sortable: true },
            { key: 'type', label: 'Type', sortable: true },
            { key: 'systems', label: 'Systems' },
            {
              key: 'amount',
              label: 'Row Delta',
              sortable: true,
              render: (value) => currencyFormatter.format(Number(value ?? 0)),
              className: 'text-right font-mono',
            },
            {
              key: 'exposureScope',
              label: 'Exposure Scope',
              sortable: true,
              render: (value) =>
                value === 'Billing exposure' ? (
                  <span className="rounded-md border border-emerald-500/30 bg-emerald-950/30 px-2 py-1 text-xs text-emerald-200">
                    Included
                  </span>
                ) : (
                  <span className="rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-300">
                    Pipeline only
                  </span>
                ),
            },
            { key: 'description', label: 'Finding' },
            {
              key: 'resolved',
              label: 'Status',
              render: (value) =>
                value ? (
                  <span className="inline-flex items-center gap-1 text-emerald-300">
                    <CheckCircle2 size={14} /> Resolved
                  </span>
                ) : (
                  <span className="text-amber-300">Open</span>
                ),
            },
          ]}
        />
      )}
    </div>
  );
}
