import "server-only";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { blockedAddressReason } from "../net-address.ts";

/**
 * Downloads a file a model pointed at, without letting the model reach the portal's own network.
 * https only (plain http only for hosts the owner configured, such as Hermes). Every address the name resolves
 * to is checked at connect time, so a DNS answer cannot change between the check and the connection.
 * Redirects are followed by hand (at most 3) and each hop goes through the same checks.
 */

export class SafeFetchError extends Error {}

export interface FetchedMedia {
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
}

export interface FetchMediaOptions {
  maxBytes: number;
  timeoutMs?: number;
  /** Host names the owner configured (for example the Hermes host). They may use http and a private address. */
  trustedHosts?: string[];
  maxRedirects?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

type LookupCallback = (err: Error | null, address?: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: dns.LookupOptions, cb: LookupCallback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as dns.LookupAddress[];
    for (const a of list) {
      const reason = blockedAddressReason(a.address);
      if (reason) return cb(new SafeFetchError(`${hostname} resolves to a ${reason}, which is not allowed`));
    }
    if (list.length === 0) return cb(new SafeFetchError(`${hostname} did not resolve`));
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function checkUrl(raw: string, trusted: string[]): { url: URL; isTrusted: boolean } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("The file address is not a valid URL");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isTrusted = trusted.some((t) => t.toLowerCase() === host);
  if (url.username || url.password) throw new SafeFetchError("The file address must not contain a login");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isTrusted)) {
    throw new SafeFetchError("The file address must start with https://");
  }
  if (!isTrusted && net.isIP(host)) {
    const reason = blockedAddressReason(host);
    if (reason) throw new SafeFetchError(`The file address points to a ${reason}, which is not allowed`);
  }
  return { url, isTrusted };
}

function once(url: URL, isTrusted: boolean, opts: Required<Pick<FetchMediaOptions, "maxBytes" | "timeoutMs">>) {
  return new Promise<{ status: number; location: string; contentType: string; bytes: Buffer }>((resolve, reject) => {
    const reqOptions: http.RequestOptions = {
      method: "GET",
      headers: { "user-agent": "VenStudio/1", accept: "image/*,audio/*,*/*;q=0.5" },
      // Trusted hosts may be private (Hermes on the internal network); everyone else is checked at connect time.
      ...(isTrusted ? {} : { lookup: guardedLookup as unknown as net.LookupFunction }),
    };
    const onResponse = (res: http.IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const location = String(res.headers.location ?? "");
        const contentType = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location, contentType, bytes: Buffer.alloc(0) });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new SafeFetchError(`The file host answered HTTP ${status}`));
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          return reject(new SafeFetchError(`The file is ${Math.round(declared / 1048576)} MB, over the ${Math.round(opts.maxBytes / 1048576)} MB limit`));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > opts.maxBytes) {
            res.destroy();
            reject(new SafeFetchError(`The file is over the ${Math.round(opts.maxBytes / 1048576)} MB limit`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, location, contentType, bytes: Buffer.concat(chunks) }));
        res.on("error", (e) => reject(e));
    };
    const req = url.protocol === "https:" ? https.request(url, reqOptions, onResponse) : http.request(url, reqOptions, onResponse);
    req.setTimeout(opts.timeoutMs, () => req.destroy(new SafeFetchError(`The file host did not answer within ${opts.timeoutMs / 1000} s`)));
    req.on("error", (e) => reject(e));
    req.end();
  });
}

/** Plain, owner-safe message for any failure while fetching. */
function plain(err: unknown, url: string): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  const e = err as { code?: string; message?: string };
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep the raw text
  }
  if (e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN") return new SafeFetchError(`The file host ${host} does not resolve`);
  if (e?.code === "ECONNREFUSED" || e?.code === "ECONNRESET") return new SafeFetchError(`The file host ${host} refused or dropped the connection`);
  if (e?.code === "ETIMEDOUT") return new SafeFetchError(`The file host ${host} did not answer in time`);
  return new SafeFetchError(`Could not download the file from ${host}${e?.message ? `: ${e.message.slice(0, 120)}` : ""}`);
}

export async function fetchMedia(rawUrl: string, options: FetchMediaOptions): Promise<FetchedMedia> {
  const trusted = options.trustedHosts ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? 3;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, isTrusted } = checkUrl(current, trusted);
    let result;
    try {
      result = await once(url, isTrusted, { maxBytes: options.maxBytes, timeoutMs });
    } catch (err) {
      throw plain(err, current);
    }
    if (result.status >= 300 && result.status < 400) {
      if (!result.location) throw new SafeFetchError("The file host redirected without saying where");
      try {
        current = new URL(result.location, url).toString();
      } catch {
        throw new SafeFetchError("The file host redirected to an invalid address");
      }
      continue;
    }
    return { bytes: result.bytes, contentType: result.contentType, finalUrl: current };
  }
  throw new SafeFetchError(`The file address redirected more than ${maxRedirects} times`);
}
