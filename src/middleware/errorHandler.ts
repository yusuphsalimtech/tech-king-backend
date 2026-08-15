import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../utils/helpers';
import { logger } from '../utils/logger';

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    return void res.status(err.status).json({ error: err.message });
  }
  if (err instanceof ZodError) {
    return void res.status(400).json({ error: 'Validation failed', details: err.flatten().fieldErrors });
  }
  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}
