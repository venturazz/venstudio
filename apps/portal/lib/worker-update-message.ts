/**
 * The manual update of an enrolled worker: the fallback, and the one-time bootstrap that turns on signed automatic
 * updates for workers older than 0.8.0. Pure.
 *
 * For a Muse VM it is a message the owner sends as their own, with every command spelled out and the expected sha256,
 * because a Muse agent rightly refuses to run an installer it cannot check. After this run the worker verifies every
 * update itself (Ed25519 signature by the key pinned here, plus each file's sha256), so the agent is not asked to run
 * installers again. For a VPS or the owner's own computer it is the command line to run there.
 */
export function manualUpdateMessage(input: {
  portalUrl: string;
  installSha256: string;
  withRemotion: boolean;
  /** workers.host: "muse", "vps" or "local". Default "muse". */
  host?: string;
  /** workers.mode, so run.sh keeps the schedule it has. Default: hold on Muse, daemon elsewhere. */
  mode?: string | null;
  /**
   * Capabilities this worker should have and does not (remotion-2d, env:<id>). Named in the message so the same command
   * repairs a worker instead of only updating it — a worker without the renderer can never gain it from an update that
   * leaves --with-remotion out.
   */
  missing?: readonly string[];
}): string {
  const url = input.portalUrl.replace(/\/+$/, "");
  const muse = (input.host ?? "muse") === "muse";
  const mode = input.mode === "hold" || input.mode === "tick" || input.mode === "daemon" ? input.mode : muse ? "hold" : "daemon";
  const flags = `--portal ${url} --mode ${mode}${input.withRemotion ? " --with-remotion" : ""}`;
  // The script installs Chromium's system libraries as root and then continues as an ordinary account, so sudo is part
  // of the command rather than something to remember.
  const run = `sudo bash install.sh ${flags}`;
  const missing = (input.missing ?? []).filter(Boolean);
  const lacks = missing.length > 0 ? ` This worker is missing ${missing.join(", ")}.` : "";
  if (!muse) {
    return [
      `On that machine, in the worker's directory (~/.venstudio unless it was installed with --home), run:`,
      ``,
      `cd ~/.venstudio`,
      `curl -fsSL ${url}/install/install.sh -o install.sh`,
      `sha256sum install.sh`,
      run,
      ``,
      `Run the last line only if sha256sum prints ${input.installSha256}. It installs the Chromium system libraries as ` +
        `root and then continues as the account that owns the worker directory, so environments can install there.${lacks} ` +
        `The enrollment is kept and the update key is ` +
        `pinned; after this the worker updates itself with signed releases.` +
        (mode === "daemon" ? ` Restart the daemon afterwards so it runs the new file.` : ""),
    ].join("\n");
  }
  const home = "/home/hatch/venstudio";
  return [
    `I'm updating the render worker for my own video production portal (${url}) on this VM. It is already installed in ${home}; ` +
      `this keeps its enrollment and replaces the worker program. Please run these commands and show me the output:`,
    ``,
    `cd ${home}`,
    `curl -fsSL ${url}/install/install.sh -o install.sh`,
    `sha256sum install.sh`,
    run,
    ``,
    `The sha256 should be ${input.installSha256}. If it's different, stop and tell me and run nothing.` +
      ` It runs as root on purpose: it installs the system libraries headless Chromium needs, hands ${home} to an ` +
      `ordinary account and continues as that account, because environments refuse to install as root.` +
      (input.withRemotion ? ` The Remotion renderer is refreshed too (a few minutes).` : "") +
      lacks,
    ``,
    `This is the last time I'll ask you to run an installer for it. The script pins my portal's update signing key in ` +
      `${home}/config.json. From now on the worker updates itself between jobs: it installs only files signed by that key, ` +
      `checks each file's sha256 before using it, tests the new version before switching, and switches back by itself if ` +
      `the new version fails. Nothing new needs your approval; the hourly "VenStudio worker" scheduled task stays as it is.`,
    ``,
    `When done, show me the last 5 lines of ${home}/logs/worker.log.`,
  ].join("\n");
}
