/** The golden render payload (fixtures/render/explainer-payload.json), for worker tests. */
import { readFileSync } from "node:fs";

export const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/render/explainer-payload.json", import.meta.url), "utf8")) as Record<string, unknown>;

/**
 * The golden payload as a worker receives it. The fixture uses readable placeholder ids ("asset-shot-01"); the worker
 * only accepts UUID asset ids, because they become URL paths and file names. Everything else is the fixture's bytes.
 */
export function fixtureWithUuids(): Record<string, unknown> {
  const ids = new Map<string, string>();
  const uuid = (id: string) => {
    if (!ids.has(id)) ids.set(id, `f1f70000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
    return ids.get(id) as string;
  };
  const p = structuredClone(fixture) as Record<string, unknown> & { shots: Array<Record<string, unknown>>; inputs: string[] };
  p.shots = p.shots.map((s) => ({ ...s, assetId: uuid(String(s.assetId)) }));
  p.narrationAssetId = uuid(String(p.narrationAssetId));
  p.inputs = p.inputs.map(uuid);
  return p;
}

