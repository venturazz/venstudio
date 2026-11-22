import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { postToHermes } from "./hermes-transport.ts";
import { classifyFetchError, explainFetchFailure } from "./fetch-error.ts";

const HERMES = { name: "Hermes", internal: "http://<hermes container name>:8642" };

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1/chat/completions`, server };
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

test("postToHermes returns the status, headers and body of an answer", async () => {
  const { url, server } = await serve((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "retry-after": "7" });
      res.end(JSON.stringify({ echo: JSON.parse(raw), auth: req.headers.authorization }));
    });
  });
  try {
    const r = await postToHermes(url, { "content-type": "application/json", authorization: "Bearer k" }, JSON.stringify({ a: 1 }), 5_000);
    assert.equal(r.status, 200);
    assert.equal(r.header("Retry-After"), "7");
    assert.equal(r.header("x-missing"), null);
    assert.deepEqual(JSON.parse(r.text), { echo: { a: 1 }, auth: "Bearer k" });
  } finally {
    await close(server);
  }
});

test("a Hermes that takes the request and answers nothing in time is a response timeout (slow), not unreachable", async () => {
  const { url, server } = await serve(() => {
    // Accepts the request and never answers, like a Hermes busy with a long tool run.
  });
  try {
    const started = Date.now();
    const err = await postToHermes(url, {}, "{}", 400).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err, "the call must fail");
    assert.ok(Date.now() - started >= 380, "it waits the whole call timeout");
    assert.equal(classifyFetchError(err), "response-timeout");
    assert.equal((err as { cause?: { code?: string } }).cause?.code, "UND_ERR_HEADERS_TIMEOUT");
    const e = explainFetchFailure(err, url, HERMES, 600_000);
    assert.match(e.error, /^Hermes accepted the request but hadn't finished after 10 min$/);
  } finally {
    await close(server);
  }
});

test("an answer whose headers came but whose body did not finish is a body timeout (slow)", async () => {
  const { url, server } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"choices":');
  });
  try {
    await assert.rejects(postToHermes(url, {}, "{}", 400), (err: unknown) => {
      assert.equal(classifyFetchError(err), "response-timeout");
      assert.equal((err as { cause?: { code?: string } }).cause?.code, "UND_ERR_BODY_TIMEOUT");
      return true;
    });
  } finally {
    await close(server);
  }
});

test("a closed port is refused (unreachable) at once", async () => {
  const { url, server } = await serve(() => {});
  await close(server);
  await assert.rejects(postToHermes(url, {}, "{}", 5_000), (err: unknown) => {
    assert.equal(classifyFetchError(err), "refused");
    return true;
  });
});

test("a name that does not resolve is a DNS failure (unreachable)", async () => {
  await assert.rejects(postToHermes("http://no-such-host.invalid:8642/v1/chat/completions", {}, "{}", 5_000), (err: unknown) => {
    assert.equal(classifyFetchError(err), "dns");
    return true;
  });
});
