import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, queryOne } from '../config/database';
import { requireAuth, signToken } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimit';
import { asyncHandler, clientIp, HttpError } from '../utils/helpers';
import { audit } from '../utils/audit';

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email().max(160),
  password: z.string().min(8).max(128),
  language: z.enum(['en', 'sw']).default('en'),
});

authRouter.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const existing = await queryOne(`SELECT id FROM users WHERE email = LOWER($1)`, [body.email.toLowerCase()]);
    if (existing) throw new HttpError(409, 'Email is already registered');

    const first = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users`);
    const role = first?.n === 0 ? 'SUPERADMIN' : 'USER';

    const hash = await bcrypt.hash(body.password, 10);
    const user = await queryOne<any>(
      `INSERT INTO users (name, email, password_hash, role, language) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role, language, phone, created_at`,
      [body.name, body.email.toLowerCase(), hash, role, body.language]
    );
    await audit('auth.register', { userId: user.id, ip: clientIp(req) }, { email: user.email, role });

    const token = signToken(user);
    res.status(201).json({ token, user });
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await queryOne<any>(
      `SELECT * FROM users WHERE email = LOWER($1)`,
      [body.email.toLowerCase()]
    );
    if (!user) throw new HttpError(401, 'Invalid email or password');

    const ok = await bcrypt.compare(body.password, user.password_hash);
    if (!ok) throw new HttpError(401, 'Invalid email or password');

    await audit('auth.login', { userId: user.id, ip: clientIp(req) }, { email: user.email });
    const safe = { id: user.id, name: user.name, email: user.email, role: user.role, language: user.language, phone: user.phone, created_at: user.created_at };
    res.json({ token: signToken(safe), user: safe });
  })
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  })
);

const updateSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  language: z.enum(['en', 'sw']).optional(),
  phone: z.string().max(20).nullable().optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8).max(128).optional(),
});

authRouter.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.name !== undefined) { sets.push(`name = $${idx++}`); values.push(body.name); }
    if (body.language !== undefined) { sets.push(`language = $${idx++}`); values.push(body.language); }
    if (body.phone !== undefined) { sets.push(`phone = $${idx++}`); values.push(body.phone); }

    if (body.newPassword) {
      const row = await queryOne<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [req.user!.id]);
      if (!row) throw new HttpError(404, 'User not found');
      const ok = await bcrypt.compare(body.currentPassword ?? '', row.password_hash);
      if (!ok) throw new HttpError(400, 'Current password is incorrect');
      const hash = await bcrypt.hash(body.newPassword, 10);
      sets.push(`password_hash = $${idx++}`);
      values.push(hash);
      await audit('auth.password_change', { userId: req.user!.id, ip: clientIp(req) });
    }

    if (sets.length === 0) return res.json({ user: req.user });
    values.push(req.user!.id);
    const user = await queryOne<any>(
      `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${idx} RETURNING id, name, email, role, language, phone, created_at`,
      values
    );
    res.json({ user });
  })
);

authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await audit('auth.logout', { userId: req.user!.id, ip: clientIp(req) });
    res.json({ ok: true });
  })
);

// ── users (ADMIN+) ─────────────────────────────────────────────────────────
authRouter.get(
  '/users',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user!.role === 'USER') throw new HttpError(403, 'Insufficient permissions');
    const rows = await pool.query(
      `SELECT id, name, email, role, language, phone, created_at FROM users ORDER BY id`
    );
    res.json({ users: rows.rows });
  })
);
