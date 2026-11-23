import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoRecheckMatches,
  blockingRows,
  canRecheck,
  termsHeld,
  confirmHint,
  parseProviderRows,
  providerRowsUsed,
  providersFromPayload,
  recheckMessage,
  recheckRefusal,
} from "./terms-review.ts";
import { providerTermsIssues, type ProviderTerms } from "./asset-plan.ts";
import { onlyTermsIssues } from "./production.ts";
import { decisionHint, decisionLabel, decisionOptions } from "./review.ts";

const t = (name: string, kind: ProviderTerms["kind"], commercialOk: ProviderTerms["commercialOk"], note = ""): ProviderTerms => ({ name, kind, commercialOk, note });

const uses = [
  { title: "shot-01 image", provider: "canva", kind: "image" as const },
  { title: "shot-02 image", provider: "canva", kind: "image" as const },
  { title: "shot-03 image", provider: "unlisted-cloudflare-9router", kind: "image" as const },
  { title: "shot-04 image", provider: "fake-img", kind: "image" as const },
];

test("providerRowsUsed groups by name and kind with counts", () => {
  assert.deepEqual(providerRowsUsed(uses), [
    { name: "canva", kind: "image", count: 2 },
    { name: "unlisted-cloudflare-9router", kind: "image", count: 1 },
    { name: "fake-img", kind: "image", count: 1 },
  ]);
  // The same name as a voice is a different row.
  assert.equal(providerRowsUsed([{ title: "a", provider: "kokoro", kind: "image" }, { title: "b", provider: "kokoro", kind: "tts" }]).length, 2);
});

test("blockingRows names every unconfirmed or refused row and skips confirmed ones", () => {
  const rows = blockingRows(providerRowsUsed(uses), [t("canva", "image", "yes"), t("fake-img", "image", "no", "read the terms")]);
  assert.deepEqual(
    rows.map((r) => [r.name, r.kind, r.status, r.count]),
    [
      ["unlisted-cloudflare-9router", "image", "unknown", 1],
      ["fake-img", "image", "no", 1],
    ],
  );
  assert.equal(rows[1].note, "read the terms");
  // A row with no asset_providers entry at all is "unknown", like the gate treats it.
  assert.equal(blockingRows([{ name: "never-seen", kind: "image", count: 1 }], [])[0].status, "unknown");
});

test("blockingRows agrees with the gate: a row blocks exactly when providerTermsIssues has an issue for it", () => {
  const cases: ProviderTerms[][] = [[], [t("canva", "image", "yes")], [t("canva", "image", "yes"), t("unlisted-cloudflare-9router", "image", "yes"), t("fake-img", "image", "yes")], [t("canva", "tts", "yes")]];
  for (const terms of cases) {
    const issues = providerTermsIssues(uses, terms);
    const rows = blockingRows(providerRowsUsed(uses), terms);
    assert.equal(rows.length, issues.length);
    for (const r of rows) assert.ok(issues.some((i) => i.includes(r.name)), `${r.name} has an issue`);
  }
});

test("a confirmed image row does not cover the voice row of the same name", () => {
  const rows = blockingRows([{ name: "kokoro", kind: "tts", count: 1 }], [t("kokoro", "image", "yes")]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].hint ?? "", /You confirmed kokoro as an image provider; this row is kokoro as a voice provider/);
});

test("confirmHint: the unlisted- prefix in either direction, never for an unrelated name", () => {
  assert.equal(
    confirmHint({ name: "unlisted-canva", kind: "image" }, [t("canva", "image", "yes")]),
    "You confirmed canva; this one is unlisted-canva (Hermes said canva made it). Confirm it too?",
  );
  assert.equal(confirmHint({ name: "canva", kind: "image" }, [t("unlisted-canva", "image", "yes")]), "You confirmed unlisted-canva; this one is canva. Confirm it too?");
  // Only a "yes" counts, and only for the same kind.
  assert.equal(confirmHint({ name: "unlisted-canva", kind: "image" }, [t("canva", "image", "no")]), null);
  assert.equal(confirmHint({ name: "unlisted-canva", kind: "image" }, [t("canva", "image", "unknown")]), null);
  assert.equal(confirmHint({ name: "unlisted-canva", kind: "image" }, [t("qwen", "image", "yes")]), null);
  // The hint is attached to the blocking row; the row still blocks (nothing is confirmed for the owner).
  const rows = blockingRows([{ name: "unlisted-canva", kind: "image", count: 3 }], [t("canva", "image", "yes")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "unknown");
  assert.match(rows[0].hint ?? "", /^You confirmed canva/);
});

test("providersFromPayload prefers stored rows and falls back to the media of older cards", () => {
  const stored = [{ name: "canva", kind: "image" as const, count: 2 }];
  assert.deepEqual(providersFromPayload("assets", { providers: stored }), stored);
  assert.deepEqual(
    providersFromPayload("assets", { media: { images: [{ assetId: "a", shotRef: "shot-01", provider: "canva" }, { assetId: "b", shotRef: "shot-02", provider: "canva" }] } }),
    [{ name: "canva", kind: "image", count: 2 }],
  );
  assert.deepEqual(providersFromPayload("voice", { media: { voiceProvider: "kokoro" } }), [{ name: "kokoro", kind: "tts", count: 1 }]);
  assert.deepEqual(providersFromPayload("render", {}), []);
});

test("parseProviderRows keeps well-formed rows only", () => {
  assert.deepEqual(parseProviderRows([{ name: "Canva", kind: "image", count: 2 }, { name: "", kind: "image" }, { name: "x", kind: "music" }, "junk", { name: "kokoro", kind: "tts" }]), [
    { name: "canva", kind: "image", count: 2 },
    { name: "kokoro", kind: "tts", count: 1 },
  ]);
  assert.deepEqual(parseProviderRows(null), []);
});

const termsIssue = "Confirm the commercial-use terms for kokoro in Settings (Asset providers). 1 voice from it cannot publish until you do.";
const refusedIssue = "1 asset from fake-img cannot be published: Settings says fake-img is not cleared for commercial use. Make them again with another provider.";
const otherIssue = "The narration has clipped samples";

test("canRecheck: assets gate failures with a terms issue, and every voice gate failure", () => {
  assert.ok(canRecheck("gate-failure", "assets", [termsIssue]));
  assert.ok(canRecheck("gate-failure", "voice", [otherIssue, termsIssue]));
  assert.ok(canRecheck("gate-failure", "assets", [refusedIssue]));
  // A voice card is judged again on the narration it has, so a card made under older rules can continue.
  assert.ok(canRecheck("gate-failure", "voice", [otherIssue]));
  assert.ok(!termsHeld("gate-failure", "voice", [otherIssue]));
  assert.ok(termsHeld("gate-failure", "voice", [otherIssue, termsIssue]));
  assert.ok(!canRecheck("gate-failure", "assets", [otherIssue]));
  // A reel that voiced itself, held up only by its voice backend's terms: checked again without a new render.
  assert.ok(canRecheck("gate-failure", "render", [termsIssue]));
  assert.ok(!canRecheck("gate-failure", "render", [termsIssue, otherIssue]), "anything else on a render needs a new render");
  assert.ok(!canRecheck("gate-failure", "render", []));
  assert.ok(!canRecheck("gate-failure", "qc", [termsIssue]));
  assert.ok(!canRecheck("stage-error", "assets", [termsIssue]));
  assert.ok(!canRecheck("approval", "voice", []));
});

test("autoRecheckMatches: terms-only cards that use the changed row", () => {
  const card = { kind: "gate-failure" as const, stage: "voice", payload: { issues: [termsIssue], providers: [{ name: "kokoro", kind: "tts" as const, count: 1 }] } };
  assert.ok(autoRecheckMatches(card, { name: "kokoro", kind: "tts" }));
  // Another kind or another name is another row.
  assert.ok(!autoRecheckMatches(card, { name: "kokoro", kind: "image" }));
  assert.ok(!autoRecheckMatches(card, { name: "unlisted-kokoro", kind: "tts" }));
  // Mixed issues are not re-checked automatically: the owner decides.
  assert.ok(!autoRecheckMatches({ ...card, payload: { ...card.payload, issues: [termsIssue, otherIssue] } }, { name: "kokoro", kind: "tts" }));
  assert.ok(!autoRecheckMatches({ ...card, kind: "approval" }, { name: "kokoro", kind: "tts" }));
  // Older cards without stored rows match through their media.
  assert.ok(autoRecheckMatches({ kind: "gate-failure", stage: "voice", payload: { issues: [termsIssue], media: { voiceProvider: "kokoro" } } }, { name: "kokoro", kind: "tts" }));
});

test("recheckRefusal: open card, waiting run and waiting stage only", () => {
  const ok = { reviewState: "open", kind: "gate-failure" as const, stage: "assets", issues: [termsIssue], runState: "waiting-human", stageState: "waiting-human" };
  assert.equal(recheckRefusal(ok), null);
  assert.match(recheckRefusal({ ...ok, reviewState: "superseded" }) ?? "", /already decided or checked again/);
  assert.match(recheckRefusal({ ...ok, issues: [otherIssue] }) ?? "", /held up by provider terms/);
  assert.equal(recheckRefusal({ ...ok, stage: "voice", issues: [otherIssue] }), null);
  assert.match(recheckRefusal({ ...ok, runState: "cancelled" }) ?? "", /no longer waiting/);
  assert.match(recheckRefusal({ ...ok, stageState: "pending" }) ?? "", /no longer waiting/);
  assert.match(recheckRefusal({ ...ok, stageState: null }) ?? "", /no longer waiting/);
});

test("a re-check that now passes concludes; one still blocked yields a new card naming what blocks", () => {
  const before = providerTermsIssues(uses, []);
  assert.ok(onlyTermsIssues(before));
  const allYes = [t("canva", "image", "yes"), t("unlisted-cloudflare-9router", "image", "yes"), t("fake-img", "image", "yes")];
  assert.deepEqual(providerTermsIssues(uses, allYes), []);
  assert.deepEqual(blockingRows(providerRowsUsed(uses), allYes), []);
  assert.match(recheckMessage("assets", "asked-approval", []), /checks pass now\. Nothing was made again: approve the assets/);
  assert.equal(recheckMessage("render", "approved", []), "The checks pass now. The video was kept and the studio continues.");
  assert.match(recheckMessage("render", "asked-approval", []), /approve the video to continue/);
  assert.match(recheckMessage("voice", "approved", []), /narration was kept/);
  const someYes = [t("canva", "image", "yes")];
  const still = blockingRows(providerRowsUsed(uses), someYes).map((r) => r.name);
  assert.deepEqual(still, ["unlisted-cloudflare-9router", "fake-img"]);
  assert.equal(recheckMessage("assets", "gate-failure", still), "Checked again. Still blocked by unlisted-cloudflare-9router, fake-img. Nothing was made again.");
});

test("decisionOptions and labels for terms cards", () => {
  // Terms only: the re-check is the main button. Assets has no Retry (no shot failed); voice keeps it, named for what it does.
  assert.deepEqual(decisionOptions("gate-failure", { stage: "assets", issues: [termsIssue] }), ["recheck", "revise", "reject"]);
  assert.deepEqual(decisionOptions("gate-failure", { stage: "voice", issues: [termsIssue] }), ["recheck", "retry", "revise", "reject"]);
  // Mixed issues: Retry stays first, the re-check is offered too.
  assert.deepEqual(decisionOptions("gate-failure", { stage: "voice", issues: [otherIssue, termsIssue] }), ["retry", "recheck", "revise", "reject"]);
  // A voice card without terms issues can be checked again too. A card from before the voice-length rules has no fix
  // details, so Check again leads: that is how the owner's stuck "limit 10 percent" card continues.
  assert.deepEqual(decisionOptions("gate-failure", { stage: "voice", issues: [otherIssue] }), ["recheck", "retry", "revise", "reject"]);
  const oldLengthCard = ["Narration is 55.01 s, the script estimate is 47.6 s (limit 10 percent)"];
  assert.deepEqual(decisionOptions("gate-failure", { stage: "voice", issues: oldLengthCard }), ["recheck", "retry", "revise", "reject"]);
  assert.equal(decisionLabel("recheck", "gate-failure", "voice", { issues: oldLengthCard }), "Check again");
  assert.equal(decisionLabel("recheck", "gate-failure", "voice", { issues: [otherIssue] }), "Check again");
  assert.equal(decisionLabel("recheck", "gate-failure", "voice", { issues: [termsIssue] }), "Check the terms again");
  // Other gate failures, and calls without context, are unchanged.
  assert.deepEqual(decisionOptions("gate-failure", { stage: "render", issues: [termsIssue] }), ["recheck", "retry", "revise", "reject"], "Check the terms again on a skill-voiced reel held up only by terms");
  assert.equal(decisionLabel("recheck", "gate-failure", "render", { issues: [termsIssue] }), "Check the terms again");
  assert.match(decisionHint("recheck", "gate-failure", "render", { issues: [termsIssue] }) ?? "", /Nothing is rendered again/);
  assert.deepEqual(decisionOptions("gate-failure", { stage: "render", issues: [otherIssue] }), ["retry", "revise", "reject"]);
  assert.deepEqual(decisionOptions("gate-failure"), ["retry", "revise", "reject"]);
  assert.ok(!decisionOptions("stage-error", { stage: "assets", issues: [termsIssue] }).includes("recheck"));

  assert.equal(decisionLabel("recheck", "gate-failure", "assets"), "Check the terms again");
  assert.equal(decisionLabel("retry", "gate-failure", "voice"), "Make the voice again");
  assert.equal(decisionLabel("retry", "gate-failure", "assets"), "Retry failed shots");
  assert.equal(decisionLabel("retry", "stage-error", "assets"), "Retry");
  assert.equal(decisionLabel("retry", "gate-failure", "qc"), "Retry");
  assert.equal(decisionLabel("revise", "gate-failure", "assets"), "Send revision");
  assert.match(decisionHint("recheck", "gate-failure", "voice") ?? "", /Nothing is recorded again/);
  assert.match(decisionHint("recheck", "gate-failure", "assets") ?? "", /Nothing is made again/);
  assert.match(decisionHint("revise", "gate-failure", "assets") ?? "", /every image again/);
  assert.match(decisionHint("retry", "gate-failure", "voice") ?? "", /whole narration again/);
  // Revise on a voice card says where length and voice notes go.
  assert.match(decisionHint("revise", "gate-failure", "voice") ?? "", /length or speed rewrites the script to fit and keeps the pictures/);
  // The reel's own voice held up by terms: a revision note goes back to Hermes, which records the voice too.
  assert.equal(decisionHint("revise", "gate-failure", "render", { hermesRender: true, voiced: false }), "Hermes will redo the video with your note, its voice included.");
});
