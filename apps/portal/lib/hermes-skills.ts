export interface HermesSkill {
  name: string;
  description: string;
  category: string;
}

/** /v1/skills answers a bare array; accept {data: [...]} or {skills: [...]} too, in case a version wraps it. */
export function parseSkills(body: unknown): HermesSkill[] {
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? (body as { data: unknown[] }).data
      : Array.isArray((body as { skills?: unknown })?.skills)
        ? (body as { skills: unknown[] }).skills
        : [];
  return list
    .map((s) => s as { name?: unknown; description?: unknown; category?: unknown })
    .filter((s) => typeof s.name === "string" && s.name.length > 0)
    .map((s) => ({
      name: String(s.name),
      description: typeof s.description === "string" ? s.description : "",
      category: typeof s.category === "string" && s.category ? s.category : "other",
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/** Groups skills by category, preserving the sorted order. */
export function groupSkills(skills: HermesSkill[]): Array<[string, HermesSkill[]]> {
  const map = new Map<string, HermesSkill[]>();
  for (const s of skills) map.set(s.category, [...(map.get(s.category) ?? []), s]);
  return [...map.entries()];
}
