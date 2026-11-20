import "server-only";
import { env } from "../env.ts";
import { explainFetchError } from "../ai-gateway.ts";
import { getCapabilities } from "../capabilities.ts";
import { listEndpointHealth, recordEndpointResult } from "../endpoint-health.ts";
import { fetchMedia } from "../safe-fetch.ts";
import { normalizeGatewayBase } from "../../gateway-url.ts";
import { originOf } from "../../net-address.ts";
import type { RouterModel } from "../../studio/capabilities.ts";
import type { Format } from "../../studio/catalog.ts";
import { failureFromStatus, shortProviderError, type EndpointHealth } from "../../studio/endpoint-health.ts";
import { imageIssues, MAX_IMAGE_BYTES, sniffImage } from "../../studio/image-result.ts";
import type { FailureClass } from "../../studio/pacing.ts";
import {
  pickProvenImageModel,
  readRouterImageItem,
  retryWaitSec,
  routerImageSize,
  routerImageTestOrder,
  routerProviderName,
} from "../../studio/router-media.ts";
import { providerOrderHint, type GeneratedImage } from "./hermes-image.ts";

/**
 * Images straight from 9router (POST /v1/images/generations). The automatic chain uses a 9router model only after a
 * real call proved it (a production or the Settings test, see endpoint_health): a listed model is not a working one.
 * Every call records its outcome, and a 4xx sets the model aside so it is never sent the same request again.
 */

const IMAGE_TIMEOUT_MS = 120_000;

export type RouterImageResult = { ok: true; image: GeneratedImage } | { ok: false; error: string; cause: FailureClass; model?: string };

async function listedImageModels(): Promise<RouterModel[]> {
  if (!env().NINEROUTER_BASE_URL) return [];
  try {
    const snap = await getCapabilities();
    return snap?.router?.status.ok ? snap.router.lists.image : [];
  } catch {
    return [];
  }
}

/**
 * The proven 9router image model the automatic chain would use now, from the stored scan and health only (no network).
 * `exclude` holds models that failed with a 4xx earlier in the same stage. Null when none is proven.
 */
export async function routerImageModel(exclude: ReadonlySet<string> = new Set()): Promise<RouterModel | null> {
  const models = await listedImageModels();
  if (models.length === 0) return null;
  return pickProvenImageModel(models, await listEndpointHealth("image"), providerOrderHint(), exclude, Date.now());
}

/** What the Settings note shows: the listed models with their health. No network. */
export async function routerImageOverview(): Promise<{ models: RouterModel[]; health: EndpointHealth[]; proven: RouterModel | null }> {
  const models = await listedImageModels();
  const health = models.length > 0 ? await listEndpointHealth("image") : [];
  return { models, health, proven: models.length > 0 ? pickProvenImageModel(models, health, providerOrderHint(), new Set(), Date.now()) : null };
}

function messageFor(status: number, detail: string, provider: string): string {
  if (status === 401 || status === 403) return "9router rejected the API key. Copy a key from the 9router dashboard into NINEROUTER_API_KEY.";
  if (status === 503) return "9router said All accounts unavailable for this image model.";
  return shortProviderError(status, detail, provider);
}

/** One request to one model, with its outcome recorded. A 503 is retried once after Retry-After, like speech. */
async function callModel(model: RouterModel, job: { prompt: string; format: Format }): Promise<RouterImageResult> {
  const { NINEROUTER_BASE_URL, NINEROUTER_API_KEY } = env();
  if (!NINEROUTER_BASE_URL) return { ok: false, error: "9router is not configured", cause: "auth" };
  const base = normalizeGatewayBase(NINEROUTER_BASE_URL);
  const url = `${base}/v1/images/generations`;
  const provider = routerProviderName(model.id, model.ownedBy);
  const fail = async (cause: FailureClass, error: string): Promise<RouterImageResult> => {
    await recordEndpointResult("9router", model.id, "image", { ok: false, failureClass: cause, error });
    return { ok: false, error, cause, model: model.id };
  };
  let body: unknown;
  try {
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(NINEROUTER_API_KEY ? { authorization: `Bearer ${NINEROUTER_API_KEY}` } : {}) },
        body: JSON.stringify({ model: model.id, prompt: job.prompt, n: 1, size: routerImageSize(job.format), response_format: "b64_json" }),
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        cache: "no-store",
      });
      if (res.status === 503 && attempt === 0) {
        await res.arrayBuffer().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, retryWaitSec(res.headers.get("retry-after")) * 1000));
        continue;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return fail(failureFromStatus(res.status), messageFor(res.status, detail, provider));
      }
      body = await res.json().catch(() => null);
      done = true;
    }
    if (!done) return fail("busy", messageFor(503, "", provider));
  } catch (err) {
    const e = explainFetchError(err, url, undefined, IMAGE_TIMEOUT_MS);
    return fail("unreachable", e.hint ? `${e.error}. ${e.hint}` : e.error);
  }
  const item = readRouterImageItem(body);
  let bytes: Uint8Array;
  let originUrl = "";
  try {
    if (item?.kind === "b64") {
      bytes = new Uint8Array(Buffer.from(item.value, "base64"));
    } else if (item?.kind === "url") {
      const origin = originOf(base);
      bytes = (await fetchMedia(item.value, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 60_000, trustedOrigins: origin ? [origin] : [] })).bytes;
      originUrl = item.value;
    } else {
      return fail("content", "9router returned no image");
    }
  } catch (err) {
    return fail("content", err instanceof Error ? err.message : "The image from 9router could not be read");
  }
  const info = sniffImage(bytes);
  const issues = imageIssues(info, job.format);
  if (issues.length > 0 || !info) return fail("content", issues.join(". ") || "The image from 9router could not be read");
  await recordEndpointResult("9router", model.id, "image", { ok: true });
  // A direct 9router call has no Hermes chain in front, so there is no backend report: empty, as GeneratedImage documents.
  return { ok: true, image: { bytes, info, provider, model: model.id, backend: "", originUrl } };
}

/** One image from a proven 9router model, for the automatic chain. Never calls a model that is only listed. */
export async function generateRouterImage(
  job: { prompt: string; format: Format; note?: string },
  exclude: ReadonlySet<string> = new Set(),
): Promise<RouterImageResult> {
  if (!env().NINEROUTER_BASE_URL) return { ok: false, error: "9router is not configured", cause: "auth" };
  const model = await routerImageModel(exclude);
  if (!model) return { ok: false, error: "No 9router image model is proven yet (press Test 9router image in Settings)", cause: "content" };
  const prompt = job.note ? `${job.prompt}\n\nOwner note: ${job.note}` : job.prompt;
  return callModel(model, { prompt, format: job.format });
}

export interface RouterImageTestLine {
  model: string;
  ok: boolean;
  text: string;
}

/**
 * The Settings test: tries the listed image models in routerImageTestOrder (proven, then untried, then set aside),
 * at most three, and stops at the first that makes a real image. Every outcome is recorded, so a model that works
 * becomes proven and one that answers with a 4xx is set aside. Nothing is saved and no provider terms change.
 */
export async function testRouterImages(): Promise<{ ok: true; lines: RouterImageTestLine[]; image: GeneratedImage } | { ok: false; lines: RouterImageTestLine[]; error: string }> {
  if (!env().NINEROUTER_BASE_URL) return { ok: false, lines: [], error: "9router is not configured. Set NINEROUTER_BASE_URL and NINEROUTER_API_KEY." };
  const models = await listedImageModels();
  if (models.length === 0) return { ok: false, lines: [], error: "The last scan lists no 9router image model. Press Scan now first." };
  const order = routerImageTestOrder(models, await listEndpointHealth("image"), Date.now());
  const lines: RouterImageTestLine[] = [];
  for (const model of order) {
    const r = await callModel(model, { prompt: "A simple test picture: a red circle on a plain light background. No text.", format: "short" });
    if (r.ok) {
      lines.push({ model: model.id, ok: true, text: `${model.id}: worked, ${r.image.info.width}x${r.image.info.height} ${r.image.info.mime}. Proven, so the studio may use it after Hermes.` });
      return { ok: true, lines, image: r.image };
    }
    const aside = r.cause === "client" ? " Set aside: the studio will not send it this request again." : "";
    lines.push({ model: model.id, ok: false, text: `${model.id}: ${r.error}${aside}` });
    if (r.cause === "auth") break;
  }
  return { ok: false, lines, error: "No 9router image model worked, so the studio will not use 9router images." };
}
