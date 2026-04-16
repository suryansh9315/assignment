import { Router } from 'express';
import { calculateARR, getDefaultARRAsOfDate, getUnifiedARRRecords } from '../metrics/arr.js';
import { calculateNRR } from '../metrics/nrr.js';
import { calculateChurn } from '../metrics/churn.js';
import { calculateUnitEconomics } from '../metrics/unit-economics.js';
import { buildCohortAnalysis } from '../metrics/cohorts.js';
import { runFullReconciliation } from './reconciliation.js';

type AuditEntry = {
  id: string;
  timestamp: string;
  action: string;
  entity: string;
  entityId: string;
  userId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
};

export const auditRouter = Router();

auditRouter.get('/', async (req, res, next) => {
  try {
    const asOfDate = await getDefaultARRAsOfDate();
    const quarterWindow = getPreviousQuarterWindow(asOfDate);
    const [arr, arrRecords, nrr, churn, unitEconomics, cohorts, reconciliation] = await Promise.all([
      calculateARR(asOfDate),
      getUnifiedARRRecords(asOfDate),
      calculateNRR(quarterWindow.startDate, quarterWindow.endDate, { excludeChurned: false }),
      calculateChurn(quarterWindow.startDate, quarterWindow.endDate, { excludeChurned: false }),
      calculateUnitEconomics(quarterWindow.period),
      buildCohortAnalysis({ startDate: new Date('2024-01-01T00:00:00Z') }),
      runFullReconciliation({}),
    ]);

    const entries = buildAuditEntries({
      asOfDate,
      arr,
      arrRecords,
      nrr,
      churn,
      unitEconomics,
      cohorts,
      reconciliation,
    });

    const filtered = entries
      .filter((entry) =>
        typeof req.query.entity === 'string' ? entry.entity === req.query.entity : true,
      )
      .filter((entry) =>
        typeof req.query.entityId === 'string' ? entry.entityId === req.query.entityId : true,
      )
      .filter((entry) =>
        typeof req.query.action === 'string' ? entry.action === req.query.action : true,
      )
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp));

    return res.json({
      data: filtered,
      meta: {
        total: filtered.length,
        asOfDate: asOfDate.toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

function buildAuditEntries(input: {
  asOfDate: Date;
  arr: Awaited<ReturnType<typeof calculateARR>>;
  arrRecords: Awaited<ReturnType<typeof getUnifiedARRRecords>>;
  nrr: Awaited<ReturnType<typeof calculateNRR>>;
  churn: Awaited<ReturnType<typeof calculateChurn>>;
  unitEconomics: Awaited<ReturnType<typeof calculateUnitEconomics>>;
  cohorts: Awaited<ReturnType<typeof buildCohortAnalysis>>;
  reconciliation: Awaited<ReturnType<typeof runFullReconciliation>>;
}): AuditEntry[] {
  const timestamp = new Date().toISOString();
  const metricUser = 'system:metrics';
  const reconciliationUser = 'system:reconciliation';
  const arrSources = input.arrRecords.map((record) => ({
    system: record.source,
    recordId: record.sourceRecordId,
    customerKey: record.customerKey,
    companyName: record.companyName,
    arr: record.arr,
  }));

  const entries: AuditEntry[] = [
    {
      id: 'audit-arr-total',
      timestamp,
      action: 'computed',
      entity: 'metric',
      entityId: 'arr-total',
      userId: metricUser,
      before: null,
      after: {
        value: input.arr.total,
        asOfDate: input.arr.asOfDate,
        totalCustomers: input.arr.totalCustomers,
      },
      metadata: {
        route: '/api/metrics/arr',
        metric: 'arr',
        sourceRecordCount: arrSources.length,
        sourceRecords: arrSources,
      },
    },
    {
      id: 'audit-nrr-quarter',
      timestamp,
      action: 'computed',
      entity: 'metric',
      entityId: 'nrr-quarter',
      userId: metricUser,
      before: null,
      after: {
        percentage: input.nrr.percentage,
        expansion: input.nrr.expansion,
        contraction: input.nrr.contraction,
        churn: input.nrr.churn,
      },
      metadata: {
        route: '/api/metrics/nrr',
        metric: 'nrr',
        periodStart: input.nrr.periodStart,
        periodEnd: input.nrr.periodEnd,
        breakdown: input.nrr.breakdown.slice(0, 25),
      },
    },
    {
      id: 'audit-churn-quarter',
      timestamp,
      action: 'computed',
      entity: 'metric',
      entityId: 'churn-quarter',
      userId: metricUser,
      before: null,
      after: {
        grossChurn: input.churn.grossChurn,
        netChurn: input.churn.netChurn,
        logoChurnRate: input.churn.logoChurnRate,
        revenueChurned: input.churn.revenueChurned,
      },
      metadata: {
        route: '/api/metrics/churn',
        metric: 'churn',
        periodStart: input.churn.periodStart,
        periodEnd: input.churn.periodEnd,
        byPlan: input.churn.byPlan,
        bySegment: input.churn.bySegment,
      },
    },
    {
      id: 'audit-unit-economics',
      timestamp,
      action: 'computed',
      entity: 'metric',
      entityId: 'unit-economics',
      userId: metricUser,
      before: null,
      after: {
        cac: input.unitEconomics.cac,
        ltv: input.unitEconomics.ltv,
        ltvCacRatio: input.unitEconomics.ltvCacRatio,
        paybackMonths: input.unitEconomics.paybackMonths,
      },
      metadata: {
        route: '/api/metrics/unit-economics',
        metric: 'unit_economics',
        period: input.unitEconomics.period,
        byChannel: input.unitEconomics.byChannel,
      },
    },
    {
      id: 'audit-cohort-summary',
      timestamp,
      action: 'computed',
      entity: 'metric',
      entityId: 'cohorts',
      userId: metricUser,
      before: null,
      after: {
        cohortCount: input.cohorts.length,
        latestCohort: input.cohorts[input.cohorts.length - 1]?.cohortMonth ?? null,
      },
      metadata: {
        route: '/api/metrics/cohorts',
        metric: 'cohorts',
        cohorts: input.cohorts.map((cohort) => ({
          cohortMonth: cohort.cohortMonth,
          customers: cohort.customers,
          revenue: cohort.revenue,
          retention: cohort.retention,
          customerRetention: cohort.customerRetention,
        })),
      },
    },
    {
      id: 'audit-reconciliation-run',
      timestamp,
      action: 'computed',
      entity: 'reconciliation_run',
      entityId: 'latest',
      userId: reconciliationUser,
      before: null,
      after: {
        totalDiscrepancies: input.reconciliation.summary.totalDiscrepancies,
        totalAmountImpact: input.reconciliation.summary.totalAmountImpact,
      },
      metadata: {
        route: '/api/reconciliation/run',
        options: input.reconciliation.metadata.options,
        recordsProcessed: input.reconciliation.summary.recordsProcessed,
        bySeverity: input.reconciliation.summary.bySeverity,
      },
    },
    ...input.reconciliation.discrepancies.map((item) => ({
      id: `audit-discrepancy-${item.id}`,
      timestamp: item.detectedAt,
      action: item.resolved ? 'resolved' : 'flagged',
      entity: 'discrepancy',
      entityId: item.id,
      userId: reconciliationUser,
      before: null,
      after: {
        severity: item.severity,
        type: item.type,
        amount: item.amount,
        direction: item.direction ?? null,
      },
      metadata: {
        customerName: item.customerName,
        description: item.description,
        sourceA: item.sourceA,
        sourceB: item.sourceB,
        scope: item.scope ?? null,
        percentDelta: item.percentDelta ?? null,
      },
    })),
  ];

  for (const cohort of input.cohorts) {
    const cohortMonthDate = new Date(`${cohort.cohortMonth}-01T00:00:00Z`);
    const cohortSnapshot = input.arrRecords.filter(
      (record) => record.startDate.slice(0, 7) === cohort.cohortMonth || new Date(record.startDate) <= cohortMonthDate,
    );
    entries.push({
      id: `audit-cohort-${cohort.cohortMonth}`,
      timestamp,
      action: 'computed',
      entity: 'cohort',
      entityId: cohort.cohortMonth,
      userId: metricUser,
      before: null,
      after: {
        customers: cohort.customers,
        revenue: cohort.revenue,
        latestRetention: cohort.retention[cohort.retention.length - 1] ?? 0,
      },
      metadata: {
        cohortMonth: cohort.cohortMonth,
        retention: cohort.retention,
        customerRetention: cohort.customerRetention,
        sourceRecords: cohortSnapshot.map((record) => ({
          system: record.source,
          recordId: record.sourceRecordId,
          customerKey: record.customerKey,
          companyName: record.companyName,
          arr: record.arr,
        })),
      },
    });
  }

  return entries;
}

function getPreviousQuarterWindow(asOfDate: Date) {
  const currentQuarterStartMonth = Math.floor(asOfDate.getUTCMonth() / 3) * 3;
  const currentQuarterStart = new Date(Date.UTC(asOfDate.getUTCFullYear(), currentQuarterStartMonth, 1));
  const previousQuarterStart = new Date(currentQuarterStart);
  previousQuarterStart.setUTCMonth(previousQuarterStart.getUTCMonth() - 3);
  const previousQuarterEnd = new Date(currentQuarterStart);
  const quarterNumber = Math.floor(previousQuarterStart.getUTCMonth() / 3) + 1;

  return {
    period: `${previousQuarterStart.getUTCFullYear()}-Q${quarterNumber}`,
    startDate: previousQuarterStart,
    endDate: previousQuarterEnd,
  };
}
