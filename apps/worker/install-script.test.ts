import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * The installer's privilege hand-off, exercised without root: id, useradd, getent, chown and runuser are stubbed, and the
 * portal serves a marker script. What is asserted is the hand-off itself — the account is created, the worker directory
 * is given to it, and the rest of the install runs as that account with the same flags. That hand-off is the reason a
 * worker reports env:* capabilities at all: environments refuse to install as root.
 */

const SCRIPT = readFileSync(path.join(import.meta.dirname, "install.sh"), "utf8");
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sandbox(opts: { noUser?: boolean; owner?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "vs-install-"));
  dirs.push(root);
  const stubs = path.join(root, "stubs");
  const asUser = path.join(root, "stubs-as-user");
  mkdirSync(stubs, { recursive: true });
  mkdirSync(asUser, { recursive: true });
  const actions = path.join(root, "actions.log");
  writeFileSync(actions, "");

  const stub = (dir: string, name: string, body: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, "#!/bin/sh\n" + body);
    chmodSync(file, 0o755);
  };
  // stubs/: this process is root. -u vstest: the account exists.
  // -u with no argument: this process is root. -u vstest: exists unless STUB_NO_USER is set, so the install creates it.
  stub(stubs, "id", 'if [ "$1" = "-u" ]; then\n  if [ -n "${2:-}" ]; then [ -n "${STUB_NO_USER:-}" ] && exit 1; exit 0; fi\n  echo 0; exit 0\nfi\necho root\n');
  stub(stubs, "getent", 'echo "vstest:x:4242:4242::${VSHOME}:/bin/bash"\n');
  stub(stubs, "useradd", 'echo "useradd $*" >> "$ACTIONS"\n');
  stub(stubs, "chown", 'echo "chown $*" >> "$ACTIONS"\n');
  stub(stubs, "npx", "exit 0\n");
  stub(stubs, "stat", 'if [ "$1" = "-c" ] && [ "$2" = "%U" ]; then echo "${STUB_OWNER:-root}"; exit 0; fi\nexec /usr/bin/stat "$@"\n');
  // The hand-off itself: log it, then run the command with a PATH whose id reports an ordinary account, so a script that
  // hands off again would loop here instead of passing silently.
  stub(
    stubs,
    "runuser",
    'echo "runuser $*" >> "$ACTIONS"\n[ "$1" = "-u" ] || exit 9\nshift 2\n[ "${1:-}" = "--" ] && shift\nexec env PATH="$NONROOT:$PATH" "$@"\n',
  );
  stub(asUser, "id", 'if [ "$1" = "-u" ]; then echo 1000; exit 0; fi\necho vstest\n');
  stub(asUser, "getent", 'echo "vstest:x:4242:4242::${VSHOME}:/bin/bash"\n');

  const marker = path.join(root, "marker.sh");
  writeFileSync(marker, '#!/bin/bash\nprintf "MARKER %s\\n" "$*"\nprintf "MARKER service-user=%s\\n" "${VENSTUDIO_SERVICE_USER:-unset}"\nprintf "MARKER home=%s\\n" "$HOME"\n');
  const server = createServer((req, res) => {
    if (req.url !== "/install/install.sh") {
      res.writeHead(404).end();
      return;
    }
    const body = readFileSync(marker);
    res.writeHead(200, { "content-type": "text/plain", "content-length": String(body.length) }).end(body);
  });

  const home = path.join(root, "vshome");
  const env = {
    ...process.env,
    PATH: `${stubs}:${process.env.PATH ?? ""}`,
    ACTIONS: actions,
    NONROOT: asUser,
    VSHOME: home,
    ...(opts.noUser ? { STUB_NO_USER: "1" } : {}),
    ...(opts.owner ? { STUB_OWNER: opts.owner } : {}),
  };
  return {
    root,
    stubs,
    actions,
    nonroot: asUser,
    env,
    home,
    async install(args: string[]) {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as AddressInfo;
      try {
        const r = await exec(
          "bash",
          [path.join(root, "install.sh"), "--portal", `http://127.0.0.1:${port}`, "--home", home, ...args],
          { env, encoding: "utf8" },
        );
        return { stdout: r.stdout, stderr: r.stderr, actions: readFileSync(actions, "utf8") };
      } finally {
        server.close();
      }
    },
  };
}

test("started as root: creates the account, hands over the worker directory and continues as it", async () => {
  const box = sandbox({ noUser: true });
  writeFileSync(path.join(box.root, "install.sh"), SCRIPT);
  const r = await box.install(["--user", "vstest", "--with-remotion", "--mode", "tick", "--code", "C1", "--name", "T1"]);
  assert.match(r.stdout, /continuing as vstest/);
  assert.match(r.stdout, /chromium system libraries: installed/);
  // the account, then both the worker directory and the fetched copy of the script
  assert.match(r.actions, /useradd -m -s \/bin\/bash vstest/);
  assert.match(r.actions, new RegExp(`chown -R vstest: ${box.home}`));
  // the fetched copy of the script is handed over too, so the account can run it
  assert.equal((r.actions.match(/chown -R vstest:/g) ?? []).length, 2, r.actions);
  // the rest of the install ran as the account, with every flag carried over
  assert.match(r.actions, /runuser -u vstest -- env HOME=.* VENSTUDIO_SERVICE_USER=vstest bash .*install\.sh /);
  assert.match(r.stdout, /MARKER .*--with-remotion/);
  assert.match(r.stdout, /MARKER .*--code C1/);
  assert.match(r.stdout, /MARKER .*--mode tick/);
  assert.match(r.stdout, /MARKER service-user=vstest/);
  assert.match(r.stdout, new RegExp(`MARKER home=${box.home}`));
});

test("started as root on an existing directory: keeps the account that already owns it", async () => {
  const box = sandbox({ owner: "hatch" });
  writeFileSync(path.join(box.root, "install.sh"), SCRIPT);
  mkdirSync(box.home, { recursive: true });
  const r = await box.install(["--with-remotion", "--mode", "hold", "--code", "C2"]);
  assert.match(r.stdout, /continuing as hatch/);
  assert.doesNotMatch(r.actions, /useradd/, "an existing install must not get a second account");
  assert.match(r.actions, /chown -R hatch: /);
  assert.match(r.actions, /runuser -u hatch -- env HOME=/);
  assert.match(r.stdout, /MARKER service-user=hatch/);
});

test("--no-provision reaches the worker through the generated run.sh", () => {
  assert.match(SCRIPT, /--no-provision\) NO_PROVISION=1/);
  assert.match(SCRIPT, /export VENSTUDIO_NO_PROVISION="\$\{NO_PROVISION\}"/);
  assert.match(SCRIPT, /\[ "\$NO_PROVISION" = 1 \] && _args\+=\(--no-provision\)/, "a root hand-off keeps the flag");
});

test("the generated run.sh hands a root start off to the service account", () => {
  const box = sandbox();
  const start = SCRIPT.indexOf('cat > "$HOME_DIR/run.sh" <<EOF\n') + 'cat > "$HOME_DIR/run.sh" <<EOF\n'.length;
  const end = SCRIPT.indexOf("\nEOF\n", start);
  assert.ok(start > 0 && end > start, "run.sh heredoc not found");
  const body = SCRIPT.slice(start, end)
    .replaceAll("$HOME_DIR", box.home)
    .replaceAll("$NODE_BIN", path.join(box.home, "bin", "node"))
    .replaceAll("$FFMPEG_BIN", path.join(box.home, "bin", "ffmpeg"))
    .replaceAll("$MODE", "hold")
    .replaceAll("$SERVICE_USER", "vstest")
    .replaceAll("${NO_PROVISION}", "0")
    .replaceAll("\\$", "$");

  mkdirSync(path.join(box.home, "logs"), { recursive: true });
  mkdirSync(path.join(box.home, "bin"), { recursive: true });
  writeFileSync(path.join(box.home, "bin", "node"), '#!/bin/sh\necho NODE-RAN "$@"\n');
  chmodSync(path.join(box.home, "bin", "node"), 0o755);
  const runsh = path.join(box.home, "run.sh");
  writeFileSync(runsh, body);

  assert.equal(spawnSync("bash", ["-n", runsh], { encoding: "utf8" }).status, 0, "generated run.sh must parse");
  const r = spawnSync("bash", [runsh, "hold"], { env: box.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const actions = readFileSync(box.actions, "utf8");
  assert.match(actions, /runuser -u vstest -- env HOME=/);
  assert.match(actions, new RegExp(`bash ${box.home}/run\\.sh hold`));
  // the hand-off happened once, and the worker then ran as the account (run.sh sends its output to the log)
  assert.equal((actions.match(/runuser -u/g) ?? []).length, 1, actions);
  assert.match(readFileSync(path.join(box.home, "logs", "worker.log"), "utf8"), /NODE-RAN .*venstudio-worker\.ts hold/);
});