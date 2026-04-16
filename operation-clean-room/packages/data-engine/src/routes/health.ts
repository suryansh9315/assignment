import { Router } from 'express';
import { calculateHealthScores } from '../health/scorer.js';

export const healthRouter = Router();

const startedAt = Date.now();

/**
 * GET /api/health
 *
 * Simple liveness / readiness probe.  Returns the current server status,
 * an ISO-8601 timestamp, and uptime in seconds.
 */
healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startedAt) / 1000),
  });
});

healthRouter.get('/customers', async (_req, res, next) => {
  try {
    const scores = await calculateHealthScores();
    return res.json({
      data: scores,
      meta: {
        total: scores.length,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

healthRouter.get('/summary', async (_req, res, next) => {
  try {
    const scores = await calculateHealthScores();
    const summary = scores.reduce(
      (acc, score) => {
        acc.count += 1;
        acc.averageScore += score.score;
        acc.atRisk += score.score < 55 ? 1 : 0;
        acc.arr += score.mrr * 12;
        acc.byRiskLevel[score.riskLevel] += 1;
        return acc;
      },
      {
        count: 0,
        averageScore: 0,
        atRisk: 0,
        arr: 0,
        byRiskLevel: {
          low: 0,
          medium: 0,
          high: 0,
          critical: 0,
        },
      },
    );

    return res.json({
      ...summary,
      averageScore: summary.count > 0 ? Math.round(summary.averageScore / summary.count) : 0,
      arr: Math.round(summary.arr),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return next(err);
  }
});
