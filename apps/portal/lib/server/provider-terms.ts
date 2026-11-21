import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import { db } from "./db.ts";
import { audit } from "./audit.ts";
import { hasRole, type SessionUser } from "./auth.ts";
import { requestMeta } from "./request.ts";
import { PROVIDER_NAME_MAX, type CommercialOk, type ProviderKind, type ProviderTerms } from "../studio/asset-plan.ts";

/**
 * The only writer of asset_providers.commercial_ok, shared by Settings and the Review card. Owner only: the callers
 * run requireUser("owner") and this checks the role again. Whether a provider's terms allow commercial use is the
 * owner's call; the studio never decides it from anything a model said, and never writes it on its own.
 */

type Q = Sql | TransactionSql;

const termsSchema = z.object({
  name: z.string().min(1).max(PROVIDER_NAME_MAX),
  kind: z.enum(["image", "tts", "library", "video"]),
  status: z.enum(["unknown", "yes", "no"]),
  note: z.string().max(300),
});

export type SaveTermsResult = { ok: true; name: string; kind: ProviderKind; status: CommercialOk } | { ok: false; error: string };

export async function saveProviderTerms(owner: SessionUser, input: { name: string; kind: string; status: string; note: string }): Promise<SaveTermsResult> {
  if (!hasRole(owner.role, "owner")) return { ok: false, error: "Only the owner can confirm provider terms." };
  const p = termsSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Check the provider and the choice, then try again." };
  const rows = await db()`
    UPDATE asset_providers
    SET commercial_ok = ${p.data.status}, note = ${p.data.note}, confirmed_by = ${owner.id}, confirmed_at = now()
    WHERE name = ${p.data.name} AND kind = ${p.data.kind}
    RETURNING name
  `;
  if (rows.length === 0) return { ok: false, error: `There is no ${p.data.kind} provider called ${p.data.name}.` };
  await audit({
    userId: owner.id,
    action: "asset_provider.terms",
    target: `${p.data.kind}:${p.data.name}`,
    detail: { commercialOk: p.data.status },
    ip: (await requestMeta()).ip,
  });
  return { ok: true, name: p.data.name, kind: p.data.kind, status: p.data.status };
}

/** The terms as one connection or transaction sees them, so a re-check reads them under its own locks. */
export async function listProviderTermsIn(q: Q): Promise<ProviderTerms[]> {
  const rows = await q`SELECT name, kind, commercial_ok, note FROM asset_providers ORDER BY kind, name`;
  return rows.map((r): ProviderTerms => ({
    name: String(r.name),
    kind: r.kind as ProviderKind,
    commercialOk: r.commercial_ok as CommercialOk,
    note: String(r.note ?? ""),
  }));
}
