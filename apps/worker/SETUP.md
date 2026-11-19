# VenStudio worker setup

Reference for the owner of a VenStudio portal ({{PORTAL_URL}}). It describes what the worker is and the commands
that set it up. To set up a Muse VM, the owner sends the setup message from the portal's **Workers → Add a worker**
page; that message contains these same commands with a fresh one-time code.

## What the worker is

A single Node.js file (`venstudio-worker.ts`, readable at {{PORTAL_URL}}/install/venstudio-worker.ts) that:

- asks the portal for render jobs over outbound HTTPS, renders them with ffmpeg, and uploads the results;
- opens no ports and accepts no inbound connections;
- stores one secret, a worker token, in `/home/hatch/venstudio/config.json` (file mode 600);
- writes only under `/home/hatch/venstudio`.

The owner can revoke the token at any time in the portal under **Workers**.

## Install

```bash
mkdir -p /home/hatch/venstudio && cd /home/hatch/venstudio
curl -fsSL {{PORTAL_URL}}/install/install.sh -o install.sh
sha256sum install.sh      # compare with the value shown in the portal
bash install.sh --portal {{PORTAL_URL}} --code VS-XXXX-XXXX-XXXX --name "Muse 01" --mode hold
```

`install.sh` (readable before running) installs Node.js 24 from nodejs.org and a static ffmpeg build from
johnvansickle.com if the machine lacks them, verifying their published checksums, then downloads the worker and
enrolls it with the one-time code. It ends with `install complete`.

## Hourly schedule (Muse)

A recurring hourly task runs:

```bash
/home/hatch/venstudio/run.sh hold
```

in the foreground. It stays online for up to about 55 minutes so new jobs start within seconds, finishes any render it
started, and exits. If the previous run is still rendering, it prints `already running` and exits at once. The log is
`/home/hatch/venstudio/logs/worker.log`; a line containing `fatal` means something needs the owner.

## Run now

```bash
/home/hatch/venstudio/run.sh tick
```

runs every queued job and exits when the queue is empty.

## Update or remove

- Update: run the install commands again without `--code`; the enrollment is kept.
- Remove: revoke the worker in the portal, delete the scheduled task, then `rm -rf /home/hatch/venstudio`.
