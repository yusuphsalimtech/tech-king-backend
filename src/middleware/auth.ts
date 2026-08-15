import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { queryOne } from '../config/database';
import { HttpError, sha256 } from '../utils/helpers';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: 'SUPERADMIN' | 'ADMIN' | 'USER';
  language: string;
  phone: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign(
    { sub: String(user.id), role: user.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as never }
  );
}

async function verifyApiKey(req: Request): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token.startsWith('tk_')) return null;

  const row = await queryOne<any>(
    `SELECT k.*, u.id AS user_id, u.name, u.email, u.role, u.language, u.phone
     FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1`,
    [sha256(token)]
  );
  if (!row) return null;
  await queryOne(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]);
  return {
    id: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    language: row.language,
    phone: row.phone,
  };
}

/** Requires a valid JWT (or API key). Populates req.user. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const apiUser = await verifyApiKey(req);
    if (apiUser) {
      req.user = apiUser;
      return next();
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new HttpError(401, 'Authentication required');
    }
    const token = header.slice(7).trim();
    const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string; role: string };
    const user = await queryOne<AuthUser>(
      `SELECT id, name, email, role, language, phone FROM users WHERE id = $1`,
      [parseInt(payload.sub, 10)]
    );
    if (!user) throw new HttpError(401, 'User no longer exists');
    req.user = user;
    next();
  } catch (err) {
    if (err instanceof HttpError) return next(err);
    next(new HttpError(401, 'Invalid or expired token'));
  }
}
