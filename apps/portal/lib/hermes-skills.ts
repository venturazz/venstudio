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

/**
 * Pull a skills list out of a chat reply. The model is asked for a bare JSON array, but replies often wrap it
 * in prose or a ```json fence, so take the first [...] block that parses.
 */
export function skillsFromChatReply(text: string): HermesSkill[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  for (const candidate of [fenced, text].filter((t): t is string => typeof t === "string")) {
    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start === -1 || end <= start) continue;
    try {
      const parsed = parseSkills(JSON.parse(candidate.slice(start, end + 1)));
      if (parsed.length > 0) return parsed;
    } catch {}
  }
  return [];
}
