/**
 * The HTTP call under every Hermes model turn (lib/server/hermes-json.ts). No env and no database, so node --test can
 * run it against a local server. Not a route of its own: callers go through the shared gate (hermes-gate.ts).
 */
import http from "node:http";
import https from "node:https";
import type { RequestPhase } from "./fetch-error.ts";

/** A connection to Hermes that is not made within this long is a connect failure (unreachable), not a slow answer. */
export const CONNECT_TIMEOUT_MS = 15_000;
/** Largest reply read from Hermes. A voice or image answer may carry its bytes inline as base64. */
const MAX_REPLY_BYTES = 100 * 1024 * 1024;

export interface Posted {
  status: number;
  header: (name: string) => string | null;
  text: string;
}

function timeoutError(phase: RequestPhase, code: string, message: string): Error {
  return Object.assign(new Error(message), { name: "TimeoutError", phase, cause: { code } });
}

/**
 * One POST to Hermes with node:http(s) instead of fetch. Two reasons: fetch's built-in client gives up on any answer
 * whose headers take longer than 300 s (its headersTimeout), which would cut a 10-minute research turn at 5 minutes;
 * and fetch's timeout cannot say whether the connection was made. Here a timeout before the TCP connection is a
 * connect failure (UND_ERR_CONNECT_TIMEOUT, phase "connect"); after it, the answer was late (UND_ERR_HEADERS_TIMEOUT
 * or UND_ERR_BODY_TIMEOUT, phase "response"). A fresh connection per call, so a stale kept-alive socket is never reused.
 */
export function postToHermes(url: string, headers: Record<string, string>, body: string, timeoutMs: number, connectTimeoutMs: number = CONNECT_TIMEOUT_MS): Promise<Posted> {
  return new Promise<Posted>((resolve, reject) => {
    const u = new URL(url);
    let connected = false;
    let gotHeaders = false;
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let callTimer: ReturnType<typeof setTimeout> | undefined;
    let req: http.ClientRequest | undefined;
    const done = () => {
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(callTimer);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      done();
      req?.destroy();
      reject(err);
    };
    const options: http.RequestOptions = {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      agent: false,
    };
    const onResponse = (res: http.IncomingMessage) => {
      gotHeaders = true;
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (c: Buffer) => {
        total += c.length;
        if (total > MAX_REPLY_BYTES) return fail(new Error(`Hermes's answer is over ${MAX_REPLY_BYTES / 1048576} MB`));
        chunks.push(c);
      });
      res.on("end", () => {
        if (settled) return;
        done();
        const h = res.headers;
        resolve({
          status: res.statusCode ?? 0,
          header: (name) => {
            const v = h[name.toLowerCase()];
            return v === undefined ? null : Array.isArray(v) ? v.join(", ") : String(v);
          },
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", fail);
      res.on("close", () => {
        if (!settled && !res.complete) fail(Object.assign(new Error("Hermes closed the connection before its answer was complete"), { cause: { code: "ECONNRESET" } }));
      });
    };
    req = u.protocol === "https:" ? https.request(u, options, onResponse) : http.request(u, options, onResponse);
    req.on("socket", (socket) => {
      if (!socket.connecting) connected = true;
      else
        socket.once("connect", () => {
          connected = true;
          clearTimeout(connectTimer);
        });
    });
    req.on("error", fail);
    connectTimer = setTimeout(() => {
      if (!connected) fail(timeoutError("connect", "UND_ERR_CONNECT_TIMEOUT", `No connection to ${u.host} within ${Math.round(Math.min(connectTimeoutMs, timeoutMs) / 1000)} s`));
    }, Math.min(connectTimeoutMs, timeoutMs));
    callTimer = setTimeout(() => {
      if (!connected) return fail(timeoutError("connect", "UND_ERR_CONNECT_TIMEOUT", `No connection to ${u.host} within ${Math.round(timeoutMs / 1000)} s`));
      fail(timeoutError("response", gotHeaders ? "UND_ERR_BODY_TIMEOUT" : "UND_ERR_HEADERS_TIMEOUT", `Hermes had not finished its answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    req.end(body);
  });
}
