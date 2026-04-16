import { FileSearch, Link2 } from 'lucide-react';
import { runReconciliation } from '@/api/client';
import { useApi } from '@/hooks/useApi';
import { Card } from '@/components/ui/Card';
import { Table } from '@/components/ui/Table';

type AuditRow = Record<string, unknown> & {
  id: string;
  metric: string;
  sourceRecord: string;
  comparedRecord: string;
  customerName: string;
  detectedAt: string;
};

export function AuditTrail() {
  const { data, isLoading, error } = useApi(['audit', 'reconciliation-sources'], () =>
    runReconciliation(),
  );
  const rows: AuditRow[] =
    data?.discrepancies.map((item) => ({
      id: item.id,
      metric: item.type.replace(/_/g, ' '),
      sourceRecord: `${item.sourceA.system}:${item.sourceA.recordId}`,
      comparedRecord: `${item.sourceB.system}:${item.sourceB.recordId}`,
      customerName: item.customerName,
      detectedAt: new Date(item.detectedAt).toLocaleString(),
    })) ?? [];

  return (
    <div className="space-y-6 p-6">
      <div className="border-b border-slate-800 pb-5">
        <p className="metric-label mb-2">Audit Trail</p>
        <h1 className="text-2xl font-semibold text-slate-100">Source Traceability</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-400">
          Every reconciliation finding carries the source system, source record, compared system,
          and compared record needed for auditor review.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-5 text-sm text-red-200">
          {error.message}
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card
              title="Traceable Findings"
              value={isLoading ? 'Loading' : rows.length}
              icon={<FileSearch size={18} />}
            />
            <Card
              title="Sources Processed"
              value={Object.keys(data?.summary.recordsProcessed ?? {}).length}
              icon={<Link2 size={18} />}
            />
            <Card title="Run Duration" value={`${data?.metadata.durationMs ?? 0}ms`} />
          </div>

          <Table
            data={rows}
            rowKey={(row) => row.id}
            emptyMessage="No auditable discrepancies in the latest run."
            columns={[
              { key: 'customerName', label: 'Customer', sortable: true },
              { key: 'metric', label: 'Finding', sortable: true },
              { key: 'sourceRecord', label: 'Source record' },
              { key: 'comparedRecord', label: 'Compared record' },
              { key: 'detectedAt', label: 'Detected' },
            ]}
          />
        </>
      )}
    </div>
  );
}
