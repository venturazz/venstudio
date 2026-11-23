/**
 * Worker 0.17.0: agent skills from the signed agent-skills.json (apps/portal/lib/agent-skills.ts writes it): parsed and
 * digest-checked, installed in the layout the skills expect, reported as skill:<id>@<version> where the Muse agent takes
 * tasks, and named in TASK.md for a render task.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentKitDir,
  agentSkillDir,
  agentTaskMarkdown,
  handlers,
  installAgentSkills,
  installedAgentSkills,
  installedAgentSkillsSha,
  parseAgentSkillsBundle,
  type JobContext,
} from "./venstudio-worker.ts";
import { agentSkillsBundle, agentSkillsText } from "../portal/lib/agent-skills.ts";

const STYLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const digest = (files: Record<string, string>) => sha(Object.keys(files).sort().map((p) => `${p}\0${files[p]}\n`).join(""));

function folder(files: Record<string, string | Uint8Array>) {
  const m = new Map(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? new TextEncoder().encode(v) : v]));
  return { files: m, sha256: digest(Object.fromEntries([...m].map(([k, v]) => [k, sha(v)]))) };
}

function sample() {
  const kit = { id: "claude-animation-skills", version: "1.0.0", ...folder({ "setup.sh": "#!/bin/sh\necho kit\n", "fonts/a.woff2": new Uint8Array([0, 1, 2, 255]) }) };
  const sf = { id: "stick-figure", status: "candidate" as const, version: "1.0.0", kit: kit.id, packs: ["hermes-stick-figure"], ...folder({ "skill.json": "{}", "files/SKILL.md": "---\nname: stick-figure\n---\n" }) };
  const graph = { id: "graph", status: "curated" as const, version: "1.2.0", kit: null, packs: [], ...folder({ "files/SKILL.md": "---\nname: graph\n---\n" }) };
  return agentSkillsBundle({ commit: "c".repeat(40), kits: [kit], skills: [sf, graph] });
}

test("the portal's bundle reads back in the worker; a changed byte or an unsafe path is refused", () => {
  const b = sample();
  const parsed = parseAgentSkillsBundle(JSON.parse(agentSkillsText(b)));
  assert.deepEqual(parsed.skills.map((s) => [s.id, s.status, s.kit]), [["graph", "curated", null], ["stick-figure", "candidate", "claude-animation-skills"]]);
  assert.deepEqual([...parsed.kits[0].files.find((f) => f.path === "fonts/a.woff2")!.bytes], [0, 1, 2, 255]);
  const tampered = JSON.parse(agentSkillsText(b));
  tampered.skills[1].files[0].base64 = Buffer.from("changed").toString("base64");
  assert.throws(() => parseAgentSkillsBundle(tampered), /do not match its digest/);
  const unsafe = JSON.parse(agentSkillsText(b));
  unsafe.kits[0].files[0].path = "../../.ssh/authorized_keys";
  assert.throws(() => parseAgentSkillsBundle(unsafe), /unsafe or repeated file/);
  const noKit = JSON.parse(agentSkillsText(b));
  noKit.kits = [];
  assert.throws(() => parseAgentSkillsBundle(noKit), /names a kit that is not in the bundle/);
  assert.throws(() => parseAgentSkillsBundle({ kind: "other" }), /not an agent skills bundle/);
});

test("installed as the skills expect (skills/<id> next to kit/), reported, and kept when only the kit's setup added files", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-skills-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const body = Buffer.from(agentSkillsText(sample()));
  await installAgentSkills(home, body);
  const sf = agentSkillDir(home, { id: "stick-figure", kit: "claude-animation-skills" });
  const kit = agentKitDir(home, "claude-animation-skills");
  assert.equal(path.resolve(sf, "../../kit"), kit, "a skill finds its kit at ../../kit");
  assert.match(readFileSync(path.join(sf, "files/SKILL.md"), "utf8"), /stick-figure/);
  assert.equal((await stat(path.join(kit, "setup.sh"))).mode & 0o111, 0o111, "shell scripts stay executable");
  assert.equal(await installedAgentSkillsSha(home), sha(body));
  // The kit's setup writes its venv and models next to its files; an update that does not change the kit keeps them.
  await mkdir(path.join(kit, ".venv"), { recursive: true });
  await writeFile(path.join(kit, ".venv", "marker"), "x");
  let installed = await installedAgentSkills(home);
  assert.deepEqual(installed.map((k) => `${k.id}@${k.version}`).sort(), ["graph@1.2.0", "stick-figure@1.0.0"]);
  await installAgentSkills(home, body);
  assert.ok(existsSync(path.join(kit, ".venv", "marker")));
  // A skill file changed on disk is no longer reported.
  await writeFile(path.join(sf, "files/SKILL.md"), "edited");
  installed = await installedAgentSkills(home);
  assert.deepEqual(installed.map((k) => k.id), ["graph"]);
  // A bundle without a skill removes its folder.
  const less = sample();
  less.skills = less.skills.filter((s) => s.id !== "graph");
  await installAgentSkills(home, Buffer.from(agentSkillsText(less)));
  assert.ok(!existsSync(agentSkillDir(home, { id: "graph", kit: null })));
});

test("the vendored styles' skills build a bundle the worker accepts, within the update size limit", () => {
  const lock = JSON.parse(readFileSync(path.join(STYLES, "lock.json"), "utf8")) as {
    skills: Array<{ id: string; status: "curated" | "candidate"; version: string; kit: string | null; packs: string[]; sha256: string; files: Record<string, string> }>;
    kits: Array<{ id: string; version: string; sha256: string; files: Record<string, string> }>;
  };
  const read = (base: string, files: Record<string, string>) => new Map(Object.keys(files).map((rel) => [rel, new Uint8Array(readFileSync(path.join(base, rel)))]));
  const b = agentSkillsBundle({
    commit: null,
    kits: lock.kits.map((k) => ({ ...k, files: read(path.join(STYLES, "skills/kits", k.id), k.files) })),
    skills: lock.skills.map((s) => ({ ...s, files: read(path.join(STYLES, "skills", s.status, s.id), s.files) })),
  });
  const text = agentSkillsText(b);
  assert.ok(Buffer.byteLength(text) < 10 * 1024 * 1024, `${Buffer.byteLength(text)} bytes`);
  const parsed = parseAgentSkillsBundle(JSON.parse(text));
  assert.ok(parsed.skills.some((s) => s.id === "stick-figure" && s.packs.includes("hermes-stick-figure")));
});

test("TASK.md names the installed skill and its kit for a render task, and only then allows running its tools", () => {
  const md = agentTaskMarkdown({
    jobId: "j",
    payload: { stage: "render", outputs: ["video.mp4"] },
    prompt: "render",
    context: [],
    inputs: [],
    skill: { id: "stick-figure", version: "1.0.0", status: "candidate", dir: "/home/hatch/venstudio/agent-skills/k/skills/stick-figure", kitDir: "/home/hatch/venstudio/agent-skills/k/kit" },
  });
  assert.match(md, /Skill folder: \/home\/hatch\/venstudio\/agent-skills\/k\/skills\/stick-figure/);
  assert.match(md, /Kit folder: \/home\/hatch\/venstudio\/agent-skills\/k\/kit/);
  assert.match(md, /you may run its own tools and its kit's setup\.sh/);
  const plain = agentTaskMarkdown({ jobId: "j", payload: { stage: "script" }, prompt: "x", context: [], inputs: [] });
  assert.doesNotMatch(plain, /Skill folder|you may run its own tools/);
});

test("a render task for a skill this worker does not have fails at once, before anything is written", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-skills-"));
  process.env.VENSTUDIO_AGENT_TASKS = "1";
  t.after(async () => {
    delete process.env.VENSTUDIO_AGENT_TASKS;
    await rm(home, { recursive: true, force: true });
  });
  const id = "dddddddd-4444-4444-8444-000000000001";
  const ctx = {
    job: { id, type: "agent-task", payload: { mode: "hold", prompt: "render", stage: "render", outputs: ["video.mp4"], skill: { id: "stick-figure", version: "9.9.9" } } },
    workDir: path.join(home, "work", id),
    home,
    signal: new AbortController().signal,
    progress: () => {},
  } as unknown as JobContext;
  await assert.rejects(handlers["agent-task"](ctx), /does not have the skill \/stick-figure@9\.9\.9 installed/);
  assert.ok(!existsSync(path.join(home, "inbox", id, "TASK.md")));
  void readFile;
});
