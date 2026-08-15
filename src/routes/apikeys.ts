import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, HttpError, generateApiKey, sha256 } from '../utils/helpers';
import { audit } from '../utils/audit';

export const apikeysRouter = Router();
apikeysRouter.use(requireAuth);

apikeysRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query<any>(
      `SELECT id, name, prefix, last_used_at, created_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.id]
    );
    res.json({ keys: rows });
  })
);

const createSchema = z.object({ name: z.string().min(1).max(60) });

apikeysRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const key = generateApiKey();
    await query(
      `INSERT INTO api_keys (user_id, name, key_hash, prefix) VALUES ($1, $2, $3, $4)`,
      [req.user!.id, body.name, sha256(key), key.slice(0, 8)]
    );
    await audit('apikey.create', { userId: req.user!.id }, { name: body.name });
    // Shown exactly once — never returned again.
    res.status(201).json({ key, message: 'Save this key now — it will not be shown again' });
  })
);

apikeysRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await queryOne<any>(
      `DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user!.id]
    );
    if (!row) throw new HttpError(404, 'API key not found');
    res.json({ ok: true });
  })
);
