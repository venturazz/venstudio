"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Input, Select } from "@/components/ui.tsx";
import { TIMEZONES } from "@/lib/studio/schedule.ts";
import { createScheduleAction, setScheduleStateAction, tickNowAction, type ScheduleFormState } from "./actions.ts";

export interface StyleOption {
  id: string;
  label: string;
}

export function TickButton() {
  const [state, dispatch, pending] = useActionState<ScheduleFormState | undefined, FormData>(tickNowAction, undefined);
  return (
    <form action={dispatch} className="space-y-2">
      <Button type="submit" variant="primary" disabled={pending} className="min-h-11">
        {pending ? "Checking the clock…" : "Run the tick now"}
      </Button>
      {state?.ok && <Alert tone="ok">{state.ok}</Alert>}
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <p className="text-xs text-muted">
        Safe to press as often as you like: one slot becomes one run, or none. A slot is skipped, with its reason, when the channel&rsquo;s worker
        is still rendering, when the day&rsquo;s hours are spent, or when the schedule is not armed.
      </p>
    </form>
  );
}

export function ScheduleStateForm({ id, state }: { id: string; state: "draft" | "armed" | "paused" }) {
  const [result, dispatch, pending] = useActionState<ScheduleFormState | undefined, FormData>(setScheduleStateAction, undefined);
  const next = state === "armed" ? "paused" : "armed";
  return (
    <form action={dispatch} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="state" value={next} />
      <Button type="submit" variant={next === "armed" ? "primary" : "secondary"} disabled={pending} className="min-h-11">
        {pending ? "Working…" : next === "armed" ? (state === "draft" ? "Arm it" : "Resume") : "Pause"}
      </Button>
      {result?.ok && <span className="text-xs text-ok">{result.ok}</span>}
      {result?.error && <span className="text-xs text-danger">{result.error}</span>}
    </form>
  );
}

export function CreateScheduleForm({
  channels,
  styles,
  defaultThemeId,
}: {
  channels: Array<{ id: string; name: string; videosPerDay: number; format: string }>;
  styles: StyleOption[];
  defaultThemeId: string;
}) {
  const [state, dispatch, pending] = useActionState<ScheduleFormState | undefined, FormData>(createScheduleAction, undefined);
  const first = channels[0];
  return (
    <form action={dispatch} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Channel" htmlFor="channelId" hint="One schedule, one channel: it uses that channel's worker, language and videos per day.">
          <Select id="channelId" name="channelId" required defaultValue={first?.id ?? ""}>
            {channels.length === 0 && (
              <option value="" disabled>
                No channel yet
              </option>
            )}
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.videosPerDay}/day
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name" htmlFor="name">
          <Input id="name" name="name" maxLength={80} placeholder="Myth Stories · weekday mornings" defaultValue="" />
        </Field>
        <Field label="Style" htmlFor="styleId">
          <Select id="styleId" name="styleId" defaultValue={styles[0]?.id ?? ""}>
            {styles.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Length (seconds)" htmlFor="durationSec" hint="A schedule's length is fixed: every slot in the series is the same shape.">
          <Input id="durationSec" name="durationSec" type="number" min={15} max={1200} step={15} defaultValue={45} />
        </Field>
        <Field label="Days" htmlFor="days" hint="daily · weekly:mon,thu · every:2">
          <Select id="days" name="days" defaultValue="daily">
            <option value="daily">Every day</option>
            <option value="weekly:mon">Mondays</option>
            <option value="weekly:mon,thu">Mondays and Thursdays</option>
            <option value="weekly:mon,wed,fri">Mon, Wed, Fri</option>
            <option value="every:2">Every two days</option>
            <option value="every:3">Every three days</option>
          </Select>
        </Field>
        <Field label="Zone" htmlFor="timezone" hint="The times below are in this zone, not the worker's. 07:00 Jakarta is 07:00 Jakarta.">
          <Select id="timezone" name="timezone" defaultValue="Asia/Jakarta">
            {TIMEZONES.map((z) => (
              <option key={z.zone} value={z.zone}>
                {z.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Times" htmlFor="timesOfDay" hint="One HH:MM per video. Leave empty to use 07:00, or 07:00 and 19:00 for two a day.">
          <Input id="timesOfDay" name="timesOfDay" placeholder="07:00, 19:00" defaultValue="" />
        </Field>
        <Field label="Worker hours a day" htmlFor="budgetHours" hint="A ceiling on render cost, not a count of videos. One video can take an hour.">
          <Select id="budgetHours" name="budgetHours" defaultValue="2">
            {[1, 2, 4, 6, 8].map((h) => (
              <option key={h} value={h}>
                {h} hour{h === 1 ? "" : "s"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Language" htmlFor="language">
          <Select id="language" name="language" defaultValue="en">
            <option value="en">English</option>
            <option value="id">Indonesian</option>
          </Select>
        </Field>
        <Field label="Topic, if it is fixed" htmlFor="briefTopic" hint="Leave empty and the channel's plan decides what to make. Write one and every slot works from it.">
          <Input id="briefTopic" name="briefTopic" maxLength={400} defaultValue="" />
        </Field>
      </div>
      <input type="hidden" name="themeId" value={defaultThemeId} />
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" name="arm" className="size-4 accent-[var(--vs-accent)]" />
        Arm it straight away
      </label>
      <Button type="submit" variant="primary" disabled={pending || channels.length === 0} className="min-h-11">
        {pending ? "Creating…" : "Create schedule"}
      </Button>
      {state?.ok && <Alert tone="ok">{state.ok}</Alert>}
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
    </form>
  );
}