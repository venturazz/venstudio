import { test } from "node:test";
import assert from "node:assert/strict";
import { manualUpdateMessage } from "./worker-update-message.ts";

const SHA = "0123456789abcdef".repeat(4);

test("the manual update message spells out every command and the sha256 to check", () => {
  const m = manualUpdateMessage({ portalUrl: "https://studio.example.com/", installSha256: SHA, withRemotion: false });
  assert.match(m, /^cd \/home\/hatch\/venstudio$/m);
  assert.match(m, /^curl -fsSL https:\/\/studio\.example\.com\/install\/install\.sh -o install\.sh$/m);
  assert.match(m, /^sha256sum install\.sh$/m);
  assert.match(m, /^bash install\.sh --portal https:\/\/studio\.example\.com --mode hold$/m);
  assert.ok(m.includes(`The sha256 should be ${SHA}. If it's different, stop`));
  // No enrollment code: the existing config.json is kept.
  assert.ok(!/--code/.test(m));
  assert.match(m, /signed by that key/);
  assert.ok(!/remotion/i.test(m));
});

test("a worker with the Remotion renderer gets --with-remotion", () => {
  const m = manualUpdateMessage({ portalUrl: "https://s.example", installSha256: SHA, withRemotion: true });
  assert.match(m, /^bash install\.sh --portal https:\/\/s\.example --mode hold --with-remotion$/m);
  assert.match(m, /Remotion renderer/);
});

test("a VPS or local worker gets the command line with its own mode, not the Muse message", () => {
  const m = manualUpdateMessage({ portalUrl: "https://s.example", installSha256: SHA, withRemotion: false, host: "vps", mode: "daemon" });
  assert.match(m, /^bash install\.sh --portal https:\/\/s\.example --mode daemon$/m);
  assert.ok(m.includes(`only if sha256sum prints ${SHA}`));
  assert.ok(!/Muse|hatch/.test(m));
  assert.match(m, /Restart the daemon/);
  // A Muse worker in tick mode keeps tick.
  assert.match(manualUpdateMessage({ portalUrl: "https://s.example", installSha256: SHA, withRemotion: false, host: "muse", mode: "tick" }), /--mode tick$/m);
});
