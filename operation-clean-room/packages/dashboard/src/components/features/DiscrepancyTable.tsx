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
  scope: string;
  systems: string;
  sourceAValue: number | null;
  sourceBValue: number | null;
  percentDelta: number | null;
  direction: string;
  amount: number;
  description: string;
  resolved: boolean;
};

function getScopeLabel(item: Discrepancy): string {
  switch (item.scope) {
    case 'billing_vs_crm':
      return 'CRM mismatch';
    case 'billing_vs_billing':
      return 'Billing cross-check';
    case 'duplicate_review':
      return 'Duplicate review';
    default:
      return 'Review';
  }
}

function toRows(discrepancies: Discrepancy[]): Row[] {
  return discrepancies.map((item) => ({
    id: item.id,
    customerName: item.customerName,
    severity: item.severity,
    type: item.type.replace(/_/g, ' '),
    scope: getScopeLabel(item),
    systems: `${item.sourceA.system} vs ${item.sourceB.system}`,
    sourceAValue: typeof item.sourceA.value === 'number' ? item.sourceA.value : null,
    sourceBValue: typeof item.sourceB.value === 'number' ? item.sourceB.value : null,
    percentDelta: item.percentDelta ?? null,
    direction: item.direction ?? 'Review needed',
    amount: item.amount ?? 0,
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
      .filter((item) => item.scope === 'billing_vs_crm')
      .reduce((sum, item) => sum + Math.abs(item.amount ?? 0), 0);
  const crmMismatches = discrepancies.filter((item) => item.scope === 'billing_vs_crm').length;
  const billingCrossChecks = discrepancies.filter((item) => item.scope === 'billing_vs_billing').length;

  return (
    <div className="space-y-6 p-6">
      <div className="border-b border-slate-800 pb-5">
        <p className="metric-label mb-2">Revenue Reconciliation</p>
        <h1 className="text-2xl font-semibold text-slate-100">Discrepancies</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-400">
          Stripe, Chargebee, Meridian legacy, and Salesforce are rebuilt from source exports on
          each run. The headline delta is a gross sum of billing-versus-CRM mismatches above 2%,
          so it can exceed clean ARR when CRM amounts are overstated across many accounts. The
          table keeps the system pair, mismatch direction, and side-by-side amounts visible for
          review.
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
          title="Gross CRM Delta"
          value={currencyFormatter.format(totalImpact)}
          icon={<DollarSign size={18} />}
        />
        <Card title="CRM Mismatches" value={crmMismatches} icon={<DollarSign size={18} />} />
        <Card title="Billing Cross-Checks" value={billingCrossChecks} icon={<RefreshCw size={18} />} />
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
            { key: 'scope', label: 'Scope', sortable: true },
            {
              key: 'systems',
              label: 'Systems',
              width: '10rem',
              className: 'max-w-[10rem] whitespace-normal break-words text-xs text-slate-400',
            },
            {
              key: 'sourceAValue',
              label: 'Source A',
              sortable: true,
              render: (value) =>
                value == null ? 'n/a' : currencyFormatter.format(Number(value ?? 0)),
              className: 'text-right font-mono',
            },
            {
              key: 'sourceBValue',
              label: 'Source B',
              sortable: true,
              render: (value) =>
                value == null ? 'n/a' : currencyFormatter.format(Number(value ?? 0)),
              className: 'text-right font-mono',
            },
            {
              key: 'percentDelta',
              label: 'Delta %',
              sortable: true,
              render: (value) =>
                value == null ? 'n/a' : `${Number(value).toFixed(2)}%`,
              className: 'text-right font-mono',
            },
            { key: 'direction', label: 'Direction', sortable: true },
            {
              key: 'amount',
              label: 'Dollar Impact',
              sortable: true,
              render: (value) => currencyFormatter.format(Number(value ?? 0)),
              className: 'text-right font-mono',
            },
            {
              key: 'description',
              label: 'Finding',
              className: 'max-w-[18rem] whitespace-normal break-words',
            },
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
