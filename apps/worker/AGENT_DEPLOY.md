# VenStudio worker: setup guide for the Muse agent

**Audience:** the Muse agent, setting up a render worker inside this Muse sandbox VM for its owner.
The owner sent you this link together with an **enrollment code** and a **worker name**.

## What this is

VenStudio is the owner's own video production portal at {{PORTAL_URL}}. The worker is a small program that,
when started, asks the portal for render jobs over HTTPS, renders them with ffmpeg, uploads the result,
and exits when there is nothing left to do. It does not open ports, accept inbound connections, or need any
of the owner's passwords. Its only secret is a worker token, stored in `/home/hatch/venstudio/config.json`.

This VM is recycled when idle and only `/home/hatch` survives, so everything installs under `/home/hatch/venstudio`.

## Steps

1. **Check you have what you need.** You need the enrollment code (looks like `VS-XXXX-XXXX-XXXX`) and the worker
   name from the owner's message. If either is missing, ask the owner. Don't invent a code.

2. **Install and enroll.** Run, replacing the two values:

   ```bash
   curl -fsSL {{PORTAL_URL}}/install/install.sh | bash -s -- --code "VS-XXXX-XXXX-XXXX" --name "Muse 01" --mode tick
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

4. **Create the hourly scheduled task.** Create a recurring scheduled task that runs **every hour**:

   > Run `/home/hatch/venstudio/run.sh tick` and wait until it exits. Then run
   > `tail -n 5 /home/hatch/venstudio/logs/worker.log`. If the log shows `fatal`, tell the owner the error.
   > Otherwise finish silently, without messaging the owner.

   Important details:
   - Run the command **in the foreground and wait for it**. It returns by itself when the queue is empty, or
     after at most 50 minutes. Waiting keeps this VM on while a video renders.
   - Don't add a loop or `sleep`; the hourly schedule does that.
   - Don't message the owner on success. Only report errors.

5. **Tell the owner it's done** with: the worker name, the last 5 log lines, and confirmation that the hourly task
   exists. The owner will see the worker appear in the portal under **Workers**.

## Rules

- Never print, log, or send the contents of `/home/hatch/venstudio/config.json`. It holds the worker token.
- Don't change the install location, and don't install anything outside `/home/hatch`.
- Don't connect any of the owner's accounts, and don't make purchases. This setup needs neither.
- To update the worker later, run step 2 again without `--code`; the existing enrollment is kept.
