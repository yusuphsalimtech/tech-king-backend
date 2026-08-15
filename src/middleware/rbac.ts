import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../utils/helpers';

const ROLE_LEVEL: Record<string, number> = { USER: 0, ADMIN: 1, SUPERADMIN: 2 };

/** Require at least the given role. */
export function requireRole(role: 'USER' | 'ADMIN' | 'SUPERADMIN') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) return next(new HttpError(401, 'Authentication required'));
    if ((ROLE_LEVEL[user.role] ?? 0) < ROLE_LEVEL[role]) {
      return next(new HttpError(403, 'Insufficient permissions'));
    }
    next();
  };
}
