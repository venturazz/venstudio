import type { AssetKind, AssetSource } from "./catalog.ts";

export interface ProvenanceRecord {
  title: string;
  kind: AssetKind;
  source: AssetSource;
  license: string;
  originUrl: string;
  /** Optional tags from asset metadata, e.g. "person-likeness" or "brand-logo". */
  tags?: string[];
  /** Written permission for a likeness or logo, e.g. "release signed 2025-01-02, file in Assets". */
  permissionNote?: string;
}

/**
 * Problems that block an asset from appearing in a published video. "analyze" never blocks: studying a
 * reference is allowed without a licence.
 */
export function provenanceIssues(records: ProvenanceRecord[], use: "publish" | "analyze"): string[] {
  if (use === "analyze") return [];
  const issues: string[] = [];
  for (const r of records) {
    if (!r.license.trim()) issues.push(`${r.title}: no licence or permission note`);
    if (r.kind === "reference-video") issues.push(`${r.title}: a reference video can be studied, but never appear in a published video`);
    if ((r.source === "upload" || r.source === "licensed") && !r.originUrl.trim()) {
      issues.push(`${r.title}: say where it came from (add an origin link)`);
    }
  }
  return issues;
}

const AI_SOURCES: AssetSource[] = ["hermes", "muse", "generated"];

/**
 * Provenance v2: YouTube asks for an altered or synthetic content disclosure when realistic content was made with AI.
 * True when anything realistic was synthetic and at least one asset came from an AI source.
 */
export function aiDisclosureRequired(args: { sources: AssetSource[]; realisticSynthetic: boolean }): boolean {
  return args.realisticSynthetic && args.sources.some((s) => AI_SOURCES.includes(s));
}

/** Assets tagged as a real person's likeness or a brand logo need a written permission note before publishing. */
export function likenessIssues(records: ProvenanceRecord[]): string[] {
  const issues: string[] = [];
  for (const r of records) {
    const tags = r.tags ?? [];
    const hasNote = (r.permissionNote ?? "").trim().length > 0;
    if (tags.includes("person-likeness") && !hasNote) issues.push(`${r.title}: shows a real person; add their written permission`);
    if (tags.includes("brand-logo") && !hasNote) issues.push(`${r.title}: shows a brand logo; add written permission or remove it`);
  }
  return issues;
}
