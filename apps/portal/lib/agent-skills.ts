/**
 * /install/agent-skills.json: every skill in the vendored styles (styles/skills/, curated and candidate) and the kits
 * they use, for the workers that run Muse agent tasks (worker 0.17.0+). Pure.
 *
 * It travels like env-packs.json: listed with its sha256 in the signed update manifest only for a worker that reports
 * the file, downloaded from /install/ and verified before use. Files are base64 because skills carry fonts and audio.
 * Each skill's and kit's digest is the styles validator's packDigest over its files (the sha256 in styles/lock.json);
 * the worker checks it again before it writes <home>/agent-skills/<kit>/skills/<id>/ and <home>/agent-skills/<kit>/kit/,
 * the layout the skills expect (a skill finds its kit at ../../kit). Nothing in it runs on arrival.
 * The worker's reader is venstudio-worker.ts parseAgentSkillsBundle; tests keep the two in step.
 */

export const AGENT_SKILLS_FILE_NAME = "agent-skills.json";
export const AGENT_SKILLS_KIND = "venstudio-agent-skills";
export const AGENT_SKILLS_FORMAT = 1;
/** Folder for skills without a kit. */
export const NO_KIT = "_none";

export interface AgentSkillFile {
  path: string;
  base64: string;
}
export interface AgentSkillsBundle {
  format: typeof AGENT_SKILLS_FORMAT;
  kind: typeof AGENT_SKILLS_KIND;
  commit: string | null;
  kits: Array<{ id: string; version: string; sha256: string; files: AgentSkillFile[] }>;
  skills: Array<{ id: string; status: "curated" | "candidate"; version: string; kit: string | null; packs: string[]; sha256: string; files: AgentSkillFile[] }>;
}

type Source = { files: ReadonlyMap<string, Uint8Array> };
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const files = (m: ReadonlyMap<string, Uint8Array>): AgentSkillFile[] =>
  [...m.keys()].sort(byName).map((path) => ({ path, base64: Buffer.from(m.get(path) as Uint8Array).toString("base64") }));

export function agentSkillsBundle(input: {
  commit: string | null;
  kits: ReadonlyArray<{ id: string; version: string; sha256: string } & Source>;
  skills: ReadonlyArray<{ id: string; status: "curated" | "candidate"; version: string; kit: string | null; packs: readonly string[]; sha256: string } & Source>;
}): AgentSkillsBundle {
  return {
    format: AGENT_SKILLS_FORMAT,
    kind: AGENT_SKILLS_KIND,
    commit: input.commit,
    kits: [...input.kits].sort((a, b) => byName(a.id, b.id)).map((k) => ({ id: k.id, version: k.version, sha256: k.sha256, files: files(k.files) })),
    skills: [...input.skills]
      .sort((a, b) => byName(a.id, b.id))
      .map((s) => ({ id: s.id, status: s.status, version: s.version, kit: s.kit, packs: [...s.packs], sha256: s.sha256, files: files(s.files) })),
  };
}

/** The served bytes: stable for the same skills. */
export function agentSkillsText(bundle: AgentSkillsBundle): string {
  return `${JSON.stringify(bundle)}\n`;
}

/** The capability a worker reports for an installed skill, and the one a Muse render of that skill is queued under. */
export function skillCapability(id: string, version: string): string {
  return `skill:${id}@${version}`;
}
