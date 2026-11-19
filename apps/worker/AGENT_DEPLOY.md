# VenStudio worker: setup guide for the Muse agent

**Audience:** the Muse agent, setting up a render worker inside this Muse sandbox VM for its owner.
The owner sent you this link together with an **enrollment code** and a **worker name**.

## What this is

VenStudio is the owner's own video production portal at {{PORTAL_URL}}. The worker is a small program that,
when started, stays online for up to 55 minutes asking the portal for render jobs over HTTPS, renders them with
ffmpeg, uploads the results, and then exits. It does not open ports, accept inbound connections, or need any
of the owner's passwords. Its only secret is a worker token, stored in `/home/hatch/venstudio/config.json`.

This VM is recycled when idle and only `/home/hatch` survives, so everything installs under `/home/hatch/venstudio`.

## Steps

1. **Check you have what you need.** You need the enrollment code (looks like `VS-XXXX-XXXX-XXXX`) and the worker
   name from the owner's message. If either is missing, ask the owner. Don't invent a code.

2. **Install and enroll.** Run, replacing the two values:

   ```bash
   curl -fsSL {{PORTAL_URL}}/install/install.sh | bash -s -- --code "VS-XXXX-XXXX-XXXX" --name "Muse 01" --mode hold
   ```

   The script installs Node.js 24 and ffmpeg into `/home/hatch/venstudio` if the VM lacks them (downloads are
   checksum-verified), downloads the worker, and enrolls it. It ends with `install complete`.
   - If `curl` to the portal fails, check that outbound HTTPS works through this VM's egress proxy
     (`echo $HTTPS_PROXY`) and report the exact error to the owner.
   - If enrollment says the code is invalid or expired, ask the owner for a new code (codes last 30 minutes and work once).

3. **Run it once now** and check the result:

   ```bash
   /home/hatch/venstudio/run.sh tick; tail -n 20 /home/hatch/venstudio/logs/worker.log
   ```

   The log should end with `queue empty` (or a finished job). Errors about the token mean enrollment failed; go back to step 2.

4. **Create the hourly scheduled task.** Title it `VenStudio worker` and make it run **every hour**:

   > Run `/home/hatch/venstudio/run.sh hold` and wait until it exits (up to about 55 minutes). Then run
   > `tail -n 5 /home/hatch/venstudio/logs/worker.log`. If the log shows `fatal`, tell the owner the error.
   > Otherwise finish silently, without messaging the owner.

   Important details:
   - Run the command **in the foreground and wait for it**. It stays online for about 55 minutes so new jobs
     start within seconds, then returns by itself. A render that started before then is finished first.
     Waiting keeps this VM on.
   - If the previous run is still busy with a long render, the command prints `already running` and returns
     at once. That is normal, not an error.
   - Don't add a loop or `sleep`; the hourly schedule does that.
   - Don't message the owner on success. Only report errors.
   - If the scheduled task can't run that long and gets cut off, use `/home/hatch/venstudio/run.sh hold --max-minutes 25`
     instead, and tell the owner the limit you saw.

5. **Tell the owner it's done** with: the worker name, the last 5 log lines, and confirmation that the hourly task
   exists. The owner will see the worker appear in the portal under **Workers**.

## When the owner says "run VenStudio now"

The owner may message you (in the app or WhatsApp) to run the worker right away. Run
`/home/hatch/venstudio/run.sh tick`, wait until it exits, and reply with the last 5 lines of
`/home/hatch/venstudio/logs/worker.log`. If the hourly `VenStudio worker` task is missing or paused, recreate it
as in step 4 and say so.

## Rules

- Never print, log, or send the contents of `/home/hatch/venstudio/config.json`. It holds the worker token.
- Don't change the install location, and don't install anything outside `/home/hatch`.
- Don't connect any of the owner's accounts, and don't make purchases. This setup needs neither.
- To update the worker later, run step 2 again without `--code`; the existing enrollment is kept.
