import "server-only";
import { db } from "./db.ts";

export async function audit(entry: {
  userId?: string | null;
  workerId?: string | null;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}) {
  await db()`
    INSERT INTO audit_log (user_id, worker_id, action, target, detail, ip)
    VALUES (${entry.userId ?? null}, ${entry.workerId ?? null}, ${entry.action}, ${entry.target ?? null},
            ${JSON.stringify(entry.detail ?? {})}::text::jsonb, ${entry.ip ?? null})
  `;
}
