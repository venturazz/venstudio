# Faster ways to reach Muse workers

Date: 2026-11-18. Follow-up to `01-video-automation-research.md`. Content from sources was rephrased for compliance with licensing restrictions.

## The real problem

The worker already pulls jobs within seconds while it runs. The delay comes from the VM being asleep: nothing on the worker runs until the hourly Muse task starts `run.sh tick`, and `tick` exits as soon as the queue is empty. Any faster method has to do one of two things:

1. **Keep the worker running longer** so it is already awake when a job arrives, or
2. **Start the worker from outside** when the portal has a job.

Two facts from Muse's own agent docs (published copy: [system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Meta/muse-agent/docs/scheduling-and-watching.md)) limit option 2:
- Scheduled tasks and "event-based automations" both work by polling, and fire around their scheduled time, give or take minutes. A Muse "watch" on email or anything else is no faster than a schedule.
- Processes don't survive a VM recycle; only `/home/hatch` does. Waking the VM alone doesn't start the worker. Something (the agent) still has to run `run.sh`.

## Options compared

| # | Method | Pickup delay | Official? | Risk | Verdict |
|---|---|---|---|---|---|
| A | Hourly `tick` (built) | up to ~60 min | Yes | Low | Keep as the base |
| B | **Hold mode**: hourly task runs the worker for ~55 min, polling every 20 s, instead of exiting on an empty queue | seconds while held; covers ~90% of the hour | Yes (normal scheduled task) | Low; uses more Muse compute time per run | **Build first.** Needs test: does Muse allow a 55-min foreground command? |
| C | Long-poll claim: `/claim` waits up to 25 s for a job before answering 204 | removes the 20 s poll gap | n/a (our API) | None | Build with B |
| D | More frequent schedule (every 15 or 5 min) + daemon mode | 5 to 15 min, or seconds if the VM stays up between runs | Yes | More agent runs count against Muse usage | Option per worker; measure usage first |
| E | **Human "run now" via WhatsApp/app**: you text your Muse "run venstudio now" | ~1 min | Yes | None; needs you | Add to the setup guide as a manual fast path |
| F | **Custom connector / MCP**: portal exposes an MCP server; Muse agent uses tools like `venstudio.next_job`, `venstudio.report` | Doesn't wake Muse | Yes ([Muse builds custom connectors to any public HTTPS API or MCP server](https://parallel.ai/articles/best-mcp-servers-for-meta-muse); no settings field for MCP, the agent writes the client) | Low | Useful for agent-driven work (e.g. Muse browsing for research), not for wake-up |
| G | **muse2api-style session driver**: portal holds each account's muse.ai session cookies, calls the VM wake endpoint and types "run tick" into the chat with a headless browser | ~1 to 2 min | **No** | **High** (below) | Optional experimental plugin only, off by default |
| H | Automate your personal WhatsApp (Baileys / whatsapp-web.js) to message Muse | ~1 min | **No** | **High**: unofficial WhatsApp clients violate WhatsApp's terms and get numbers banned | Not recommended |
| I | WhatsApp Business bot messaging Muse | n/a | n/a | n/a | **Not possible.** Muse's WhatsApp chat only accepts messages the user sends from WhatsApp, not app-authored messages ([Muse WhatsApp doc](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Meta/muse-agent/docs/chat-connections/whatsapp.md)) |
| J | Email trigger (portal emails the Muse-connected inbox, Muse watch reacts) | same as schedule | Yes | Low | No gain: watches poll |
| K | Muse Code CLI / Meta Model API | n/a | Yes | n/a | **Doesn't reach the Muse VM.** Muse Code runs locally and only the model is hosted ([Codersera](https://codersera.com/blog/muse-code-complete-guide-2026/), [Meta](https://dev.meta.ai/docs/muse-code)). Could be another text model behind 9router |
| L | Priority lane on an always-on worker (cheap VPS or your PC in daemon mode) | seconds | Yes | Low; small monthly cost | **Recommended for urgent jobs** (revisions, previews) |

## muse2api in detail

[muse2api](https://github.com/www222fff/muse2api) (MIT, ~380 stars, last push 2026-11-01) wraps the muse.ai web app as an OpenAI-compatible API. Relevant findings from its code:

- **Login:** uses your exported browser cookies (`hatch_sess`, `hatch_native_auth_device`). Whoever holds them has full access to that Muse account, including connected apps.
- **VM wake:** `POST https://muse.ai/api/hatch/vm/wake` with the VM id from `GET /api/session` (`upstream/muse.py`). This boots the VM, but per the facts above it doesn't start our worker.
- **Sending a message:** a headless Chromium driver fills the chat box and clicks send. That message is what would actually make the agent run `run.sh`.
- **Status:** its own README and TODO say the browser driver and session renewal **have not been tested against a real account** (tasks A2 and A4 "Not started"). DOM selectors may already be outdated.
- **Terms:** Meta's terms forbid accessing its products by automated means without permission ([Meta developer policy](https://developers.facebook.com/docs/development/terms-and-policies/automated-data-collection/)). muse2api's disclaimer says it is for research only. Doing this on 10 accounts is a clear pattern for Meta to flag, and a ban could also hit the linked Meta/WhatsApp identities.

If used at all: as an opt-in "wake driver" per worker, cookies encrypted with `ENCRYPTION_KEY`, at most a few wakes per day, only for jobs marked urgent, with automatic fallback to the schedule.

## Recommended design: a trigger ladder

The portal keeps one job queue. How fast a job starts depends on which triggers a worker has. Each trigger is independent, so a broken one never blocks the others.

1. **Always:** hourly Muse task in hold mode (B) + long-poll claim (C). Most jobs start within seconds of being queued, because a held worker is usually online.
2. **Urgent jobs:** marked `priority: urgent` in the portal and sent first to always-on workers (L). Optional.
3. **Manual:** "Run now" message you can send to any Muse from WhatsApp or the app (E). The portal shows which Muse needs it.
4. **Experimental (off by default):** muse2api-style wake (G), only after a test account proves it works and you accept the ban risk.
5. **Later:** a VenStudio MCP connector (F) for tasks where the Muse agent itself does the work, like browsing reference videos for research.

## Tests to add (one Muse account)

9. Hold mode: does a scheduled task running a 55-minute foreground command finish, or is it cut off? After how long?
10. Usage: how much of the plan's weekly usage do 24 hold-mode runs per day use? (muse2api reads this from Settings → Usage; you can read it by hand.)
11. After `POST /api/hatch/vm/wake`, is the VM a fresh boot (no processes) or a resumed one (old processes still running)? Only relevant if option G is ever tried.

## Built (2026-11-18)

- Hold mode (B), long-poll claims (C), urgent lane (L) and the "Needs attention" run-now message (E).
- Not built: muse2api-style wake (G), WhatsApp automation (H), MCP connector (F).
