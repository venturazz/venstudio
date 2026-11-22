"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { audit } from "@/lib/server/audit.ts";
import { requestMeta } from "@/lib/server/request.ts";
import { addSource, beginSynthesis, createStudy, processSource, sourcesForHermes, synthesize } from "@/lib/server/lab-studies.ts";
import { analystFor, LAB_SOURCE_TYPES, MAX_NOTE_CHARS, MAX_URL_CHARS } from "@/lib/studio/lab-study.ts";
import { str } from "@/lib/form.ts";

const uuid = z.uuid();

function back(studyId: string, msg: { ok?: string; error?: string }): never {
  const q = msg.error ? `?error=${encodeURIComponent(msg.error.slice(0, 300))}` : msg.ok ? `?ok=${encodeURIComponent(msg.ok.slice(0, 200))}` : "";
  revalidatePath(`/studio/lab/${studyId}`);
  redirect(`/studio/lab/${studyId}${q}`);
}

export async function createStudyAction(fd: FormData): Promise<void> {
  const user = await requireUser("editor");
  const r = await createStudy({ title: str(fd, "title", 200), goal: str(fd, "goal", 10), basePack: str(fd, "basePack", 63), notes: str(fd, "notes", MAX_NOTE_CHARS), userId: user.id });
  if (!r.ok) redirect(`/studio/lab?error=${encodeURIComponent(r.error)}`);
  await audit({ userId: user.id, action: "lab.study.create", target: r.id, ip: (await requestMeta()).ip });
  revalidatePath("/studio/lab");
  redirect(`/studio/lab/${r.id}`);
}

/** Adds one source. Hermes looks at links, articles, repositories and skills in the background, through the gate. */
export async function addSourceAction(studyId: string, fd: FormData): Promise<void> {
  const user = await requireUser("editor");
  if (!uuid.safeParse(studyId).success) redirect("/studio/lab");
  const type = str(fd, "type", 20);
  if (!LAB_SOURCE_TYPES.some((t) => t === type)) back(studyId, { error: "Choose a source type" });
  const r = await addSource(studyId, { type, ref: str(fd, "ref", type === "owner-note" ? MAX_NOTE_CHARS : MAX_URL_CHARS + 1), path: str(fd, "path", 201), licence: str(fd, "licence", 200) }, user.id);
  if (!r.ok) back(studyId, { error: r.error });
  await audit({ userId: user.id, action: "lab.source.add", target: studyId, detail: { sourceId: r.id, type }, ip: (await requestMeta()).ip });
  const analyst = analystFor(type as (typeof LAB_SOURCE_TYPES)[number]);
  if (analyst !== "none") after(() => processSource(r.id));
  const added: Record<string, string> = {
    upload: "Upload added. Its analysis is linked.",
    link: "Link added. Hermes is looking at it.",
    repo: "Repository added. Hermes is reading it.",
    skill: "Skill added. Hermes is reading it.",
    article: "Article added. Hermes is reading it.",
    "owner-note": "Note added.",
  };
  back(studyId, { ok: added[type] ?? "Source added." });
}

/** Asks again for every source still waiting, or one that failed. */
export async function retrySourceAction(studyId: string, sourceId: string): Promise<void> {
  await requireUser("editor");
  if (!uuid.safeParse(studyId).success || !uuid.safeParse(sourceId).success) redirect("/studio/lab");
  after(() => processSource(sourceId, studyId));
  back(studyId, { ok: "Asked again." });
}

export async function retryPendingAction(studyId: string): Promise<void> {
  await requireUser("editor");
  if (!uuid.safeParse(studyId).success) redirect("/studio/lab");
  const ids = await sourcesForHermes(studyId);
  after(async () => {
    for (const id of ids) await processSource(id, studyId);
  });
  back(studyId, { ok: ids.length ? `Asked Hermes about ${ids.length} waiting source${ids.length === 1 ? "" : "s"}.` : "Nothing is waiting for Hermes." });
}

/** Asks Hermes for the draft pack spec, or (with a note) for a revision of the current draft. At most 5 revisions. */
export async function synthesizeAction(studyId: string, fd: FormData): Promise<void> {
  const user = await requireUser("editor");
  if (!uuid.safeParse(studyId).success) redirect("/studio/lab");
  const note = str(fd, "note", MAX_NOTE_CHARS);
  const begun = await beginSynthesis(studyId, note);
  if (!begun.ok) back(studyId, { error: begun.error });
  await audit({ userId: user.id, action: note ? "lab.draft.revise" : "lab.draft.synthesize", target: studyId, ip: (await requestMeta()).ip });
  after(() => synthesize(studyId, note));
  back(studyId, { ok: note ? "Hermes is revising the draft." : "Hermes is drafting the pack." });
}
