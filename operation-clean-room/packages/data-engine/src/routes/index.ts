import type { Express } from 'express';
import { healthRouter } from './health.js';
import { reconciliationRouter } from './reconciliation.js';
import { metricsRouter } from './metrics.js';
import { scenariosRouter } from './scenarios.js';
import { auditRouter } from './audit.js';

/**
 * Register all route modules on the Express application.
 *
 * Each router is mounted under `/api` so that the frontend proxy and any
 * future API gateway can route cleanly.
 */
export function registerRoutes(app: Express): void {
  app.use('/api/health', healthRouter);
  app.use('/api/reconciliation', reconciliationRouter);
  app.use('/api/metrics', metricsRouter);
  app.use('/api/scenarios', scenariosRouter);
  app.use('/api/audit', auditRouter);
}
