import { Router } from 'express';
import { query } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { asyncHandler } from '../utils/helpers';
import { getLogs } from '../utils/logger';

export const logsRouter = Router();
logsRouter.use(requireAuth, requireRole('ADMIN'));

logsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(500, parseInt(String(req.query.limit ?? '100'), 10) || 100);
    const level = String(req.query.level ?? '').toLowerCase() || undefined;
    const logs = await getLogs(limit, level);
    res.json({ logs });
  })
);

logsRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const limit = Math.min(500, parseInt(String(req.query.limit ?? '100'), 10) || 100);
    const rows = await query(
      `SELECT a.*, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT $1`,
      [limit]
    );
    res.json({ audit: rows });
  })
);
