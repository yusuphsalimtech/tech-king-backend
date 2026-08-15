import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/helpers';
import { getDashboardStats, getSystemHealth } from '../services/metricsService';

export const metricsRouter = Router();
metricsRouter.use(requireAuth);

metricsRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const stats = await getDashboardStats(req.user!.id);
    res.json(stats);
  })
);

metricsRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const health = await getSystemHealth();
    res.json(health);
  })
);
