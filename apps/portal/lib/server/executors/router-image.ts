import "server-only";
import { env } from "../env.ts";
import { explainFetchError } from "../ai-gateway.ts";
import { getCapabilities } from "../capabilities.ts";
import { fetchMedia } from "../safe-fetch.ts";
import { normalizeGatewayBase } from "../../gateway-url.ts";
import { originOf } from "../../net-address.ts";
import type { RouterModel } from "../../studio/capabilities.ts";
import type { Format } from "../../studio/catalog.ts";
import { imageIssues, MAX_IMAGE_BYTES, sniffImage } from "../../studio/image-result.ts";
import { pickRouterImageModel, readRouterImageItem, retryWaitSec, routerImageSize, routerProviderName } from "../../studio/router-media.ts";
import { providerOrderHint, type GeneratedImage } from "./hermes-image.ts";

/**
 * Images straight from 9router (POST /v1/images/generations). Used after Hermes image_gen and only when the stored
 * capability scan shows 9router lists image models, so a 9router without image support costs nothing.
 */

const IMAGE_TIMEOUT_MS = 120_000;

export type RouterImageResult = { ok: true; image: GeneratedImage } | { ok: false; error: string };

/** The 9router image model that would be used now, from the stored scan only. Null when there is none. */
export async function routerImageModel(): Promise<RouterModel | null> {
  const { NINEROUTER_BASE_URL } = env();
  if (!NINEROUTER_BASE_URL) return null;
  try {
    const snap = await getCapabilities();
    if (!snap?.router?.status.ok) return null;
    return pickRouterImageModel(snap.router.lists.image, providerOrderHint());
  } catch {
    return null;
  }
}

function messageFor(status: number, detail: string): string {
  if (status === 401 || status === 403) return "9router rejected the API key. Copy a key from the 9router dashboard into NINEROUTER_API_KEY.";
  if (status === 400 && /invalid model format/i.test(detail)) return "9router said Invalid model format for the image model it listed.";
  if (status === 503) return "9router said All accounts unavailable for this image model.";
  return `9router answered HTTP ${status}${detail ? `: ${detail.slice(0, 160)}` : ""}.`;
}

export async function generateRouterImage(job: { prompt: string; format: Format; note?: string }): Promise<RouterImageResult> {
  const { NINEROUTER_BASE_URL, NINEROUTER_API_KEY } = env();
  if (!NINEROUTER_BASE_URL) return { ok: false, error: "9router is not configured" };
  const model = await routerImageModel();
  if (!model) return { ok: false, error: "9router lists no image model" };
  const base = normalizeGatewayBase(NINEROUTER_BASE_URL);
  const url = `${base}/v1/images/generations`;
  const prompt = job.note ? `${job.prompt}\n\nOwner note: ${job.note}` : job.prompt;
  let body: unknown;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(NINEROUTER_API_KEY ? { authorization: `Bearer ${NINEROUTER_API_KEY}` } : {}) },
        body: JSON.stringify({ model: model.id, prompt, n: 1, size: routerImageSize(job.format), response_format: "b64_json" }),
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        cache: "no-store",
      });
      // A 503 (All accounts unavailable) is retried once after Retry-After, like speech.
      if (res.status === 503 && attempt === 0) {
        await res.arrayBuffer().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, retryWaitSec(res.headers.get("retry-after")) * 1000));
        continue;
      }
      if (!res.ok) return { ok: false, error: messageFor(res.status, await res.text().catch(() => "")) };
      body = await res.json().catch(() => null);
      break;
    }
  } catch (err) {
    const e = explainFetchError(err, url, undefined, IMAGE_TIMEOUT_MS);
    return { ok: false, error: e.hint ? `${e.error}. ${e.hint}` : e.error };
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
      return { ok: false, error: "9router returned no image" };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The image from 9router could not be read" };
  }
  const info = sniffImage(bytes);
  const issues = imageIssues(info, job.format);
  if (issues.length > 0 || !info) return { ok: false, error: issues.join(". ") || "The image from 9router could not be read" };
  return { ok: true, image: { bytes, info, provider: routerProviderName(model.id, model.ownedBy), model: model.id, originUrl } };
}
