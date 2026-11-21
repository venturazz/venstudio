/** The golden render payload (fixtures/render/explainer-payload.json), for worker tests. */
import { readFileSync } from "node:fs";

export const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/render/explainer-payload.json", import.meta.url), "utf8")) as Record<string, unknown>;

/**
 * The golden payload as a worker receives it. The fixture uses readable placeholder ids ("asset-shot-01"); the worker
 * only accepts UUID asset ids, because they become URL paths and file names. Every place the payload names an asset
 * (shots, narration, font, caption font, bed, accents, inputs) gets the same UUID; everything else is the fixture's bytes.
 */
export function fixtureWithUuids(): Record<string, unknown> {
  const ids = new Map<string, string>();
  const uuid = (id: string) => {
    if (!ids.has(id)) ids.set(id, `f1f70000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
    return ids.get(id) as string;
  };
  type Audio = { bed: { assetId: string } | null; sfx: Array<{ assetId: string }> };
  const p = structuredClone(fixture) as Record<string, unknown> & {
    shots: Array<Record<string, unknown>>;
    inputs: string[];
    captionStyle?: { fontAssetId: string | null };
    audio?: Audio;
  };
  p.shots = p.shots.map((s) => ({ ...s, assetId: uuid(String(s.assetId)) }));
  p.narrationAssetId = uuid(String(p.narrationAssetId));
  p.inputs = p.inputs.map(uuid);
  if (typeof p.fontAssetId === "string") p.fontAssetId = uuid(p.fontAssetId);
  if (p.captionStyle?.fontAssetId) p.captionStyle.fontAssetId = uuid(p.captionStyle.fontAssetId);
  if (p.audio?.bed) p.audio.bed.assetId = uuid(p.audio.bed.assetId);
  if (p.audio) p.audio.sfx = p.audio.sfx.map((s) => ({ ...s, assetId: uuid(s.assetId) }));
  return p;
}

/** The UUID fixtureWithUuids gives a placeholder id, e.g. "asset-bed". */
export function fixtureUuid(placeholder: string): string {
  const order = (fixture.inputs as string[]).indexOf(placeholder);
  if (order < 0) throw new Error(`${placeholder} is not an input of the fixture`);
  // Shots come first, then the narration, font and bed: the same order inputs lists them in.
  const p = fixtureWithUuids() as { inputs: string[] };
  return p.inputs[order];
}

/** The golden payload without what 0.7.0 added (captionStyle, audio): what a 0.6.0 portal sent. */
export function fixtureWithoutMix(): Record<string, unknown> {
  const p = fixtureWithUuids();
  delete p.captionStyle;
  delete p.audio;
  return p;
}
