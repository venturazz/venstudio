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
}): string {
  const url = input.portalUrl.replace(/\/+$/, "");
  const muse = (input.host ?? "muse") === "muse";
  const mode = input.mode === "hold" || input.mode === "tick" || input.mode === "daemon" ? input.mode : muse ? "hold" : "daemon";
  const flags = `--portal ${url} --mode ${mode}${input.withRemotion ? " --with-remotion" : ""}`;
  if (!muse) {
    return [
      `On that machine, in the worker's directory (~/.venstudio unless it was installed with --home), run:`,
      ``,
      `cd ~/.venstudio`,
      `curl -fsSL ${url}/install/install.sh -o install.sh`,
      `sha256sum install.sh`,
      `bash install.sh ${flags}`,
      ``,
      `Run the last line only if sha256sum prints ${input.installSha256}. The enrollment is kept and the update key is ` +
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
    `bash install.sh ${flags}`,
    ``,
    `The sha256 should be ${input.installSha256}. If it's different, stop and tell me and run nothing.` +
      (input.withRemotion ? ` It also refreshes the Remotion renderer (a few minutes).` : ""),
    ``,
    `This is the last time I'll ask you to run an installer for it. The script pins my portal's update signing key in ` +
      `${home}/config.json. From now on the worker updates itself between jobs: it installs only files signed by that key, ` +
      `checks each file's sha256 before using it, tests the new version before switching, and switches back by itself if ` +
      `the new version fails. Nothing new needs your approval; the hourly "VenStudio worker" scheduled task stays as it is.`,
    ``,
    `When done, show me the last 5 lines of ${home}/logs/worker.log.`,
  ].join("\n");
}
