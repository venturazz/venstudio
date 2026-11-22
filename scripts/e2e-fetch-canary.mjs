/**
 * Test use only. Preloaded into the portal by CI's browser end-to-end step (NODE_OPTIONS=--import=<this file>) to
 * prove the portal never fetches a study's public links itself: Hermes does the looking. Any request from the
 * portal process to a canary host (YouTube and its media hosts, GitHub) is written to $E2E_FETCH_CANARY and fails
 * loudly; scripts/ui-e2e.mjs asserts the file stays empty. Without $E2E_FETCH_CANARY this file does nothing.
 *
 *   E2E_FETCH_CANARY=<file> E2E_FETCH_CANARY_HOSTS=youtube.com,youtu.be,... node --import ./scripts/e2e-fetch-canary.mjs ...
 */
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const file = process.env.E2E_FETCH_CANARY;
const hosts = (process.env.E2E_FETCH_CANARY_HOSTS ?? "youtube.com,youtu.be,youtube-nocookie.com,googlevideo.com,ytimg.com,github.com,githubusercontent.com")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function hostOf(target) {
  try {
    if (typeof target === "string") return new URL(target).hostname.toLowerCase();
    if (target instanceof URL) return target.hostname.toLowerCase();
    if (target && typeof target === "object") {
      if (typeof target.url === "string") return new URL(target.url).hostname.toLowerCase();
      return String(target.hostname ?? target.host ?? "").replace(/:\d+$/, "").toLowerCase();
    }
  } catch {
    return "";
  }
  return "";
}

function check(target, via) {
  const host = hostOf(target);
  if (!host || !hosts.some((h) => host === h || host.endsWith(`.${h}`))) return;
  const line = JSON.stringify({ at: new Date().toISOString(), via, host, url: typeof target === "string" ? target : target instanceof URL ? target.href : String(target?.url ?? host) });
  appendFileSync(file, `${line}\n`);
  throw new Error(`E2E fetch canary: the portal tried to reach ${host} itself (${via}); public links are looked at by Hermes, never fetched by the portal`);
}

if (file) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function canaryFetch(input, init) {
    try {
      check(input, "fetch");
    } catch (err) {
      return Promise.reject(err);
    }
    return realFetch.call(this, input, init);
  };
  for (const [name, mod] of [["http", http], ["https", https]]) {
    for (const fn of ["request", "get"]) {
      const real = mod[fn];
      mod[fn] = function canaryRequest(...args) {
        check(args[0], `${name}.${fn}`);
        return real.apply(this, args);
      };
    }
  }
  syncBuiltinESMExports();
}
