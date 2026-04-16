import { Router } from 'express';
import {
  calculateARR,
  calculateRevenueSummary,
  getDefaultARRAsOfDate,
} from '../metrics/arr.js';
import { calculateNRR } from '../metrics/nrr.js';
import { calculateChurn } from '../metrics/churn.js';
import { calculateUnitEconomics } from '../metrics/unit-economics.js';
import { buildCohortAnalysis } from '../metrics/cohorts.js';
import type { MetricOptions } from '../metrics/types.js';

export const metricsRouter = Router();

function parseBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value !== 'string') return defaultValue;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return defaultValue;
}

function parseDateParam(value: unknown, name: string): Date {
  if (typeof value !== 'string') {
    throw new Error(`Query parameter "${name}" is required.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Query parameter "${name}" must be a valid date string.`);
  }
  return date;
}

/**
 * Metrics API
 *
 * These endpoints serve computed SaaS metrics to the dashboard.
 * The candidate should implement the following routes:
 *
 * GET /api/metrics/arr
 *   - Calculate and return current ARR with breakdowns.
 *   - Supports query params: date, segmentBy, excludeTrials.
 *
 * GET /api/metrics/nrr
 *   - Calculate net revenue retention for a given period.
 *   - Requires query params: startDate, endDate.
 *   - Optional: segmentBy.
 *
 * GET /api/metrics/churn
 *   - Calculate churn metrics (gross, net, logo, revenue).
 *   - Requires query params: startDate, endDate.
 *
 * GET /api/metrics/unit-economics
 *   - Calculate CAC, LTV, LTV/CAC ratio, payback period.
 *   - Requires query params: period (e.g. "2024-Q1").
 *
 * GET /api/metrics/cohorts
 *   - Build cohort retention analysis.
 *   - Optional query params: startMonth, endMonth, granularity.
 *
 * GET /api/metrics/overview
 *   - Aggregate summary of all key metrics for the dashboard home page.
 */

metricsRouter.get('/arr', async (req, res, next) => {
  try {
    const dateParam = typeof req.query.date === 'string' ? req.query.date : undefined;
    const asOfDate = dateParam ? new Date(dateParam) : await getDefaultARRAsOfDate();

    if (Number.isNaN(asOfDate.getTime())) {
      return res.status(400).json({
        error: 'InvalidRequest',
        message: 'Query parameter "date" must be a valid date string.',
      });
    }

    const segmentBy =
      req.query.segmentBy === 'plan' ||
      req.query.segmentBy === 'segment' ||
      req.query.segmentBy === 'region' ||
      req.query.segmentBy === 'industry' ||
      req.query.segmentBy === 'cohort'
        ? req.query.segmentBy
        : undefined;

    const options: MetricOptions = {
      segmentBy,
      excludeTrials: parseBoolean(req.query.excludeTrials, true),
      excludeChurned: parseBoolean(req.query.excludeChurned, true),
    };

    const result = await calculateARR(asOfDate, options);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

metricsRouter.get('/revenue-summary', async (req, res, next) => {
  try {
    const startMonth =
      typeof req.query.startMonth === 'string' ? req.query.startMonth : undefined;
    const endMonth = typeof req.query.endMonth === 'string' ? req.query.endMonth : undefined;

    const monthPattern = /^\d{4}-\d{2}$/;
    if (startMonth && !monthPattern.test(startMonth)) {
      return res.status(400).json({
        error: 'InvalidRequest',
        message: 'Query parameter "startMonth" must use YYYY-MM format.',
      });
    }

    if (endMonth && !monthPattern.test(endMonth)) {
      return res.status(400).json({
        error: 'InvalidRequest',
        message: 'Query parameter "endMonth" must use YYYY-MM format.',
      });
    }

    const result = await calculateRevenueSummary({
      startMonth,
      endMonth,
      excludeTrials: parseBoolean(req.query.excludeTrials, true),
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

metricsRouter.get('/nrr', async (req, res, next) => {
  try {
    const startDate = parseDateParam(req.query.startDate, 'startDate');
    const endDate = parseDateParam(req.query.endDate, 'endDate');
    const result = await calculateNRR(startDate, endDate, {
      excludeTrials: parseBoolean(req.query.excludeTrials, true),
      excludeChurned: false,
    });
    return res.json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes('Query parameter')) {
      return res.status(400).json({ error: 'InvalidRequest', message: err.message });
    }
    return next(err);
  }
});

metricsRouter.get('/churn', async (req, res, next) => {
  try {
    const startDate = parseDateParam(req.query.startDate, 'startDate');
    const endDate = parseDateParam(req.query.endDate, 'endDate');
    const result = await calculateChurn(startDate, endDate, {
      excludeTrials: parseBoolean(req.query.excludeTrials, true),
      excludeChurned: false,
    });
    return res.json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes('Query parameter')) {
      return res.status(400).json({ error: 'InvalidRequest', message: err.message });
    }
    return next(err);
  }
});

metricsRouter.get('/unit-economics', async (req, res, next) => {
  try {
    const period = typeof req.query.period === 'string' ? req.query.period : '2024-Q4';
    const result = await calculateUnitEconomics(period);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

metricsRouter.get('/cohorts', async (req, res, next) => {
  try {
    const startMonth = typeof req.query.startMonth === 'string' ? req.query.startMonth : '2024-01';
    const endMonth = typeof req.query.endMonth === 'string' ? req.query.endMonth : undefined;
    const result = await buildCohortAnalysis({
      startDate: new Date(`${startMonth}-01T00:00:00Z`),
      endDate: endMonth ? new Date(`${endMonth}-01T00:00:00Z`) : undefined,
      excludeTrials: parseBoolean(req.query.excludeTrials, true),
      excludeChurned: false,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

metricsRouter.get('/overview', async (_req, res, next) => {
  try {
    const asOf = await getDefaultARRAsOfDate();
    const prior = new Date(asOf);
    prior.setUTCMonth(prior.getUTCMonth() - 3);
    const [arr, nrr, churn, unitEconomics] = await Promise.all([
      calculateARR(asOf),
      calculateNRR(prior, asOf, { excludeChurned: false }),
      calculateChurn(prior, asOf, { excludeChurned: false }),
      calculateUnitEconomics(`${asOf.getUTCFullYear()}-Q${Math.floor(asOf.getUTCMonth() / 3) + 1}`),
    ]);
    return res.json({ arr, nrr, churn, unitEconomics });
  } catch (err) {
    return next(err);
  }
});
