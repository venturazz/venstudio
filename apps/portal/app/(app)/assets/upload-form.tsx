"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Field, Input, Select } from "@/components/ui.tsx";
import { ASSET_KINDS, ASSET_SOURCES } from "@/lib/studio/catalog.ts";

export function UploadForm({ channels }: { channels: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setStatus({ tone: "danger", text: "Choose a file first." });
      return;
    }
    const get = (k: string) => String(fd.get(k) ?? "").trim();
    const params = new URLSearchParams({
      title: get("title") || file.name,
      kind: get("kind"),
      source: get("source"),
      license: get("license"),
      originUrl: get("originUrl"),
      tags: get("tags"),
      channelId: get("channelId"),
      filename: file.name,
    });
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/assets?${params.toString()}`, {
        method: "POST",
        body: file,
        headers: { "content-type": file.type || "application/octet-stream" },
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; title?: string };
      if (!res.ok) {
        setStatus({ tone: "danger", text: body.error ?? `Upload failed (HTTP ${res.status}).` });
        return;
      }
      setStatus({ tone: "ok", text: `Saved ${body.title}.` });
      form.reset();
      router.refresh();
    } catch {
      setStatus({ tone: "danger", text: "The upload was interrupted. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {status && <Alert tone={status.tone === "ok" ? "ok" : "danger"}>{status.text}</Alert>}
      <Field label="File" htmlFor="file" hint="Video, image, audio or font. Large files can take a while.">
        <input id="file" name="file" type="file" required className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface-2 file:px-3 file:py-2" />
      </Field>
      <Field label="Title" htmlFor="title">
        <Input id="title" name="title" maxLength={120} placeholder="Defaults to the file name" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kind" htmlFor="kind">
          <Select id="kind" name="kind" defaultValue="video">
            {ASSET_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Source" htmlFor="source" hint="Where it came from.">
          <Select id="source" name="source" defaultValue="upload">
            {ASSET_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Licence or permission" htmlFor="license" hint="Required. For example: owned, CC0, CC-BY 4.0 (credit: name), licensed from …, study only.">
        <Input id="license" name="license" maxLength={300} required />
      </Field>
      <Field label="Origin link" htmlFor="originUrl" hint="Required for uploads and licensed files: the page it came from.">
        <Input id="originUrl" name="originUrl" type="url" placeholder="https://" maxLength={500} />
      </Field>
      <Field label="Tags" htmlFor="tags" hint="Comma separated, e.g. history, rome, map">
        <Input id="tags" name="tags" maxLength={200} />
      </Field>
      <Field label="Channel" htmlFor="channelId" hint="Optional.">
        <Select id="channelId" name="channelId" defaultValue="">
          <option value="">Shared</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="primary" className="w-full" disabled={busy}>
        {busy ? "Uploading…" : "Upload"}
      </Button>
    </form>
  );
}
