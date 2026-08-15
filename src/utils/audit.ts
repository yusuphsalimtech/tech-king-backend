import { query } from '../config/database';

export interface AuditContext {
  userId?: number | null;
  ip?: string;
}

export async function audit(action: string, ctx: AuditContext, detail?: Record<string, unknown>): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, detail, ip) VALUES ($1, $2, $3, $4)`,
      [ctx.userId ?? null, action, JSON.stringify(detail ?? {}), ctx.ip ?? null]
    );
  } catch {
    // never crash on audit failure
  }
}
