import { Router } from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStripePayments } from '../ingestion/stripe.js';
import { loadChargebeeSubscriptions } from '../ingestion/chargebee.js';
import { loadSalesforceData } from '../ingestion/salesforce.js';
import { loadFXRates } from '../utils/fx.js';
import { detectDuplicates } from '../reconciliation/deduplication.js';
import { reconcileRevenue } from '../reconciliation/revenue.js';
import { analyzePipelineQuality } from '../reconciliation/pipeline.js';
import { getDefaultARRAsOfDate } from '../metrics/arr.js';
import {
  DiscrepancyType,
  Severity,
  type Discrepancy,
  type ReconciliationResult,
} from '../reconciliation/types.js';

export const reconciliationRouter = Router();
let latestRun: ReconciliationResult | null = null;

/**
 * Reconciliation API
 *
 * These endpoints expose the reconciliation engine to the dashboard.
 * The candidate should implement the following routes:
 *
 * POST /api/reconciliation/run
 *   - Trigger a full reconciliation pass across all data sources.
 *   - Body may include options such as date range, tolerance thresholds, etc.
 *   - Returns a ReconciliationResult with discrepancies and summary stats.
 *
 * GET /api/reconciliation/discrepancies
 *   - List all detected discrepancies.
 *   - Supports query params: severity, type, page, limit, sort.
 *
 * GET /api/reconciliation/discrepancies/:id
 *   - Get a single discrepancy by ID with full detail (source records, etc.).
 *
 * POST /api/reconciliation/discrepancies/:id/resolve
 *   - Mark a discrepancy as resolved with a resolution note.
 *
 * GET /api/reconciliation/duplicates
 *   - List detected cross-system duplicates.
 *   - Supports filtering by classification (true_duplicate, migration, uncertain).
 *
 * GET /api/reconciliation/pipeline
 *   - Return pipeline quality analysis results.
 */

reconciliationRouter.post('/run', async (req, res, next) => {
  try {
    latestRun = await runFullReconciliation(req.body as Record<string, unknown>);
    return res.json(latestRun);
  } catch (err) {
    return next(err);
  }
});

reconciliationRouter.get('/discrepancies', async (req, res, next) => {
  try {
    const run = latestRun ?? (await runFullReconciliation({}));
    latestRun = run;
    const severity = typeof req.query.severity === 'string' ? req.query.severity : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const page = parsePositiveInt(req.query.page, 1);
    const limit = parsePositiveInt(req.query.limit, 50);
    const filtered = run.discrepancies
      .filter((item) => (severity ? item.severity === severity : true))
      .filter((item) => (type ? item.type === type : true));
    const start = (page - 1) * limit;

    return res.json({
      data: filtered.slice(start, start + limit),
      meta: { page, limit, total: filtered.length },
    });
  } catch (err) {
    return next(err);
  }
});

reconciliationRouter.get('/discrepancies/:id', async (req, res, next) => {
  try {
    const run = latestRun ?? (await runFullReconciliation({}));
    latestRun = run;
    const item = run.discrepancies.find((discrepancy) => discrepancy.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'NotFound', message: 'Discrepancy not found.' });
    return res.json(item);
  } catch (err) {
    return next(err);
  }
});

reconciliationRouter.post('/discrepancies/:id/resolve', async (req, res, next) => {
  try {
    const run = latestRun ?? (await runFullReconciliation({}));
    const item = run.discrepancies.find((discrepancy) => discrepancy.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'NotFound', message: 'Discrepancy not found.' });
    item.resolved = true;
    item.resolutionNote =
      typeof req.body?.resolutionNote === 'string' ? req.body.resolutionNote : 'Resolved in dashboard';
    latestRun = run;
    return res.json(item);
  } catch (err) {
    return next(err);
  }
});

reconciliationRouter.get('/duplicates', async (req, res, next) => {
  try {
    const dataDir = getDefaultDataDir();
    const [stripePayments, chargebeeSubscriptions] = await Promise.all([
      loadStripePayments(dataDir),
      loadChargebeeSubscriptions(dataDir),
    ]);
    const classification =
      typeof req.query.classification === 'string' ? req.query.classification : undefined;
    const duplicates = (await detectDuplicates(stripePayments, chargebeeSubscriptions)).filter((item) =>
      classification ? item.classification === classification : true,
    );
    return res.json({ data: duplicates, meta: { total: duplicates.length } });
  } catch (err) {
    return next(err);
  }
});

reconciliationRouter.get('/pipeline', async (_req, res, next) => {
  try {
    const dataDir = getDefaultDataDir();
    const asOfDate = await getDefaultARRAsOfDate();
    const [[opportunities], chargebeeSubscriptions, stripePayments] = await Promise.all([
      loadSalesforceData(dataDir),
      loadChargebeeSubscriptions(dataDir),
      loadStripePayments(dataDir),
    ]);
    const result = await analyzePipelineQuality(opportunities, [
      ...chargebeeSubscriptions,
      ...stripePayments,
    ], { asOfDate });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

async function runFullReconciliation(options: Record<string, unknown>): Promise<ReconciliationResult> {
  const startedAt = new Date();
  const dataDir = getDefaultDataDir();
  const defaultPeriod = await getDefaultReconciliationPeriod();
  const startDate = parseDateOption(options.dateStart, defaultPeriod.startDate);
  const endDate = parseDateOption(options.dateEnd, defaultPeriod.endDate);
  const tolerance = typeof options.tolerance === 'number' ? options.tolerance : 0.5;
  const [stripePayments, chargebeeSubscriptions, [opportunities], fxRates] = await Promise.all([
    loadStripePayments(dataDir),
    loadChargebeeSubscriptions(dataDir),
    loadSalesforceData(dataDir),
    loadFXRates(join(dataDir, 'fx_rates.csv')),
  ]);
  const [duplicates, revenue, pipeline] = await Promise.all([
    detectDuplicates(stripePayments, chargebeeSubscriptions),
    reconcileRevenue(chargebeeSubscriptions, stripePayments, fxRates, {
      startDate,
      endDate,
      toleranceUSD: tolerance,
    }),
    analyzePipelineQuality(opportunities, [...chargebeeSubscriptions, ...stripePayments], {
      asOfDate: endDate,
    }),
  ]);

  const detectedAt = new Date().toISOString();
  const discrepancies: Discrepancy[] = [
    ...duplicates
      .filter((duplicate) => duplicate.classification === 'true_duplicate')
      .map((duplicate, index) =>
        createDiscrepancy({
          id: `dup-${index + 1}`,
          type: DiscrepancyType.DUPLICATE_ACCOUNT,
          severity: Severity.HIGH,
          sourceA: {
            system: 'stripe',
            recordId: duplicate.stripeRecord.subscriptionId,
            value: duplicate.stripeRecord.mrr,
          },
          sourceB: {
            system: 'chargebee',
            recordId: duplicate.chargebeeRecord.subscriptionId,
            value: duplicate.chargebeeRecord.mrr,
          },
          customerName: duplicate.chargebeeRecord.customerName,
          amount: Math.min(duplicate.stripeRecord.mrr, duplicate.chargebeeRecord.mrr) * 12,
          description: `Potential duplicate active subscription with ${duplicate.overlapDays} overlapping days.`,
          detectedAt,
        }),
      ),
    ...revenue.lineItems
      .filter((item) => {
        const base = Math.max(Math.abs(item.expected), Math.abs(item.actual), 1);
        return Math.abs(item.difference) / base > 0.02;
      })
      .map((item, index) =>
        createDiscrepancy({
          id: `rev-${index + 1}`,
          type: DiscrepancyType.AMOUNT_MISMATCH,
          severity: getAmountSeverity(Math.abs(item.difference)),
          sourceA: { system: 'chargebee', recordId: item.customerId, value: item.expected },
          sourceB: { system: 'stripe', recordId: item.customerId, value: item.actual },
          customerName: item.customerName,
          amount: Math.abs(item.difference),
          description: item.reason,
          detectedAt,
        }),
      ),
    ...pipeline.mismatches.map((item, index) =>
      createDiscrepancy({
        id: `pipe-${index + 1}`,
        type: DiscrepancyType.AMOUNT_MISMATCH,
        severity: Severity.MEDIUM,
        sourceA: { system: 'salesforce', recordId: item.opportunityId, value: item.crmValue },
        sourceB: { system: 'billing', recordId: item.opportunityId, value: item.billingValue },
        customerName: item.accountName,
        amount:
          typeof item.crmValue === 'number' && typeof item.billingValue === 'number'
            ? Math.abs(item.crmValue - item.billingValue)
            : null,
        description: item.issue,
        detectedAt,
      }),
    ),
  ].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));

  const completedAt = new Date();
  return {
    discrepancies,
    summary: {
      totalDiscrepancies: discrepancies.length,
      bySeverity: countBy(Object.values(Severity), discrepancies, (item) => item.severity),
      byType: countBy(Object.values(DiscrepancyType), discrepancies, (item) => item.type),
      totalAmountImpact: Math.round(calculateBillingExposure(discrepancies)),
      recordsProcessed: {
        stripe: stripePayments.length,
        chargebee: chargebeeSubscriptions.length,
        salesforce_opportunities: opportunities.length,
      },
    },
    metadata: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      options: { ...options, dateStart: startDate.toISOString(), dateEnd: endDate.toISOString() },
    },
  };
}

function getDefaultDataDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../data');
}

async function getDefaultReconciliationPeriod(): Promise<{ startDate: Date; endDate: Date }> {
  const asOfDate = await getDefaultARRAsOfDate();
  const startDate = new Date(Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth(), 1));
  const endDate = new Date(Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth() + 1, 1));
  return { startDate, endDate };
}

function parseDateOption(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string') return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getAmountSeverity(amount: number): Severity {
  if (amount >= 100_000) return Severity.CRITICAL;
  if (amount >= 25_000) return Severity.HIGH;
  if (amount >= 5_000) return Severity.MEDIUM;
  return Severity.LOW;
}

function createDiscrepancy(input: Omit<Discrepancy, 'resolved' | 'resolutionNote'>): Discrepancy {
  return { ...input, resolved: false, resolutionNote: null };
}

function calculateBillingExposure(discrepancies: Discrepancy[]): number {
  return discrepancies
    .filter(
      (item) =>
        item.sourceA.system === 'chargebee' ||
        item.sourceA.system === 'stripe' ||
        item.sourceB.system === 'chargebee' ||
        item.sourceB.system === 'stripe',
    )
    .reduce((sum, item) => sum + Math.abs(item.amount ?? 0), 0);
}

function countBy<T extends string>(
  keys: T[],
  discrepancies: Discrepancy[],
  getKey: (item: Discrepancy) => T,
): Record<T, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const item of discrepancies) {
    counts[getKey(item)] += 1;
  }
  return counts;
}
