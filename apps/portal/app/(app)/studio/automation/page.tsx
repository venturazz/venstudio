import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui.tsx";
import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { listSchedules, upcoming } from "@/lib/server/schedules.ts";
import { listTemplates } from "@/lib/server/templates.ts";
import { timesMismatch } from "@/lib/studio/schedule.ts";
import { StudioNav } from "../studio-nav.tsx";
import { CreateScheduleForm, ScheduleStateForm, TickButton } from "./schedule-forms.tsx";

export const dynamic = "force-dynamic";

const TONE = { armed: "ok", draft: "warn", paused: "neutral" } as const;

function local(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
}

export default async function AutomationPage() {
  await requireUser("editor");

  let schedules: Awaited<ReturnType<typeof listSchedules>> = [];
  let channels: Array<{ id: string; name: string; videosPerDay: number; format: string }> = [];
  let styles: Array<{ id: string; label: string }> = [];
  let loadError = "";

  try {
    const [rows, channelRows, templates] = await Promise.all([
      listSchedules(),
      db()`SELECT id, name, videos_per_day, format FROM channels ORDER BY name`,
      listTemplates(),
    ]);
    schedules = rows;
    channels = channelRows.map((c) => ({ id: String(c.id), name: String(c.name), videosPerDay: Number(c.videos_per_day), format: String(c.format) }));
    // The schedule stores a style, not a template: which template renders it is the pipeline's business, and styles outlive
    // template ids.
    styles = Array.from(new Map(templates.map((t) => [t.styleId, { id: t.styleId, label: t.label }])).values());
  } catch (err) {
    loadError = err instanceof Error ? err.message : "The schedules could not be read.";
  }

  const now = new Date();
  const perChannel = new Map<string, number>();
  for (const s of schedules) perChannel.set(s.channelId, (perChannel.get(s.channelId) ?? 0) + 1);

  return (
    <div className="space-y-6">
      <PageHeader
        title="AutoStudio"
        description="Schedules that fill the New Video form for you. Same styles, same brief, same sound — only the clock is new."
      />

      <StudioNav current="automation" />

      {loadError && <Alert tone="danger">{loadError}</Alert>}

      <Card>
        <CardHeader title="The clock" description="One pass over every armed schedule. A slot becomes one run, or none." />
        <CardBody>
          <TickButton />
        </CardBody>
      </Card>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold">Schedules</h2>
        {schedules.length === 0 && !loadError && (
          <EmptyState
            title="No schedule yet"
            description="A schedule is one channel, one style and one length, on a rhythm. The number of videos a day comes from the channel — it is not asked again here."
          />
        )}
        {schedules.map((s) => {
          const next = upcoming(s, now, 3);
          const mismatch = timesMismatch(s.timesOfDay, s.videosPerDay);
          const channelSchedules = perChannel.get(s.channelId) ?? 0;
          return (
            <Card key={s.id}>
              <CardHeader
                title={s.name}
                description={`${s.channelName} · ${s.settings.styleId || "no style"} · ${Math.round(s.settings.durationSec / 60) || 1} min · ${s.budgetHours} worker hour${s.budgetHours === 1 ? "" : "s"}/day`}
                actions={<Badge tone={TONE[s.state]}>{s.state}</Badge>}
              />
              <CardBody className="space-y-3">
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <span className="text-muted">Rhythm </span>
                    {s.days} · {s.timesOfDay.join(", ")} · {s.timezone}
                  </div>
                  <div>
                    <span className="text-muted">Channel asks for </span>
                    {s.videosPerDay} video{s.videosPerDay === 1 ? "" : "s"} a day
                    {channelSchedules > 1 ? ` · ${channelSchedules} schedules on this channel` : ""}
                  </div>
                </div>
                {mismatch && <Alert tone="warn">{mismatch}</Alert>}
                {s.channelStatus !== "active" && (
                  <Alert tone="warn">The channel is {s.channelStatus}. Nothing starts until it is active.</Alert>
                )}
                {next.length > 0 ? (
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted">Next slots, in {s.timezone}</p>
                    <ul className="mt-1 space-y-1 text-sm">
                      {next.map((n) => (
                        <li key={n.at.toISOString()} className="flex flex-wrap items-center gap-2">
                          <span className="tabular-nums">{local(n.at, s.timezone)}</span>
                          <span className="text-xs text-muted">= {n.at.toISOString().slice(0, 16).replace("T", " ")} UTC</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-sm text-muted">This rhythm has no next slot — check the days and times.</p>
                )}
                <ScheduleStateForm id={s.id} state={s.state} />
              </CardBody>
            </Card>
          );
        })}
      </section>

      <Card>
        <CardHeader
          title="New schedule"
          description="One channel, one style, one length, one rhythm. It fills the same form New Video fills by hand."
        />
        <CardBody>
          <CreateScheduleForm
            channels={channels}
            styles={styles}
            defaultThemeId=""
          />
        </CardBody>
      </Card>
    </div>
  );
}