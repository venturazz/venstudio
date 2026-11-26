// Environments and engine command (worker 0.12.0): recipe parsing, safe extraction, argv substitution, downloads, the
// install state machine and capabilities only after a probe. node --test "apps/worker/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ENV_PACKS_KIND,
  EnvInstallError,
  EnvRecipeError,
  RENDERERS,
  RENDER_ENGINES,
  buildCommandProps,
  checkCommandFrames,
  cleanupEnvironments,
  commandEnv,
  commandFramesFfmpegArgs,
  commandTimeoutMs,
  downloadPinned,
  envBackoffMs,
  envCapability,
  envReports,
  installEnvPacks,
  installEnvironment,
  installedEnvPacks,
  missingRequirements,
  neededEnvironments,
  nextEnvToInstall,
  packCapabilitiesFor,
  parseEnvPacksBundle,
  parseEnvironment,
  parsePacksIndex,
  parseRenderSpec,
  parseTar,
  parseZip,
  planExtraction,
  pngSize,
  readyEnvironments,
  recordEnvResult,
  renderDigestOf,
  resolveProgram,
  runFixed,
  substituteArgv,
  withPlaceholderUuids,
  writeExtraction,
  writeEnvState,
  clearEnvProbeCache,
  ENV_PLACEHOLDERS,
  ENV_PROBE_PLACEHOLDERS,
  ENV_PATH_VARS,
  ENV_EXTRACTS,
  ENV_REQUIRE_TOOLS,
  ENV_PROGRAMS,
  type EnvHooks,
  type EnvRecipe,
  type FetchLike,
  type InstalledEnvPack,
  type RequireProbes,
} from "./venstudio-worker.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROOF = path.join(ROOT, "styles", "packs", "low-poly-shapes");
const proofStyle = async () => JSON.parse(await readFile(path.join(PROOF, "style.json"), "utf8")) as Record<string, any>;
const V = (await import(path.join(ROOT, "styles", "tools", "validate.mjs"))) as Record<string, any>;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const tmp = async (t: { after: (f: () => Promise<void>) => void }, name: string) => {
  const d = await mkdtemp(path.join(os.tmpdir(), `vs-${name}-`));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
};

/** A ustar archive from entries (enough of the format for these tests). */
function tar(entries: Array<{ name: string; type?: string; body?: string; link?: string; mode?: number }>): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, "utf8");
    h.write(((e.mode ?? 0o644).toString(8).padStart(7, "0")) + "\0", 100, "ascii");
    h.write("0000000\0", 108, "ascii");
    h.write("0000000\0", 116, "ascii");
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    h.write("00000000000\0", 136, "ascii");
    h.write("        ", 148, "ascii");
    h.write(e.type ?? "0", 156, "ascii");
    if (e.link) h.write(e.link, 157, 100, "utf8");
    h.write("ustar\0", 257, "ascii");
    h.write("00", 263, "ascii");
    let sum = 0;
    for (const x of h) sum += x;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** A zip archive with stored entries; mode carries the unix file type (symlinks). */
function zip(entries: Array<{ name: string; body?: string; mode?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(body.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A small recipe: one tar.gz download with a node script, a probe that runs it. */
function smallRecipe(archive: Buffer, edit: (r: Record<string, any>) => void = () => {}): { raw: Record<string, any>; recipe: EnvRecipe } {
  const raw: Record<string, any> = {
    id: "tiny-tool",
    version: "1.0.0",
    platforms: ["linux-x64", "linux-arm64"],
    hosts: ["github.com", "objects.githubusercontent.com"],
    requires: [{ tool: "node", min: "22.18" }],
    steps: [{ download: { url: "https://github.com/o/r/releases/download/v1/tool.tar.gz", sha256: sha(archive), bytes: archive.length, extract: "tar.gz", stripComponents: 1, to: "lib" } }, { env: { PATH: "lib" } }],
    probe: { argv: ["node", "{envDir}/lib/tool.mjs", "{workDir}"], timeoutSec: 30, exitCode: 0, stdout: "^tool ok" },
    render: { argv: ["node", "{packDir}/render/r.mjs", "{out}"], secondsPerVideoSecond: 5, output: "png-frames", captions: "worker", audio: "worker" },
    licences: [{ tool: "tool", version: "1", licence: "MIT", source: "https://github.com/o/r" }],
  };
  edit(raw);
  return { raw, recipe: parseEnvironment(raw) };
}
const toolArchive = (script = 'console.log("tool ok " + process.argv[2].length)') => zlib.gzipSync(tar([{ name: "tool-1/", type: "5", mode: 0o755 }, { name: "tool-1/tool.mjs", body: script }]));
const serve = (body: Buffer, opts: { status?: number; redirectTo?: string } = {}): FetchLike => async (url) => {
  if (opts.redirectTo && url.startsWith("https://github.com/")) return new Response(null, { status: 302, headers: { location: opts.redirectTo } });
  return new Response(opts.status && opts.status !== 200 ? "nope" : new Uint8Array(body), { status: opts.status ?? 200, headers: { "content-length": String(body.length) } });
};
const okProbes: RequireProbes = { version: () => "99.0.0", glibc: () => "2.39", lib: () => true };
const hooks = (fetch: FetchLike, more: Partial<EnvHooks> = {}): EnvHooks => ({ fetch, probes: okProbes, isRoot: () => false, platform: "linux-x64", freeGb: async () => 100, ...more });

test("the worker's recipe vocabulary is the styles validator's", () => {
  assert.deepEqual([...ENV_PLACEHOLDERS], V.ENV_PLACEHOLDERS);
  assert.deepEqual([...ENV_PROBE_PLACEHOLDERS], V.ENV_PROBE_PLACEHOLDERS);
  assert.deepEqual([...ENV_PATH_VARS], V.ENV_PATH_VARS);
  assert.deepEqual([...ENV_EXTRACTS], V.ENV_EXTRACTS);
  assert.deepEqual([...ENV_REQUIRE_TOOLS], V.ENV_REQUIRE_TOOLS);
  assert.deepEqual([...ENV_PROGRAMS], V.ENV_PROGRAMS);
  assert.equal(RENDER_ENGINES.command, "command");
  assert.equal(RENDERERS.command.capability, "command");
  assert.equal(RENDERERS.command.audio, "shared-mux");
});

test("parseEnvironment reads the proof pack, and refuses what the validator refuses", async () => {
  const s = await proofStyle();
  const r = parseEnvironment(s.environment);
  assert.equal(envCapability(r), "env:three-svg@1.0.0");
  assert.deepEqual(r.steps.map((x) => x.kind), ["download", "npm", "env"]);
  assert.equal(r.render?.output, "png-frames");
  const bad: Array<[string, (e: any) => void]> = [
    ["http", (e) => (e.steps[0].download.url = "http://github.com/x")],
    ["other host", (e) => (e.steps[0].download.url = "https://evil.example.com/x")],
    ["no sha256", (e) => delete e.steps[0].download.sha256],
    ["short sha", (e) => (e.steps[0].download.sha256 = "abc")],
    ["absolute to", (e) => (e.steps[0].download.to = "/usr/local/bin")],
    ["dotdot to", (e) => (e.steps[0].download.to = "../x")],
    ["shell step", (e) => e.steps.push({ shell: "curl | sh" })],
    ["sudo argv", (e) => (e.render.argv = ["sudo", "node", "{out}"])],
    ["bash argv", (e) => (e.probe.argv = ["bash", "-c", "x"])],
    ["unknown placeholder", (e) => (e.render.argv = ["node", "{home}/x", "{out}"])],
    ["props in probe", (e) => (e.probe.argv = ["node", "{props}"])],
    ["system program", (e) => (e.render.argv = ["/usr/bin/python3", "{out}"])],
    ["inline code", (e) => (e.render.argv = ["node", "-e", "x", "{out}"])],
    ["LD_PRELOAD", (e) => (e.steps[2].env.LD_PRELOAD = "x.so")],
    ["no out", (e) => (e.render.argv = ["node", "{packDir}/render/render.mjs"])],
    ["audio renderer", (e) => (e.render.audio = "renderer")],
    ["no licences", (e) => (e.licences = [])],
  ];
  for (const [name, edit] of bad) {
    const env = clone(s.environment);
    edit(env);
    assert.throws(() => parseEnvironment(env), EnvRecipeError, name);
    assert.ok(V.validateEnvironment(env).length > 0, `the validator refuses it too: ${name}`);
  }
  assert.deepEqual(V.validateEnvironment(s.environment), []);
});

test("argv substitution: closed set, values inserted whole, programs resolved without PATH", () => {
  const argv = substituteArgv(["node", "{packDir}/r.mjs", "--size={width}x{height}", "{out}"], { packDir: "/p", width: "1080", height: "1920", out: "/w/a b; rm -rf /" });
  assert.deepEqual(argv, ["node", "/p/r.mjs", "--size=1080x1920", "/w/a b; rm -rf /"], "a value with spaces or ; is one argument, never a shell");
  assert.throws(() => substituteArgv(["{home}"], { home: "/root" }), EnvRecipeError);
  assert.throws(() => substituteArgv(["{props}"], { props: "/x" }, ENV_PROBE_PLACEHOLDERS), EnvRecipeError);
  assert.throws(() => substituteArgv(["{out}"], {}), /has no value/);
  assert.equal(resolveProgram("node", { envDir: "/e", venv: null }), process.execPath);
  assert.equal(resolveProgram("python", { envDir: "/e", venv: "venv" }), "/e/venv/bin/python");
  assert.equal(resolveProgram("{envDir}/bin/resvg", { envDir: "/e", venv: null }), "/e/bin/resvg");
  assert.throws(() => resolveProgram("python", { envDir: "/e", venv: null }), EnvRecipeError);
  assert.throws(() => resolveProgram("{envDir}/../x", { envDir: "/e", venv: null }), EnvRecipeError);
  assert.throws(() => resolveProgram("sh", { envDir: "/e", venv: null }), EnvRecipeError);
});

test("the render and probe environment is minimal: no token, no portal, recipe PATH first, proxies to the blackhole", () => {
  const { recipe } = smallRecipe(toolArchive());
  const env = commandEnv({ recipe, envDir: "/e", home: "/h", tmp: "/t", proxy: "http://127.0.0.1:9", base: { VENSTUDIO_TOKEN: "secret", HOME: "/home/hatch", HTTPS_PROXY: "http://proxy:3128", PATH: "/evil" } });
  assert.equal(env.VENSTUDIO_TOKEN, undefined);
  assert.equal(env.HOME, "/h");
  assert.ok(env.PATH.startsWith("/e/lib:"));
  assert.ok(!env.PATH.includes("/evil"));
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:9");
  const install = commandEnv({ recipe, envDir: "/e", home: "/h", tmp: "/t", network: true, base: { HTTPS_PROXY: "http://proxy:3128", VENSTUDIO_TOKEN: "secret" } });
  assert.equal(install.HTTPS_PROXY, "http://proxy:3128", "the machine's egress proxy only during install");
  assert.equal(install.VENSTUDIO_TOKEN, undefined);
});

test("safe extraction: traversal, absolute paths, hard links and devices are refused before anything is written", () => {
  const plan = (entries: Parameters<typeof tar>[0], strip = 0) => planExtraction(parseTar(tar(entries)), { strip, to: "bin" });
  assert.throws(() => plan([{ name: "../evil", body: "x" }]), /leaves its directory/);
  assert.throws(() => plan([{ name: "ok/../../evil", body: "x" }]), /leaves its directory/);
  assert.throws(() => plan([{ name: "/etc/passwd", body: "x" }]), /absolute path/);
  assert.throws(() => parseTar(tar([{ name: "hard", type: "1", link: "/etc/shadow" }])), /hard link; refused/);
  assert.throws(() => parseTar(tar([{ name: "dev", type: "3" }])), /special file/);
  assert.throws(() => plan([{ name: "a", body: "1" }, { name: "a", body: "2" }]), /written twice/);
  const p = plan([{ name: "pkg/", type: "5" }, { name: "pkg/tool", body: "#!", mode: 0o4777 }], 1);
  assert.deepEqual(p.map((e) => [e.path, e.type, e.mode.toString(8)]), [["bin/tool", "file", "755"]], "setuid and group/other write dropped");
  const bad = tar([{ name: "x", body: "y" }]);
  bad[148] = "9".charCodeAt(0);
  assert.throws(() => parseTar(bad), /checksum/);
});

test("safe extraction: symlinks may not point outside the environment or be written through", async (t) => {
  const plan = (entries: Parameters<typeof tar>[0]) => planExtraction(parseTar(tar(entries)), { strip: 0, to: "bin" });
  assert.throws(() => plan([{ name: "l", type: "2", link: "/etc" }]), /points outside the environment/);
  assert.throws(() => plan([{ name: "l", type: "2", link: "../../../etc" }]), /points outside the environment/);
  assert.throws(() => plan([{ name: "l", type: "2", link: "." }, { name: "l/x", body: "y" }]), /goes through the symlink/);
  assert.throws(() => plan([{ name: "d/x", body: "y" }, { name: "d", type: "2", link: "." }]), /goes through the symlink/);
  const ok = plan([{ name: "real/tool", body: "t" }, { name: "tool", type: "2", link: "real/tool" }, { name: "up", type: "2", link: "../bin/real" }]);
  const dir = await tmp(t, "extract");
  assert.equal(await writeExtraction(dir, ok), 3);
  assert.equal(await readlink(path.join(dir, "bin", "tool")), "real/tool");
  assert.equal(await readFile(path.join(dir, "bin", "tool"), "utf8"), "t");
  // zip: traversal and symlinks out are refused the same way
  assert.throws(() => planExtraction(parseZip(zip([{ name: "../x", body: "y" }])), { strip: 0, to: "." }), /leaves its directory/);
  assert.throws(() => planExtraction(parseZip(zip([{ name: "l", body: "/etc/passwd", mode: 0o120777 }])), { strip: 0, to: "." }), /points outside/);
  const z = planExtraction(parseZip(zip([{ name: "d/", mode: 0o40755 }, { name: "d/a.txt", body: "hello" }])), { strip: 1, to: "share" });
  assert.deepEqual(z.map((e) => e.path), ["share/a.txt"]);
});

test("downloads: sha256 and size must match, https and listed hosts only (redirects too), the cache is checked again", async (t) => {
  const dir = await tmp(t, "dl");
  const body = Buffer.from("the release asset");
  const base = { url: "https://github.com/o/r/releases/download/v1/a.tgz", sha256: sha(body), bytes: body.length, hosts: ["github.com", "objects.githubusercontent.com"], dir, signal: AbortSignal.timeout(10_000) };
  const file = await downloadPinned({ ...base, fetch: serve(body, { redirectTo: "https://objects.githubusercontent.com/a.tgz" }) });
  assert.equal(await readFile(file, "utf8"), "the release asset");
  await assert.rejects(downloadPinned({ ...base, sha256: sha("other"), fetch: serve(body) }), { message: /sha256 mismatch/ });
  await assert.rejects(downloadPinned({ ...base, fetch: serve(body, { redirectTo: "https://evil.example.com/a.tgz" }) }), { message: /evil\.example\.com is not one of the recipe's hosts/ });
  await assert.rejects(downloadPinned({ ...base, fetch: serve(body, { redirectTo: "http://objects.githubusercontent.com/a.tgz" }) }), { message: /https only/ });
  await assert.rejects(downloadPinned({ ...base, bytes: 4, fetch: serve(body) }), { message: /bytes, the recipe says 4|larger than the 4 bytes/ });
  await assert.rejects(downloadPinned({ ...base, fetch: serve(body, { status: 404 }) }), { message: /HTTP 404/ });
  const cache = path.join(dir, "cache");
  await downloadPinned({ ...base, cacheDir: cache, fetch: serve(body) });
  let fetched = 0;
  await downloadPinned({ ...base, cacheDir: cache, fetch: async (u, i) => (fetched++, serve(body)(u, i)) });
  assert.equal(fetched, 0, "a cached file with the right sha256 is reused");
  await writeFile(path.join(cache, sha(body)), "tampered");
  await downloadPinned({ ...base, cacheDir: cache, fetch: async (u, i) => (fetched++, serve(body)(u, i)) });
  assert.equal(fetched, 1, "a cached file whose hash changed is downloaded again");
});

test("requirements are checked, never installed", () => {
  const { recipe } = smallRecipe(toolArchive(), (r) => r.requires.push({ tool: "lib", name: "libcairo.so.2" }, { tool: "glibc", min: "2.35" }, { tool: "python3", min: "3.10" }));
  const probes: RequireProbes = { version: (t) => (t === "python3" ? "3.8.10" : t === "node" ? "24.1.0" : null), glibc: () => "2.31", lib: () => false };
  const missing = missingRequirements(recipe, probes);
  assert.ok(missing.some((m) => /libcairo\.so\.2/.test(m)));
  assert.ok(missing.some((m) => /glibc 2\.35 or later \(this machine has 2\.31\)/.test(m)));
  assert.ok(missing.some((m) => /python3 3\.10 or later \(this machine has 3\.8\.10\)/.test(m)));
  assert.deepEqual(missingRequirements(recipe, okProbes), []);
});

test("install: download, extract, probe, manifest; failures remove the folder and say why", async (t) => {
  const root = await tmp(t, "envs");
  const pack = await tmp(t, "pack");
  const archive = toolArchive();
  const { recipe } = smallRecipe(archive);
  const ok = await installEnvironment({ recipe, packDir: pack, root, signal: AbortSignal.timeout(30_000), hooks: hooks(serve(archive)) });
  assert.ok(ok.ok, JSON.stringify(ok));
  const manifest = JSON.parse(await readFile(path.join(root, "tiny-tool@1.0.0", ".venstudio-env.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.files), ["lib/tool.mjs"]);
  assert.match(manifest.probe, /^tool ok/);

  const fail = async (r: EnvRecipe, h: EnvHooks, re: RegExp) => {
    const got = await installEnvironment({ recipe: r, packDir: pack, root, signal: AbortSignal.timeout(30_000), hooks: h });
    assert.equal(got.ok, false);
    assert.match((got as { reason: string }).reason, re);
    assert.equal(existsSync(path.join(root, `${r.id}@${r.version}`)), false, "nothing half-installed is left");
  };
  await fail(recipe, hooks(serve(archive, { status: 503 })), /HTTP 503/);
  await fail(recipe, hooks(serve(toolArchive("tampered"))), /sha256 mismatch/);
  await fail(smallRecipe(toolArchive("process.exit(3)")).recipe, hooks(serve(toolArchive("process.exit(3)"))), /the probe exited with 3, expected 0/);
  await fail(smallRecipe(toolArchive('console.log("hello")')).recipe, hooks(serve(toolArchive('console.log("hello")'))), /does not match \/\^tool ok\//);
  await fail(recipe, hooks(serve(archive), { isRoot: () => true }), /refused to install as root/);
  await fail(recipe, hooks(serve(archive), { probes: { ...okProbes, version: () => null } }), /lacks node 22\.18 or later/);
  await fail(recipe, hooks(serve(archive), { freeGb: async () => 0.5 }), /not enough disk/);
  await fail(recipe, hooks(serve(archive), { platform: null }), /not one of the recipe's platforms/);
  const evil = zlib.gzipSync(tar([{ name: "../../escape.txt", body: "x" }]));
  await fail(smallRecipe(evil, (r) => (r.steps[0].download.stripComponents = 0)).recipe, hooks(serve(evil)), /leaves its directory/);
  assert.equal(existsSync(path.join(root, "..", "escape.txt")), false);
});

test("install: npm runs ci --omit=dev --ignore-scripts on the pack's lockfile, with an empty npmrc", async (t) => {
  const root = await tmp(t, "envs-npm");
  const pack = await tmp(t, "pack-npm");
  await mkdir(path.join(pack, "env"), { recursive: true });
  const lock = JSON.parse(await readFile(path.join(PROOF, "env", "package-lock.json"), "utf8"));
  await writeFile(path.join(pack, "env", "package-lock.json"), JSON.stringify(lock));
  await writeFile(path.join(pack, "env", "package.json"), await readFile(path.join(PROOF, "env", "package.json")));
  const archive = toolArchive();
  const { recipe } = smallRecipe(archive, (r) => {
    r.hosts.push("registry.npmjs.org");
    r.requires.push({ tool: "npm" });
    r.steps.push({ npm: { lockfile: "env/package-lock.json", to: "node" } });
  });
  const calls: string[][] = [];
  const run: EnvHooks["run"] = async (argv, o) => {
    if (argv[1] === "ci") {
      calls.push([...argv, `cwd=${path.relative(root, o.cwd)}`, `rc=${o.env.npm_config_userconfig ? "set" : "none"}`]);
      return { code: 0, signal: null, timedOut: false, output: "" };
    }
    return runFixed(argv, o);
  };
  const ok = await installEnvironment({ recipe, packDir: pack, root, signal: AbortSignal.timeout(30_000), hooks: hooks(serve(archive), { run }) });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(calls[0].slice(1), ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "cwd=tiny-tool@1.0.0/node", "rc=set"]);
  lock.packages["node_modules/three"].resolved = "https://npm.evil.example/three.tgz";
  await writeFile(path.join(pack, "env", "package-lock.json"), JSON.stringify(lock));
  const bad = await installEnvironment({ recipe, packDir: pack, root, signal: AbortSignal.timeout(30_000), hooks: hooks(serve(archive), { run }) });
  assert.match((bad as { reason: string }).reason, /does not come from an https host of the recipe/);
});

test("state machine: failures back off and retry, a changed recipe starts over, success resets", () => {
  const { recipe } = smallRecipe(toolArchive());
  const needed = [{ recipe }];
  assert.equal(nextEnvToInstall(needed, {}, 0, "linux-x64"), recipe, "not installed yet: due");
  assert.equal(nextEnvToInstall(needed, {}, 0, "linux-arm64")?.id, "tiny-tool");
  let s = recordEnvResult({}, recipe, { ok: false, reason: "HTTP 503" }, 1000);
  assert.equal(s["tiny-tool@1.0.0"].attempts, 1);
  assert.equal(nextEnvToInstall(needed, s, 1000 + envBackoffMs(1) - 1, "linux-x64"), null, "waits for its backoff");
  assert.equal(nextEnvToInstall(needed, s, 1000 + envBackoffMs(1), "linux-x64"), recipe);
  s = recordEnvResult(s, recipe, { ok: false, reason: "again" }, 2000);
  assert.equal(s["tiny-tool@1.0.0"].attempts, 2);
  assert.equal(envBackoffMs(2), 2 * envBackoffMs(1));
  assert.equal(envBackoffMs(50), 6 * 3600_000, "capped at 6 h");
  s = recordEnvResult(s, recipe, { ok: true }, 3000);
  assert.deepEqual([s["tiny-tool@1.0.0"].status, s["tiny-tool@1.0.0"].attempts], ["ready", 0]);
  assert.equal(nextEnvToInstall(needed, s, 4000, "linux-x64"), null, "ready: nothing to do");
  const changed = smallRecipe(toolArchive(), (r) => (r.probe.timeoutSec = 31)).recipe;
  assert.equal(nextEnvToInstall([{ recipe: changed }], s, 4000, "linux-x64"), changed, "same id@version, different recipe: installs again");
  assert.equal(nextEnvToInstall(needed, { ...s, "tiny-tool@1.0.0": { ...s["tiny-tool@1.0.0"], status: "installing" } }, 4000, "linux-x64"), recipe, "an install a restart cut short starts again");
  assert.equal(nextEnvToInstall(needed, {}, 0, null), null, "no recipe runs on an unknown platform");
  const pack: InstalledEnvPack = { id: "p", version: "0.1.0", engine: "command", dir: "/p", recipe };
  const reports = envReports([{ recipe, packs: [pack] }], recordEnvResult({}, recipe, { ok: false, reason: "sha256 mismatch" }, 5000), "linux-x64");
  assert.deepEqual([reports[0].status, reports[0].detail, reports[0].packs], ["failed", "sha256 mismatch", ["p@0.1.0"]]);
  assert.equal(envReports([{ recipe, packs: [pack] }], {}, "linux-x64")[0].status, "installing");
});

/** A worker home with one installed env pack (its files in the signed bundle format). */
async function homeWithPack(home: string, recipeRaw: Record<string, any>, version = "0.1.0", id = "tiny-pack") {
  const files = [
    { path: "style.json", text: JSON.stringify({ id, version, renderer: { engine: "command" }, environment: recipeRaw }) },
    { path: "render/r.mjs", text: "console.log('r')" },
  ];
  const digest = renderDigestOf(Object.fromEntries(files.map((f) => [f.path, sha(f.text)])));
  const bundle = { format: 1, kind: ENV_PACKS_KIND, commit: "c".repeat(40), packs: [{ id, version, sha256: digest, files }] };
  await installEnvPacks(home, Buffer.from(JSON.stringify(bundle)));
  return { digest, bundle };
}

test("the env packs bundle: digests checked, unsafe paths refused, removed packs deleted", async (t) => {
  const home = await tmp(t, "home");
  const { raw } = smallRecipe(toolArchive());
  const { bundle } = await homeWithPack(home, raw);
  const { packs } = await installedEnvPacks(home);
  assert.deepEqual(packs.map((p) => `${p.id}@${p.version}:${p.engine}`), ["tiny-pack@0.1.0:command"]);
  const tampered = clone(bundle);
  tampered.packs[0].files[1].text = "console.log('changed')";
  assert.throws(() => parseEnvPacksBundle(tampered), /do not match its digest/);
  const traversal = clone(bundle);
  traversal.packs[0].files[1].path = "../../evil.mjs";
  assert.throws(() => parseEnvPacksBundle(traversal), /unsafe or repeated file/);
  await writeFile(path.join(home, "packs", "tiny-pack@0.1.0", "render", "r.mjs"), "edited on disk");
  assert.deepEqual((await installedEnvPacks(home)).packs, [], "a pack whose files changed on disk is not used");
  await installEnvPacks(home, Buffer.from(JSON.stringify({ ...bundle, packs: [] })));
  assert.equal(existsSync(path.join(home, "packs", "tiny-pack@0.1.0")), false);
});

test("capabilities only after the probe passed: env: and pack: need a ready state, the manifest and a passing probe", async (t) => {
  clearEnvProbeCache();
  const home = await tmp(t, "home-caps");
  const archive = toolArchive();
  const { raw, recipe } = smallRecipe(archive);
  await homeWithPack(home, raw);
  const { packs } = await installedEnvPacks(home);
  const index = parsePacksIndex({ format: 1, commit: null, packs: [{ id: "tiny-pack", version: "0.1.0", status: "draft", engine: "command", minWorkerVersion: "0.12.0", composition: null, sha256: "a".repeat(64), environment: "tiny-tool@1.0.0" }] });
  const caps = ["ffmpeg", "command"];
  assert.deepEqual(packCapabilitiesFor(index, caps, [], "0.12.0", [], []), [], "no environment yet: no pack");
  assert.deepEqual(packCapabilitiesFor(index, ["ffmpeg"], [], "0.12.0", [], ["tiny-pack@0.1.0"]), [], "no command renderer: no pack");
  assert.deepEqual(packCapabilitiesFor(index, caps, [], "0.11.0", [], ["tiny-pack@0.1.0"]), [], "an older worker never reports it");
  assert.deepEqual(packCapabilitiesFor(index, caps, [], "0.12.0", [], ["tiny-pack@0.1.0"]), ["pack:tiny-pack@0.1.0"]);
  // A ready state alone is not enough: the install's manifest must exist and the probe must pass again.
  const ready = recordEnvResult({}, recipe, { ok: true }, Date.now());
  assert.deepEqual([...(await readyEnvironments(home, packs, ready))], []);
  const r = await installEnvironment({ recipe, packDir: packs[0].dir, root: path.join(home, "envs"), signal: AbortSignal.timeout(30_000), hooks: hooks(serve(archive)) });
  assert.ok(r.ok);
  assert.deepEqual([...(await readyEnvironments(home, packs, {}))], [], "installed but never recorded as ready");
  await writeEnvState(home, ready);
  assert.deepEqual([...(await readyEnvironments(home, packs, ready))], ["tiny-tool@1.0.0"]);
  clearEnvProbeCache();
  await writeFile(path.join(home, "envs", "tiny-tool@1.0.0", "lib", "tool.mjs"), "process.exit(1)");
  assert.deepEqual([...(await readyEnvironments(home, packs, ready))], [], "a probe that fails now withdraws the capability");
});

test("cleanup: an older environment version goes once a newer one is ready and no pack uses it", async (t) => {
  const home = await tmp(t, "home-clean");
  const { recipe: v1 } = smallRecipe(toolArchive());
  const { raw: raw2, recipe: v2 } = smallRecipe(toolArchive(), (r) => (r.version = "1.1.0"));
  await homeWithPack(home, raw2, "0.2.0");
  const { packs } = await installedEnvPacks(home);
  for (const k of ["tiny-tool@1.0.0", "tiny-tool@1.1.0", "other@2.0.0"]) await mkdir(path.join(home, "envs", k), { recursive: true });
  const installing = recordEnvResult({}, v2, { ok: false, reason: "x" }, 0);
  assert.deepEqual(await cleanupEnvironments(home, packs, installing), ["other@2.0.0"], "the old version stays until the new one is ready");
  const state = recordEnvResult(recordEnvResult({}, v1, { ok: true }, 0), v2, { ok: true }, 1);
  assert.deepEqual(await cleanupEnvironments(home, packs, state), ["tiny-tool@1.0.0"]);
  assert.ok(existsSync(path.join(home, "envs", "tiny-tool@1.1.0")));
  assert.deepEqual(neededEnvironments(packs).map((n) => n.recipe.version), ["1.1.0"]);
});

test("command render props, frame checks and the encode", async (t) => {
  const payload = withPlaceholderUuids(JSON.parse(await readFile(path.join(PROOF, "fixtures", "payload.json"), "utf8")));
  const spec = parseRenderSpec(payload);
  assert.equal(spec.engine, "command");
  const props = buildCommandProps(spec, { images: spec.shots.map((s) => `${s.assetId}.png`), font: null, drawsCaptions: false });
  assert.equal(props.kind, "command");
  assert.equal(props.totalFrames, 360);
  assert.deepEqual(props.scenes.map((s) => [s.start, s.startFrame, s.frames]), [[0, 0, 120], [4, 120, 120], [8, 240, 120]]);
  assert.deepEqual(props.captions, [], "the worker burns the captions");
  assert.equal(commandTimeoutMs({ secondsPerVideoSecond: 30 }, 12), 360_000);
  assert.equal(commandTimeoutMs({ secondsPerVideoSecond: 1 }, 2), 60_000, "at least a minute");
  const args = commandFramesFfmpegArgs({ dir: "/f", fps: 30, frames: 360, output: "/o.mp4", burn: "drawtext=x" });
  assert.deepEqual(args.slice(args.indexOf("-framerate"), args.indexOf("-framerate") + 8), ["-framerate", "30", "-start_number", "0", "-i", "/f/%06d.png", "-frames:v", "360"]);
  assert.equal(args[args.indexOf("-vf") + 1], "drawtext=x,format=yuv420p");
  assert.ok(args.includes("-an"));
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(0x0d0a1a0a, 4);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  assert.deepEqual(pngSize(png(4, 6)), { width: 4, height: 6 });
  assert.equal(pngSize(Buffer.from("GIF89a")), null);
  const dir = await tmp(t, "frames");
  for (let f = 0; f < 3; f++) await writeFile(path.join(dir, `${String(f).padStart(6, "0")}.png`), png(4, 6));
  await checkCommandFrames(dir, { frames: 3, width: 4, height: 6 });
  await assert.rejects(checkCommandFrames(dir, { frames: 4, width: 4, height: 6 }), { message: /wrote 3 frames, the job has 4/ });
  await assert.rejects(checkCommandFrames(dir, { frames: 3, width: 8, height: 6 }), { message: /is 4x6, the job is 8x6/ });
  await writeFile(path.join(dir, "notes.txt"), "x");
  await assert.rejects(checkCommandFrames(dir, { frames: 3, width: 4, height: 6 }), { message: /files that are not frames/ });
});

test("runFixed: no shell, a timeout stops the whole process group, output is bounded", async () => {
  const r = await runFixed([process.execPath, "-e", "console.log('a; echo b')"], { cwd: os.tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
  assert.equal(r.code, 0);
  assert.equal(r.output.trim(), "a; echo b");
  const slow = await runFixed([process.execPath, "-e", "setTimeout(()=>{}, 60000)"], { cwd: os.tmpdir(), env: {}, timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  const big = await runFixed([process.execPath, "-e", "process.stdout.write('x'.repeat(200000))"], { cwd: os.tmpdir(), env: {}, timeoutMs: 10_000 });
  assert.equal(big.output.length, 64 * 1024);
});

// CI only (network, npm, ffmpeg): installs the proof pack's environment from its recipe and renders its fixture,
// exactly as venstudio-styles CI and a Muse worker do. VENSTUDIO_ENV_E2E=1 turns it on; =required fails instead of skipping.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const e2e = process.env.VENSTUDIO_ENV_E2E;
const e2eSkip = !e2e ? "VENSTUDIO_ENV_E2E is not set (CI only: needs the network, npm and ffmpeg)" : !hasFfmpeg ? "ffmpeg is not installed" : false;
if (e2e === "required" && e2eSkip) throw new Error(`the environment e2e test is required: ${e2eSkip}`);
test("the proof pack's environment installs from its recipe and renders its fixture", { skip: e2eSkip, timeout: 900_000 }, async (t) => {
  const { envInstallCli, renderCommandFixture } = await import("./venstudio-worker.ts");
  const envs = await tmp(t, "proof-envs");
  const out = path.join(envs, "low-poly-shapes.mp4");
  const installed = await envInstallCli({ pack: PROOF, envs });
  assert.equal(installed.environment, "env:three-svg@1.0.0");
  assert.match(String(installed.probe), /^ok three r183 resvg 0\.44\.0/);
  const r = await renderCommandFixture({ pack: PROOF, out, envs });
  assert.equal(r.frames, 360);
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames", "-of", "csv=p=0", out], { encoding: "utf8" });
  assert.equal(probe.stdout.trim(), "1080,1920,360");
});

test("symlink chains that escape through the kernel, and writes through an earlier step's symlink, are refused", async (t) => {
  const { assertLinksInside, assertNoSymlinkOnPath } = await import("./venstudio-worker.ts");
  // Each target looks harmless on its own; together they point two levels up.
  const chain = planExtraction(parseTar(tar([{ name: "b", type: "2", link: "." }, { name: "tools", type: "2", link: "b/b/../.." }])), { strip: 0, to: "." });
  const dir = await tmp(t, "chain");
  const env = path.join(dir, "env");
  await mkdir(env);
  await assert.rejects(writeExtraction(env, chain), { message: /resolves outside the environment/ });
  // A second step that writes into a folder an earlier step made a symlink.
  const env2 = path.join(dir, "env2");
  await mkdir(env2);
  await writeExtraction(env2, planExtraction(parseTar(tar([{ name: "real/", type: "5" }, { name: "lib2", type: "2", link: "real" }])), { strip: 0, to: "." }));
  await assert.rejects(writeExtraction(env2, planExtraction(parseTar(tar([{ name: "x.txt", body: "y" }])), { strip: 0, to: "lib2/x" })), { message: /through the symlink lib2/ });
  await assert.rejects(assertNoSymlinkOnPath(env2, "lib2/node"), { message: /through the symlink lib2/ });
  await assertNoSymlinkOnPath(env2, "real/new/deeper");
  assert.equal(await assertLinksInside(env2), 1);
  // Through installEnvironment: the recipe's second download unpacks into the first one's symlink.
  const root = await tmp(t, "envs-chain");
  const pack = await tmp(t, "pack-chain");
  const a1 = zlib.gzipSync(tar([{ name: "real/", type: "5" }, { name: "lib2", type: "2", link: "real" }]));
  const a2 = zlib.gzipSync(tar([{ name: "tool.mjs", body: 'console.log("tool ok")' }]));
  const { recipe } = smallRecipe(a1, (r) => {
    r.steps[0].download.stripComponents = 0;
    r.steps[0].download.to = ".";
    r.steps.splice(1, 0, { download: { url: "https://github.com/o/r/releases/download/v1/b.tar.gz", sha256: sha(a2), bytes: a2.length, extract: "tar.gz", to: "lib2/sub" } });
  });
  const fetch: FetchLike = async (url, init) => serve(url.endsWith("b.tar.gz") ? a2 : a1)(url, init);
  const got = await installEnvironment({ recipe, packDir: pack, root, signal: AbortSignal.timeout(30_000), hooks: hooks(fetch) });
  assert.match((got as { reason: string }).reason, /through the symlink lib2/);
});

test("a stalled download stops when its signal does", async (t) => {
  const dir = await tmp(t, "stall");
  const stalled: FetchLike = (_u, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted by the deadline")), { once: true }));
  const deadline = new AbortController();
  setTimeout(() => deadline.abort(), 200); // a ref'd timer, as the worker's loop keeps the process alive
  await assert.rejects(downloadPinned({ url: "https://github.com/o/r/a", sha256: sha("x"), bytes: 1, hosts: ["github.com"], dir, signal: deadline.signal, fetch: stalled }), { message: /aborted by the deadline/ });
});

test("a crash mid-install backs off; a stop on purpose does not; a ready environment that stopped working installs again", async () => {
  const { startEnvAttempt, stopEnvAttempt } = await import("./venstudio-worker.ts");
  const { recipe } = smallRecipe(toolArchive());
  const k = "tiny-tool@1.0.0";
  const started = startEnvAttempt({}, recipe, 1000);
  assert.deepEqual([started[k].status, started[k].attempts, started[k].nextAttemptAt], ["installing", 1, 1000 + envBackoffMs(1)]);
  assert.equal(nextEnvToInstall([{ recipe }], started, 1001, "linux-x64"), null, "after a crash the next process waits for the backoff");
  assert.equal(nextEnvToInstall([{ recipe }], started, 1000 + envBackoffMs(1), "linux-x64"), recipe);
  const again = startEnvAttempt(started, recipe, 2000);
  assert.equal(again[k].attempts, 2, "each start counts");
  const failed = recordEnvResult(again, recipe, { ok: false, reason: "x" }, 3000);
  assert.deepEqual([failed[k].status, failed[k].attempts], ["failed", 2], "the failure of a counted start is not counted twice");
  const stopped = stopEnvAttempt(again, recipe, 3000);
  assert.deepEqual([stopped[k].status, stopped[k].attempts, stopped[k].nextAttemptAt], ["failed", 1, 0]);
  assert.equal(nextEnvToInstall([{ recipe }], stopped, 3001, "linux-x64"), recipe, "a stop on purpose starts again at once");
  const ready = recordEnvResult(again, recipe, { ok: true }, 4000);
  assert.equal(nextEnvToInstall([{ recipe }], ready, 5000, "linux-x64", new Set([k])), null);
  assert.equal(nextEnvToInstall([{ recipe }], ready, 5000, "linux-x64", new Set()), recipe, "ready but not usable: installs again");
  const pack: InstalledEnvPack = { id: "p", version: "0.1.0", engine: "command", dir: "/p", recipe };
  assert.equal(envReports([{ recipe, packs: [pack] }], ready, "linux-x64", new Set())[0].status, "failed", "never reported ready while unusable");
  assert.equal(envReports([{ recipe, packs: [pack] }], ready, "linux-x64", new Set([k]))[0].status, "ready");
  assert.equal(startEnvAttempt(ready, recipe, 6000)[k].attempts, 1, "a reinstall after ready starts its count again");
});

test("a failed re-probe is not cached: once the environment works again it is reported again", async (t) => {
  clearEnvProbeCache();
  const home = await tmp(t, "home-reprobe");
  const archive = toolArchive();
  const { raw, recipe } = smallRecipe(archive);
  await homeWithPack(home, raw);
  const { packs } = await installedEnvPacks(home);
  assert.ok((await installEnvironment({ recipe, packDir: packs[0].dir, root: path.join(home, "envs"), signal: AbortSignal.timeout(30_000), hooks: hooks(serve(archive)) })).ok);
  const ready = recordEnvResult({}, recipe, { ok: true }, Date.now());
  const tool = path.join(home, "envs", "tiny-tool@1.0.0", "lib", "tool.mjs");
  const good = await readFile(tool, "utf8");
  await writeFile(tool, "process.exit(1)");
  assert.deepEqual([...(await readyEnvironments(home, packs, ready))], []);
  await writeFile(tool, good);
  assert.deepEqual([...(await readyEnvironments(home, packs, ready))], ["tiny-tool@1.0.0"]);
});
