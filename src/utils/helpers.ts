import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Wrap async route handlers so rejections reach the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Generate a 64-character session credential (32 random bytes hex). */
export function generateCredential(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Generate an API key: tk_<16 random bytes base64url> */
export function generateApiKey(): string {
  return `tk_${crypto.randomBytes(16).toString('base64url')}`;
}

export function sanitizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, '').replace(/^0+/, '');
}

export function jidToPhone(jid: string): string {
  return jid.split(':')[0].replace(/[^\d]/g, '');
}

export function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
