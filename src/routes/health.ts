import { Router } from 'express';
import { checkDatabase } from '../config/database';
import { checkRedis } from '../config/redis';
import { asyncHandler } from '../utils/helpers';

export const healthRouter = Router();

healthRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    res.json({
      status: 'ok',
      service: 'tech-king-backend',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  })
);

healthRouter.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    const [db, redis] = await Promise.all([checkDatabase(), checkRedis()]);
    const healthy = db.ok && redis.ok;
    const sessions = await import('../config/database').then((m) =>
      m.pool.query(`SELECT COUNT(*)::int AS n FROM sessions WHERE status = 'connected'`)
    );
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ready' : 'not_ready',
      database: db,
      redis,
      whatsappSessions: sessions.rows[0].n,
    });
  })
);
