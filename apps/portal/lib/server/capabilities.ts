import "server-only";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { explainFetchError } from "./ai-gateway.ts";
import { hermesStatus } from "./hermes.ts";
import { hermesJson } from "./hermes-json.ts";
import { normalizeGatewayBase } from "../gateway-url.ts";
import {
  capabilitiesPrompt,
  classifySkill,
  emptyRouterLists,
  parseRouterList,
  parseVoiceList,
  validateHermesCapabilities,
  type CapabilitySnapshot,
  type HermesScan,
  type HermesSkillEntry,
  type RouterLists,
  type RouterScan,
  type SourceStatus,
} from "../studio/capabilities.ts";

/**
 * Live discovery of what Hermes and 9router can do. Nothing here names a skill or a model: Hermes is asked in a chat
 * turn what it has (its /v1/skills endpoint is unreliable), and 9router is asked for its lists. The result is stored
 * in capability_scans; pages read only that row (getCapabilities) and never wait on the network.
 */

const ROUTER_PROBE_TIMEOUT_MS = 15_000;
const HERMES_TIMEOUT_MS = 120_000;
/** A snapshot older than this is refreshed in the background when Settings is opened. */
const FRESH_MS = 6 * 60 * 60_000;
/** A snapshot with a source down is retried sooner. */
const RETRY_MS = 10 * 60_000;

type ListKey = Exclude<keyof RouterLists, "voices">;
const PROBES: Array<{ key: ListKey; path: string; optional: boolean }> = [
  { key: "chat", path: "/v1/models", optional: false },
  { key: "image", path: "/v1/models/image", optional: false },
  { key: "tts", path: "/v1/models/tts", optional: false },
  { key: "web", path: "/v1/models/web", optional: false },
  { key: "stt", path: "/v1/models/stt", optional: false },
  { key: "video", path: "/v1/models/video", optional: true },
];

function routerHeaders(key: string | undefined): HeadersInit {
  return key ? { authorization: `Bearer ${key}` } : {};
}

async function probe(url: string, key: string | undefined, optional: boolean): Promise<{ status: SourceStatus; body: unknown }> {
  try {
    const res = await fetch(url, { headers: routerHeaders(key), signal: AbortSignal.timeout(ROUTER_PROBE_TIMEOUT_MS), cache: "no-store" });
    // A 9router without video support answers 404 for that list. That is an empty list, not a failure.
    if (res.status === 404 && optional) return { status: { configured: true, ok: true }, body: null };
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? "9router rejected the API key. Copy a key from the 9router dashboard into NINEROUTER_API_KEY."
          : res.status === 404
            ? "9router has no such list. This version may be older than the one the studio expects."
            : "";
      return { status: { configured: true, ok: false, error: `HTTP ${res.status}`, hint }, body: null };
    }
    return { status: { configured: true, ok: true }, body: (await res.json()) as unknown };
  } catch (err) {
    const e = explainFetchError(err, url, undefined, ROUTER_PROBE_TIMEOUT_MS);
    return { status: { configured: true, ok: false, error: e.error, hint: e.hint }, body: null };
  }
}

async function scanRouter(): Promise<RouterScan> {
  const { NINEROUTER_BASE_URL, NINEROUTER_API_KEY } = env();
  const lists = emptyRouterLists();
  if (!NINEROUTER_BASE_URL) {
    return { status: { configured: false, ok: false, error: "9router is not configured", hint: "Set NINEROUTER_BASE_URL and NINEROUTER_API_KEY." }, probes: {}, lists };
  }
  const base = normalizeGatewayBase(NINEROUTER_BASE_URL);
  const settled = await Promise.allSettled(PROBES.map((p) => probe(`${base}${p.path}`, NINEROUTER_API_KEY, p.optional)));
  const probes: Record<string, SourceStatus> = {};
  PROBES.forEach((p, i) => {
    const r = settled[i];
    if (r.status === "rejected") {
      probes[p.key] = { configured: true, ok: false, error: "Request failed" };
      return;
    }
    probes[p.key] = r.value.status;
    if (r.value.status.ok) lists[p.key] = parseRouterList(r.value.body);
  });

  // Some 9router versions list voices only through the audio endpoint.
  if (lists.tts.length === 0) {
    const v = await probe(`${base}/v1/audio/voices`, NINEROUTER_API_KEY, true);
    probes.voices = v.status;
    if (v.status.ok) lists.voices = parseVoiceList(v.body);
  }

  const anyOk = Object.values(probes).some((s) => s.ok);
  const firstFail = Object.values(probes).find((s) => !s.ok);
  const status: SourceStatus = anyOk
    ? { configured: true, ok: true }
    : { configured: true, ok: false, error: firstFail?.error ?? "No answer", hint: firstFail?.hint ?? "" };
  return { status, probes, lists };
}

async function scanHermes(): Promise<HermesScan> {
  const { HERMES_BASE_URL } = env();
  const empty = { skills: [], imageProviders: [], voiceEngines: [], notes: "" };
  if (!HERMES_BASE_URL) {
    return { status: { configured: false, ok: false, error: "Hermes is not configured", hint: "Set HERMES_BASE_URL and HERMES_API_KEY." }, ...empty };
  }
  const [chat, api] = await Promise.all([
    hermesJson(capabilitiesPrompt(), validateHermesCapabilities, { retries: 1, timeoutMs: HERMES_TIMEOUT_MS }),
    hermesStatus().catch(() => null),
  ]);

  const skills: HermesSkillEntry[] = [];
  if (chat.ok) {
    for (const s of chat.value.skills) skills.push({ name: s.name, description: s.description, category: s.category, stages: s.stages, listedByApi: false });
  }
  // Skills that /v1/skills listed are real even when the chat answer missed them. Keywords classify these.
  if (api?.ok && api.skillsSource === "api") {
    for (const s of api.skills) {
      const known = skills.find((k) => k.name === s.name);
      if (known) {
        known.listedByApi = true;
        continue;
      }
      skills.push({ name: s.name, description: s.description.slice(0, 300), category: s.category, stages: classifySkill(s), listedByApi: true });
    }
  }

  const reachable = chat.ok || skills.length > 0;
  const status: SourceStatus = reachable
    ? { configured: true, ok: true }
    : { configured: true, ok: false, error: chat.ok ? "Hermes answered" : chat.error, hint: api?.hint ?? "" };
  return {
    status,
    skills,
    imageProviders: chat.ok ? chat.value.imageProviders : [],
    voiceEngines: chat.ok ? chat.value.voiceEngines : [],
    notes: chat.ok ? chat.value.notes : "",
  };
}

let inflight: Promise<CapabilitySnapshot> | undefined;

/** Runs both scans, stores the result and returns it. Concurrent callers share one scan. */
export function scanCapabilities(): Promise<CapabilitySnapshot> {
  inflight ??= runScan().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function runScan(): Promise<CapabilitySnapshot> {
  const [h, r] = await Promise.allSettled([scanHermes(), scanRouter()]);
  const errors: string[] = [];
  const snap: CapabilitySnapshot = {
    scannedAt: new Date().toISOString(),
    hermes: h.status === "fulfilled" ? h.value : null,
    router: r.status === "fulfilled" ? r.value : null,
    error: null,
  };
  if (h.status === "rejected") errors.push("The Hermes scan crashed");
  if (r.status === "rejected") errors.push("The 9router scan crashed");
  snap.error = errors.length > 0 ? errors.join(". ") : null;
  await db()`
    INSERT INTO capability_scans (id, scanned_at, hermes, router, error)
    VALUES ('current', ${snap.scannedAt}::timestamptz, ${JSON.stringify(snap.hermes)}::text::jsonb, ${JSON.stringify(snap.router)}::text::jsonb, ${snap.error})
    ON CONFLICT (id) DO UPDATE SET scanned_at = EXCLUDED.scanned_at, hermes = EXCLUDED.hermes, router = EXCLUDED.router, error = EXCLUDED.error`;
  return snap;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asHermes(v: unknown): HermesScan | null {
  if (!isObject(v) || !isObject(v.status) || !Array.isArray(v.skills)) return null;
  return v as unknown as HermesScan;
}

function asRouter(v: unknown): RouterScan | null {
  if (!isObject(v) || !isObject(v.status) || !isObject(v.lists)) return null;
  const scan = v as unknown as RouterScan;
  return { ...scan, lists: { ...emptyRouterLists(), ...scan.lists } };
}

/** The stored snapshot. Reads the database only, so it is safe to call while rendering a page. */
export async function getCapabilities(): Promise<CapabilitySnapshot | null> {
  const rows = await db()`SELECT scanned_at, hermes, router, error FROM capability_scans WHERE id = 'current'`;
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    scannedAt: new Date(row.scanned_at as string | Date).toISOString(),
    hermes: asHermes(row.hermes),
    router: asRouter(row.router),
    error: typeof row.error === "string" ? row.error : null,
  };
}

function isStale(snap: CapabilitySnapshot | null): boolean {
  if (!snap) return true;
  const age = Date.now() - new Date(snap.scannedAt).getTime();
  const down = !snap.hermes?.status.ok || !snap.router?.status.ok;
  return age >= (down ? RETRY_MS : FRESH_MS);
}

/** Starts a scan without waiting for it when the snapshot is missing or old. Never throws. */
export function ensureFreshInBackground(snap: CapabilitySnapshot | null): void {
  if (inflight || !isStale(snap)) return;
  void scanCapabilities().catch(() => {});
}
