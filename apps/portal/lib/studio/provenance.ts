import type { AssetKind, AssetSource } from "./catalog.ts";

export interface ProvenanceRecord {
  title: string;
  kind: AssetKind;
  source: AssetSource;
  license: string;
  originUrl: string;
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
