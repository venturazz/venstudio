import "server-only";
import { env } from "./env.ts";
import { explainFetchError } from "./ai-gateway.ts";
import { normalizeGatewayBase } from "../gateway-url.ts";

/**
 * Client for the Hermes Agent API server (the studio's "brain": skills, workflows, memory).
 * Docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
 *
 * Hermes can run terminal commands, so it must only be reachable on the internal Docker network.
 * Only the portal holds HERMES_API_KEY; workers never see it.
 */

import { parseSkills, skillsFromChatReply, type HermesSkill } from "../hermes-skills.ts";
export type { HermesSkill };

export interface HermesStatus {
  configured: boolean;
  ok: boolean;
  url?: string;
  latencyMs?: number;
  version?: string;
  features: Record<string, boolean>;
  skills: HermesSkill[];
  /** Set when the connection works but the skills list couldn't be read. */
  skillsError?: string;
  /** "api" = /v1/skills, "chat" = asked Hermes in a chat turn because /v1/skills failed. */
  skillsSource?: "api" | "chat";
  error?: string;
  hint?: string;
  checkedAt?: string;
}

const TIMEOUT_MS = 30_000;
const CACHE_OK_MS = 5 * 60_000;
const CACHE_FAIL_MS = 60_000;
const INTERNAL = "http://<hermes container name>:8642";

function config() {
  const { HERMES_BASE_URL, HERMES_API_KEY } = env();
  if (!HERMES_BASE_URL) return null;
  return { base: normalizeGatewayBase(HERMES_BASE_URL), key: HERMES_API_KEY };
}

async function getJson(url: string, key: string | undefined) {
  const res = await fetch(url, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  const type = res.headers.get("content-type") ?? "";
  return { res, type, body: type.includes("json") ? await res.json() : await res.text() };
}

async function checkHermes(): Promise<HermesStatus> {
  const cfg = config();
  if (!cfg) return { configured: false, ok: false, features: {}, skills: [] };
  const url = `${cfg.base}/v1/capabilities`;
  const checkedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const cap = await getJson(url, cfg.key);
    const latencyMs = Date.now() - started;
    if (cap.res.status === 401 || cap.res.status === 403) {
      return {
        configured: true, ok: false, url, latencyMs, features: {}, skills: [], checkedAt,
        error: `HTTP ${cap.res.status}: Hermes rejected the key`,
        hint:
          "HERMES_API_KEY must equal Hermes's API_SERVER_KEY. If they match and this still fails, an old " +
          "API_SERVER_KEY line in Hermes's data folder (.env) is overriding it; remove that line and redeploy Hermes.",
      };
    }
    if (typeof cap.body === "string") {
      // An HTML page means the request hit the Hermes dashboard (port 9119 or a public domain), not the API.
      const dashboard = /<html/i.test(cap.body);
      return {
        configured: true, ok: false, url, latencyMs, features: {}, skills: [], checkedAt,
        error: dashboard ? "Reached the Hermes dashboard, not its API" : `Unexpected reply (HTTP ${cap.res.status})`,
        hint: dashboard
          ? `Use the API address on port 8642 (${INTERNAL}), not the dashboard domain or port 9119.`
          : "Check HERMES_BASE_URL points at the Hermes API server.",
      };
    }
    if (!cap.res.ok) {
      return { configured: true, ok: false, url, latencyMs, features: {}, skills: [], checkedAt, error: `HTTP ${cap.res.status}`, hint: "" };
    }
    const c = cap.body as { features?: Record<string, unknown>; version?: unknown; platform?: unknown };
    const features = Object.fromEntries(
      Object.entries(c.features ?? {}).filter(([, v]) => typeof v === "boolean"),
    ) as Record<string, boolean>;

    let skills: HermesSkill[] = [];
    let skillsError: string | undefined;
    let skillsSource: HermesStatus["skillsSource"];
    try {
      const sk = await getJson(`${cfg.base}/v1/skills`, cfg.key);
      if (sk.res.ok && typeof sk.body !== "string") {
        skills = parseSkills(sk.body);
        skillsSource = "api";
      } else {
        skillsError =
          sk.res.status === 404
            ? "This Hermes version has no /v1/skills endpoint."
            : `Hermes couldn't list its skills (HTTP ${sk.res.status}). ` +
              "Its log shows the cause under \"GET /v1/skills failed\"; this is a known Hermes bug in some versions.";
      }
    } catch (err) {
      skillsError = explainFetchError(err, `${cfg.base}/v1/skills`, { name: "Hermes", internal: INTERNAL }, TIMEOUT_MS).error;
    }
    if (skillsSource !== "api") {
      if (chatSkillsCache && Date.now() - chatSkillsCache.at < CHAT_SKILLS_TTL_MS) {
        skills = chatSkillsCache.skills;
        skillsSource = "chat";
        skillsError = undefined;
      } else {
        // Asking in chat takes a model turn (often 30+ s). Don't hold the status check for it: start it and
        // patch the cached status when it answers.
        startChatSkills(cfg);
        skillsError = `${skillsError ?? "Skills endpoint unavailable."} Asking Hermes for the list in a chat turn; refresh in a minute.`;
      }
    }
    return {
      configured: true, ok: true, url, latencyMs, checkedAt, features, skills, skillsError, skillsSource,
      version: typeof c.version === "string" ? c.version : typeof c.platform === "string" ? c.platform : undefined,
    };
  } catch (err) {
    return {
      configured: true, ok: false, url, features: {}, skills: [], checkedAt,
      ...explainFetchError(err, url, { name: "Hermes", internal: INTERNAL }, TIMEOUT_MS),
    };
  }
}

let cache: { at: number; status: HermesStatus } | undefined;
let inflight: Promise<HermesStatus> | undefined;

const CHAT_SKILLS_PROMPT =
  "List every skill and workflow you have installed. Use your skills tools to look them up; don't guess. " +
  'Reply with only a JSON array, no other text: [{"name": "...", "description": "one short sentence", "category": "..."}]. ' +
  "Use each skill's exact name as you would load it.";
const CHAT_SKILLS_TTL_MS = 60 * 60_000;
let chatSkillsCache: { at: number; skills: HermesSkill[] } | undefined;

/**
 * Fallback when /v1/skills is broken: ask Hermes in one chat turn. Costs a model call, so the result is
 * cached for an hour, and an empty or unparseable answer is never cached as "no skills".
 */
let chatInflight: Promise<void> | undefined;

function startChatSkills(cfg: { base: string; key?: string }) {
  chatInflight ??= skillsViaChat(cfg)
    .then((skills) => {
      if (skills.length > 0 && cache?.status.ok) {
        cache = { ...cache, status: { ...cache.status, skills, skillsSource: "chat", skillsError: undefined } };
      }
    })
    .catch(() => {})
    .finally(() => {
      chatInflight = undefined;
    });
}

async function skillsViaChat(cfg: { base: string; key?: string }): Promise<HermesSkill[]> {
  try {
    const res = await fetch(`${cfg.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
      body: JSON.stringify({
        model: "hermes-agent",
        stream: false,
        messages: [{ role: "user", content: CHAT_SKILLS_PROMPT }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const skills = skillsFromChatReply(body.choices?.[0]?.message?.content ?? "");
    if (skills.length > 0) chatSkillsCache = { at: Date.now(), skills };
    return skills;
  } catch {
    return [];
  }
}

function refresh(): Promise<HermesStatus> {
  inflight ??= checkHermes()
    .then((status) => {
      cache = { at: Date.now(), status };
      return status;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

/** Cached like the 9router status (stale-while-revalidate): pages never wait on a slow or missing Hermes. */
export async function hermesStatus(opts: { fresh?: boolean } = {}): Promise<HermesStatus> {
  if (opts.fresh || !cache) return refresh();
  const ttl = cache.status.ok ? CACHE_OK_MS : CACHE_FAIL_MS;
  if (Date.now() - cache.at >= ttl) void refresh().catch(() => {});
  return cache.status;
}
