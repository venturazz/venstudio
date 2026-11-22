import "server-only";
import { db } from "./db.ts";
import { seedTemplates, type Template } from "../studio/templates.ts";
import { refreshedPackTemplate } from "../studio/style-registry.ts";
import { packSeedTemplates } from "./style-packs.ts";
import type { TrialScore } from "../studio/template-lab.ts";

/**
 * Inserts the seed styles as candidate templates. Existing rows are never touched, so a template the owner
 * has signed or promoted keeps its state. A template seeded from a style pack the catalogue does not know gets a new
 * version when the vendored pack version changes (its contract, with the same status and the owner's sign-offs).
 */
export async function ensureSeedTemplates(): Promise<void> {
  const sql = db();
  // The catalogue's styles, then every vendored pack the catalogue does not know (from its own contract).
  const packSeeds = await packSeedTemplates().catch(() => [] as Template[]);
  const seeds = [...seedTemplates(), ...packSeeds];
  // One cheap read decides whether any seed is missing; the inserts only run on first use or after a new seed ships.
  const [have] = await sql`SELECT count(*)::int AS n FROM templates WHERE id = ANY(${seeds.map((t) => t.id)}::text[])`;
  if (Number(have?.n ?? 0) < seeds.length) await insertSeeds(seeds);
  await refreshPackTemplates(packSeeds);
}

async function refreshPackTemplates(packSeeds: readonly Template[]): Promise<void> {
  if (packSeeds.length === 0) return;
  const sql = db();
  const rows = await sql`
    SELECT t.id, t.current_version, v.spec FROM templates t
    JOIN template_versions v ON v.template_id = t.id AND v.version = t.current_version
    WHERE t.id = ANY(${packSeeds.map((t) => t.id)}::text[])
  `;
  for (const r of rows) {
    const seed = packSeeds.find((t) => t.id === String(r.id));
    const current = r.spec as Template | null;
    if (!seed || !current || typeof current !== "object") continue;
    const next = refreshedPackTemplate({ ...current, version: Number(r.current_version) }, seed);
    if (!next) continue;
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO template_versions (template_id, version, spec, checklist)
        VALUES (${next.id}, ${next.version}, ${JSON.stringify(next)}::text::jsonb, ${JSON.stringify(next.copyrightChecklist)}::text::jsonb)
        ON CONFLICT (template_id, version) DO NOTHING
      `;
      await tx`
        UPDATE templates SET current_version = ${next.version}, name = ${next.label}, updated_at = now()
        WHERE id = ${next.id} AND current_version = ${next.version - 1}
      `;
    });
  }
}

async function insertSeeds(seeds: readonly Template[]): Promise<void> {
  const sql = db();
  for (const t of seeds) {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO templates (id, name, status, style_id, current_version)
        VALUES (${t.id}, ${t.label}, ${t.status}, ${t.styleId}, ${t.version})
        ON CONFLICT (id) DO NOTHING
      `;
      await tx`
        INSERT INTO template_versions (template_id, version, spec, checklist)
        VALUES (${t.id}, ${t.version}, ${JSON.stringify(t)}::text::jsonb, ${JSON.stringify(t.copyrightChecklist)}::text::jsonb)
        ON CONFLICT (template_id, version) DO NOTHING
      `;
    });
  }
}

/**
 * Note: templates.status mirrors spec.status for filtering. Reads use the spec. Any code that changes a
 * template's status (promotion, demotion, retirement) must write the new version spec and this column in one
 * transaction, as saveDraftTemplate does.
 */

/** Current version of every template, newest change first. */
export async function listTemplates(): Promise<Template[]> {
  const rows = await db()`
    SELECT v.spec FROM templates t
    JOIN template_versions v ON v.template_id = t.id AND v.version = t.current_version
    ORDER BY t.updated_at DESC, t.id
  `;
  return rows.map((r) => r.spec as Template);
}

export async function getTemplate(id: string): Promise<Template | null> {
  const [row] = await db()`
    SELECT v.spec FROM templates t
    JOIN template_versions v ON v.template_id = t.id AND v.version = t.current_version
    WHERE t.id = ${id}
  `;
  return row ? (row.spec as Template) : null;
}

/** Saves a draft learned by the Template Lab. A template that is no longer a draft is never overwritten here. */
export async function saveDraftTemplate(t: Template): Promise<boolean> {
  const sql = db();
  return sql.begin(async (tx) => {
    const rows = await tx`
      INSERT INTO templates (id, name, status, style_id, current_version)
      VALUES (${t.id}, ${t.label}, ${t.status}, ${t.styleId}, ${t.version})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now()
      WHERE templates.status = 'draft' AND templates.current_version = EXCLUDED.current_version
      RETURNING id
    `;
    if (rows.length === 0) return false;
    await tx`
      INSERT INTO template_versions (template_id, version, spec, checklist)
      VALUES (${t.id}, ${t.version}, ${JSON.stringify(t)}::text::jsonb, ${JSON.stringify(t.copyrightChecklist)}::text::jsonb)
      ON CONFLICT (template_id, version) DO UPDATE SET spec = EXCLUDED.spec, checklist = EXCLUDED.checklist
    `;
    return true;
  });
}

export async function recordTrial(input: {
  templateId: string;
  version: number;
  kind: "lab" | "production";
  score: TrialScore;
  claim: boolean;
  qcReportId?: string | null;
}): Promise<void> {
  await db()`
    INSERT INTO template_trials (template_id, version, kind, passed_technical, presentation_score, asset_failures,
                                 compliance_failures, claim, qc_report_id)
    VALUES (${input.templateId}, ${input.version}, ${input.kind}, ${input.score.passedTechnical},
            ${input.score.presentationScore === null ? null : Math.round(input.score.presentationScore)},
            ${input.score.assetFailed ? 1 : 0}, ${input.score.complianceFailed ? 1 : 0}, ${input.claim},
            ${input.qcReportId ?? null})
  `;
}
