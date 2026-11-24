import test from "node:test";
import assert from "node:assert/strict";
import { defaultTimesFor, instantAt, nextSlots, parseCadence, parseScheduleSettings, slotGate, timesMismatch, zonedParts } from "./schedule.ts";

const cadence = (days: string, times: string[]) => {
  const r = parseCadence(days, times);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) throw new Error("unreachable");
  return r.cadence;
};

test("a cadence refuses what would silently mean something else", () => {
  assert.equal(parseCadence("daily", ["07:00"]).ok, true);
  assert.equal(parseCadence("weekly:mon,thu", ["07:00", "19:00"]).ok, true);
  assert.equal(parseCadence("every:2", ["07:00"]).ok, true);
  assert.equal(parseCadence("daily", []).ok, false);
  assert.equal(parseCadence("daily", ["7:00"]).ok, false);
  assert.equal(parseCadence("daily", ["25:00"]).ok, false);
  assert.equal(parseCadence("weekly:funday", ["07:00"]).ok, false);
  assert.equal(parseCadence("every:1", ["07:00"]).ok, false);
  assert.equal(parseCadence("cron:*/5", ["07:00"]).ok, false);
  // Duplicates are dropped and the hours are ordered: two videos at the same minute is one slot, not two.
  const r = parseCadence("daily", ["19:00", "07:00", "19:00"]);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.cadence.timesOfDay, ["07:00", "19:00"]);
});

test("07:00 in Jakarta is 00:00 UTC, and the wall clock reads back the same", () => {
  const at = instantAt("Asia/Jakarta", 2027, 3, 1, 7, 0);
  assert.equal(at.toISOString(), "2027-03-01T00:00:00.000Z");
  const p = zonedParts(at, "Asia/Jakarta");
  assert.deepEqual([p.hour, p.minute, p.day], [7, 0, 1]);
});

test("a daily schedule gives tomorrow at 07:00, never today's past slot", () => {
  // 2027-03-01 08:00 Jakarta: today's 07:00 has gone.
  const from = new Date("2027-03-01T01:00:00.000Z");
  const slots = nextSlots(cadence("daily", ["07:00"]), "Asia/Jakarta", from, 2);
  assert.deepEqual(
    slots.map((s) => s.toISOString()),
    ["2027-03-02T00:00:00.000Z", "2027-03-03T00:00:00.000Z"],
  );
  // Two videos a day: the second slot of the same day is still ahead.
  const two = nextSlots(cadence("daily", ["07:00", "19:00"]), "Asia/Jakarta", from, 2);
  assert.deepEqual(
    two.map((s) => s.toISOString()),
    ["2027-03-01T12:00:00.000Z", "2027-03-02T00:00:00.000Z"],
  );
});

test("weekly picks the named days in the schedule's zone, not the server's", () => {
  // Wednesday 2027-03-03 in Jakarta.
  const from = new Date("2027-03-03T00:00:00.000Z");
  const slots = nextSlots(cadence("weekly:mon,thu", ["07:00"]), "Asia/Jakarta", from, 4);
  assert.deepEqual(
    slots.map((s) => zonedParts(s, "Asia/Jakarta").weekday),
    ["thu", "mon", "thu", "mon"],
  );
});

test("every N days keeps its distance, counting from the first slot", () => {
  // One hour before the first slot, so 1 March 07:00 is still ahead. At exactly 07:00 it would count as gone.
  const from = new Date("2027-02-28T23:00:00.000Z");
  const slots = nextSlots(cadence("every:2", ["07:00"]), "Asia/Jakarta", from, 4);
  const days = slots.map((s) => zonedParts(s, "Asia/Jakarta").day);
  assert.deepEqual(days, [1, 3, 5, 7]);
  // The boundary is strict: standing on the slot itself, the next one is two days later, not now.
  const onTheSlot = nextSlots(cadence("every:2", ["07:00"]), "Asia/Jakarta", new Date("2027-03-01T00:00:00.000Z"), 1);
  assert.equal(zonedParts(onTheSlot[0], "Asia/Jakarta").day, 3);
});

test("a daylight-saving switch does not shift the schedule", () => {
  // London: BST begins 2027-03-28 at 01:00 UTC. 07:00 local is 06:00 UTC that day, 07:00 UTC the day before.
  assert.equal(instantAt("Europe/London", 2027, 3, 27, 7, 0).toISOString(), "2027-03-27T07:00:00.000Z");
  assert.equal(instantAt("Europe/London", 2027, 3, 28, 7, 0).toISOString(), "2027-03-28T06:00:00.000Z");
  const slots = nextSlots(cadence("daily", ["07:00"]), "Europe/London", new Date("2027-03-26T12:00:00.000Z"), 3);
  const local = slots.map((s) => {
    const p = zonedParts(s, "Europe/London");
    return `${p.day}@${p.hour}`;
  });
  assert.deepEqual(local, ["27@7", "28@7", "29@7"]);
});

test("a slot is skipped, with a reason, when it cannot run — not dropped", () => {
  const base = { scheduleState: "armed" as const, channelStatus: "active" as const, workerBusy: false, workerMinutesUsed: 0, workerMinutesBudget: 60 };
  assert.equal(slotGate(base).skip, null);
  assert.equal(slotGate({ ...base, workerBusy: true }).skip, "worker-busy");
  assert.equal(slotGate({ ...base, workerMinutesUsed: 60 }).skip, "budget");
  assert.equal(slotGate({ ...base, scheduleState: "paused" }).skip, "paused");
  assert.equal(slotGate({ ...base, channelStatus: "planning" }).skip, "paused");
  // A reason is always there for the owner to read.
  for (const gate of [slotGate({ ...base, workerBusy: true }), slotGate({ ...base, workerMinutesUsed: 99 })]) {
    assert.ok(gate.reason.length > 10);
  }
});
test("the channel's count becomes clock times, spread rather than stacked", () => {
  assert.deepEqual(defaultTimesFor(1), ["07:00"]);
  assert.deepEqual(defaultTimesFor(2), ["07:00", "19:00"]);
  const three = defaultTimesFor(3);
  assert.equal(three.length, 3);
  assert.equal(three[0], "07:00");
  assert.equal(three[2], "21:00");
  for (const t of three) assert.match(t, /^\d{2}:\d{2}$/);
  // A nonsense count is clamped, never a negative or an empty list.
  assert.deepEqual(defaultTimesFor(0), ["07:00"]);
});

test("a mismatch between the channel and the schedule is said out loud, in both directions", () => {
  assert.equal(timesMismatch(["07:00", "19:00"], 2), null);
  const fewer = timesMismatch(["07:00"], 2);
  assert.ok(fewer && fewer.includes("Add 1 more"));
  const more = timesMismatch(["07:00", "12:00", "19:00"], 2);
  assert.ok(more && more.includes("will not be used"));
});

test("a schedule's settings survive a hand-written row, and an empty one is harmless", () => {
  const s = parseScheduleSettings({ styleId: "flat-vector", durationSec: 120, language: "id", purposes: ["educate"], sound: { bed: "none", sfx: "rich", ambience: false } }, 45);
  assert.equal(s.styleId, "flat-vector");
  assert.equal(s.durationSec, 120);
  assert.deepEqual(s.sound, { bed: "none", sfx: "rich", ambience: false });
  const empty = parseScheduleSettings(undefined, 90);
  assert.equal(empty.durationSec, 90);
  assert.deepEqual(empty.sound, { bed: "auto", sfx: "sparse", ambience: true });
});
