import { FileSearch, Link2, Clock3 } from 'lucide-react';
import { getAuditTrail } from '@/api/client';
import { useApi } from '@/hooks/useApi';
import { Card } from '@/components/ui/Card';
import { Table } from '@/components/ui/Table';
import type { AuditEntry } from '@/types';

type AuditRow = Record<string, unknown> & {
  id: string;
  entity: string;
  action: string;
  entityId: string;
  summary: string;
  route: string;
  sourceRefs: string;
  timestamp: string;
};

function formatEntityLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

function summarizeEntry(entry: AuditEntry): string {
  if (entry.entity === 'discrepancy') {
    const amount = typeof entry.after?.amount === 'number' ? entry.after.amount.toLocaleString() : null;
    const type = typeof entry.after?.type === 'string' ? entry.after.type.replace(/_/g, ' ') : 'discrepancy';
    return amount == null ? type : `${type} (${amount})`;
  }

  if (entry.entity === 'metric') {
    const value =
      typeof entry.after?.value === 'number'
        ? entry.after.value.toLocaleString()
        : typeof entry.after?.percentage === 'number'
          ? `${entry.after.percentage.toFixed(2)}%`
          : typeof entry.after?.cohortCount === 'number'
            ? `${entry.after.cohortCount} cohorts`
            : null;
    return value == null ? entry.entityId : `${entry.entityId}: ${value}`;
  }

  if (entry.entity === 'cohort') {
    const retention =
      typeof entry.after?.latestRetention === 'number'
        ? `${entry.after.latestRetention.toFixed(1)}% latest retention`
        : null;
    return retention == null ? entry.entityId : `${entry.entityId}: ${retention}`;
  }

  return entry.entityId;
}

function extractSourceRefs(entry: AuditEntry): string {
  const sourceA = entry.metadata?.sourceA as { system?: string; recordId?: string } | undefined;
  const sourceB = entry.metadata?.sourceB as { system?: string; recordId?: string } | undefined;
  const sourceRecords = Array.isArray(entry.metadata?.sourceRecords)
    ? (entry.metadata?.sourceRecords as Array<{ system?: string; recordId?: string }>)
    : [];

  const refs = [
    sourceA?.system && sourceA?.recordId ? `${sourceA.system}:${sourceA.recordId}` : null,
    sourceB?.system && sourceB?.recordId ? `${sourceB.system}:${sourceB.recordId}` : null,
    ...sourceRecords.slice(0, 4).map((record) =>
      record.system && record.recordId ? `${record.system}:${record.recordId}` : null,
    ),
  ].filter((value): value is string => value != null);

  if (sourceRecords.length > 4) {
    refs.push(`+${sourceRecords.length - 4} more`);
  }

  return refs.length === 0 ? 'n/a' : Array.from(new Set(refs)).join(', ');
}

function toRows(entries: AuditEntry[]): AuditRow[] {
  return entries.map((entry) => ({
    id: entry.id,
    entity: formatEntityLabel(entry.entity),
    action: entry.action.replace(/_/g, ' '),
    entityId: entry.entityId,
    summary: summarizeEntry(entry),
    route: typeof entry.metadata?.route === 'string' ? entry.metadata.route : 'n/a',
    sourceRefs: extractSourceRefs(entry),
    timestamp: new Date(entry.timestamp).toISOString(),
  }));
}

export function AuditTrail() {
  const { data, isLoading, error } = useApi(['audit', 'trail'], () => getAuditTrail({ limit: 250 }), {
    staleTime: 5 * 60 * 1000,
  });

  const entries = data?.data ?? [];
  const rows = toRows(entries);
  const entityCount = new Set(entries.map((entry) => `${entry.entity}:${entry.entityId}`)).size;
  const latestTimestamp = entries[0]?.timestamp ? new Date(entries[0].timestamp).toISOString() : 'n/a';

  return (
    <div className="space-y-6 p-6">
      <div className="border-b border-slate-800 pb-5">
        <p className="metric-label mb-2">Audit Trail</p>
        <h1 className="text-2xl font-semibold text-slate-100">Source Traceability</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-400">
          Metric calculations and reconciliation findings are emitted as auditable entries with the
          route used, entity affected, and underlying source-record references needed for review.
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
              title="Audit Entries"
              value={isLoading ? 'Loading' : rows.length}
              icon={<FileSearch size={18} />}
            />
            <Card
              title="Tracked Entities"
              value={isLoading ? 'Loading' : entityCount}
              icon={<Link2 size={18} />}
            />
            <Card
              title="Latest Timestamp"
              value={isLoading ? 'Loading' : latestTimestamp}
              icon={<Clock3 size={18} />}
            />
          </div>

          <Table
            data={rows}
            rowKey={(row) => row.id}
            emptyMessage="No audit entries were returned."
            columns={[
              { key: 'entity', label: 'Entity', sortable: true },
              { key: 'action', label: 'Action', sortable: true },
              { key: 'entityId', label: 'Entity ID', sortable: true },
              {
                key: 'summary',
                label: 'Summary',
                className: 'max-w-[18rem] whitespace-normal break-words',
              },
              {
                key: 'sourceRefs',
                label: 'Source records',
                className: 'max-w-[18rem] whitespace-normal break-words text-xs text-slate-400',
              },
              { key: 'route', label: 'Route' },
              { key: 'timestamp', label: 'Timestamp', sortable: true },
            ]}
          />
        </>
      )}
    </div>
  );
}
