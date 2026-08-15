import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, HttpError } from '../utils/helpers';

export const customersRouter = Router();
customersRouter.use(requireAuth);

customersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const search = String(req.query.search ?? '').trim();
    const limit = Math.min(100, parseInt(String(req.query.limit ?? '50'), 10) || 50);
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const params: unknown[] = [req.user!.id];
    let where = `c.user_id = $1`;
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length} OR c.jid ILIKE $${params.length} OR c.tags::text ILIKE $${params.length})`;
    }
    params.push(limit, offset);

    const rows = await query<any>(
      `SELECT c.*, s.name AS session_name FROM customers c
       LEFT JOIN sessions s ON s.id = c.session_id
       WHERE ${where} ORDER BY COALESCE(c.last_interaction_at, c.created_at) DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const count = await queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM customers c WHERE ${where.replace(/ORDER BY.*/, '')}`,
      params.slice(0, params.length - 2)
    );
    res.json({ customers: rows, total: count?.n ?? 0 });
  })
);

customersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await queryOne<any>(
      `SELECT c.*, s.name AS session_name FROM customers c LEFT JOIN sessions s ON s.id = c.session_id WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!row) throw new HttpError(404, 'Customer not found');
    res.json({ customer: row });
  })
);

const updateSchema = z.object({
  name: z.string().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  language: z.enum(['en', 'sw']).optional(),
  tags: z.array(z.string().max(40)).optional(),
});

customersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (body.name !== undefined) { sets.push(`name = $${idx++}`); values.push(body.name); }
    if (body.notes !== undefined) { sets.push(`notes = $${idx++}`); values.push(body.notes); }
    if (body.language !== undefined) { sets.push(`language = $${idx++}`); values.push(body.language); }
    if (body.tags !== undefined) { sets.push(`tags = $${idx++}`); values.push(body.tags); }
    if (sets.length === 0) throw new HttpError(400, 'Nothing to update');
    values.push(req.params.id, req.user!.id);
    const row = await queryOne<any>(
      `UPDATE customers SET ${sets.join(', ')} WHERE id = $${idx} AND user_id = $${idx + 1} RETURNING *`,
      values
    );
    if (!row) throw new HttpError(404, 'Customer not found');
    res.json({ customer: row });
  })
);

customersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await queryOne<any>(
      `DELETE FROM customers WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user!.id]
    );
    if (!row) throw new HttpError(404, 'Customer not found');
    res.json({ ok: true });
  })
);
