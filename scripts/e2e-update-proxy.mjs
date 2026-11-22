#!/usr/bin/env node
/**
 * A man in the middle for scripts/e2e.sh: forwards everything to the real portal, and in the mode written to
 * <modeFile> corrupts what a self-updating worker receives, so the e2e can check the worker refuses and reports it.
 *
 *   node scripts/e2e-update-proxy.mjs <listenPort> <portalOrigin> <modeFile>
 *
 * Modes:
 *   pass           forward unchanged
 *   tamper-file    flip one letter of the served venstudio-worker.ts (same length: only the sha256 can catch it)
 *   bad-signature  flip one byte of the manifest's signature
 *   expired        re-sign the manifest with the portal's real key, issued two hours ago (only the expiry can catch it)
 *
 * "expired" needs the portal's signing key: SIGNING_KEY_ENC (update_signing_keys.private_key_enc), SIGNING_KEY_ID and
 * ENCRYPTION_KEY. Test use only.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { decrypt, parseKey } from "../apps/portal/lib/crypto/secretbox.ts";
import { signManifest, signingKeyAad } from "../apps/portal/lib/update-manifest.ts";

const [port, target, modeFile] = process.argv.slice(2);
if (!port || !target || !modeFile) {
  console.error("usage: e2e-update-proxy.mjs <listenPort> <portalOrigin> <modeFile>");
  process.exit(2);
}

const mode = () => {
  try {
    return readFileSync(modeFile, "utf8").trim() || "pass";
  } catch {
    return "pass";
  }
};

let privateKey;
function signingKey() {
  if (!privateKey) {
    privateKey = decrypt(process.env.SIGNING_KEY_ENC ?? "", parseKey(process.env.ENCRYPTION_KEY), signingKeyAad(process.env.SIGNING_KEY_ID ?? ""));
  }
  return privateKey;
}

const DROP_REQ = new Set(["host", "content-length", "connection", "accept-encoding", "transfer-encoding"]);
const DROP_RES = new Set(["content-length", "content-encoding", "transfer-encoding", "connection"]);

http
  .createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQ.has(k) && typeof v === "string") headers[k] = v;
      const upstream = await fetch(target + req.url, { method: req.method, headers, body: body.length ? body : undefined, redirect: "manual" });
      let out = Buffer.from(await upstream.arrayBuffer());
      const m = mode();
      if (req.url === "/install/venstudio-worker.ts" && upstream.ok && m === "tamper-file") {
        const i = out.indexOf("Self-update");
        if (i >= 0) out[i + 10] ^= 0x20; // "e" <-> "E"
        console.log(`tampered ${req.url}`);
      }
      if (req.url === "/api/worker/update" && req.method === "POST" && upstream.status === 200 && (m === "bad-signature" || m === "expired")) {
        const j = JSON.parse(out.toString("utf8"));
        if (j.manifest) {
          if (m === "bad-signature") {
            const sig = Buffer.from(j.manifest.signature, "base64");
            sig[7] ^= 0xff;
            j.manifest.signature = sig.toString("base64");
          } else {
            const { signature: _old, ...unsigned } = j.manifest;
            const issued = Date.now() - 2 * 3600_000;
            unsigned.issuedAt = new Date(issued).toISOString();
            unsigned.expiresAt = new Date(issued + 600_000).toISOString();
            j.manifest = signManifest(unsigned, signingKey());
          }
          console.log(`${m}: manifest for ${j.manifest.version}`);
        }
        out = Buffer.from(JSON.stringify(j));
      }
      const resHeaders = {};
      upstream.headers.forEach((v, k) => {
        if (!DROP_RES.has(k)) resHeaders[k] = v;
      });
      res.writeHead(upstream.status, resHeaders);
      res.end(upstream.status === 204 ? undefined : out);
    } catch (err) {
      console.error(`proxy error on ${req.url}: ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(502);
      res.end();
    }
  })
  .listen(Number(port), () => console.log(`update proxy on ${port} -> ${target}`));
