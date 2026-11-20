import { listProviderPlugins, listProviderTerms } from "@/lib/server/executors/persist.ts";
import { pluginRowNote } from "@/lib/studio/asset-plan.ts";
import { Badge, Input, Select } from "./ui.tsx";
import { SubmitButton } from "./client.tsx";
import { setProviderTerms } from "@/app/(app)/settings/actions.ts";

const KIND_LABEL = { image: "Image", tts: "Voice", library: "Library", video: "Video" } as const;
const STATUS_LABEL = { unknown: "Not confirmed", yes: "Commercial use OK", no: "Not for commercial use" } as const;
const TONE = { unknown: "warn", yes: "ok", no: "danger" } as const;

/** Owner-only list. Each provider is added automatically as "not confirmed"; only these buttons change that. */
export async function ProviderTerms() {
  const terms = await listProviderTerms();
  const plugins = await listProviderPlugins();
  if (terms.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted sm:px-5">No provider has made an asset yet. They appear here the first time one does.</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {terms.map((t) => {
        const legacy = pluginRowNote(t.name, t.kind);
        const via = plugins.get(`${t.kind}:${t.name}`) ?? [];
        return (
          <li key={`${t.kind}:${t.name}`} className="space-y-2 px-4 py-3 text-sm sm:px-5" data-testid="provider-row" data-provider={t.name}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 break-words font-medium">{t.name}</span>
              <Badge>{KIND_LABEL[t.kind]}</Badge>
              <Badge tone={TONE[t.commercialOk]}>{STATUS_LABEL[t.commercialOk]}</Badge>
            </div>
            {via.length > 0 && !legacy && (
              <p className="break-words text-xs text-muted">Made through the Hermes plugin {via.join(", ")}. These terms cover this backend only.</p>
            )}
            {legacy && (
              <p className="break-words text-xs text-muted" data-testid="plugin-row-note">
                {legacy}
              </p>
            )}
            <form action={setProviderTerms} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
              <input type="hidden" name="name" value={t.name} />
              <input type="hidden" name="kind" value={t.kind} />
              <Select name="status" defaultValue={t.commercialOk} aria-label={`Commercial use for ${t.name}`} className="w-full sm:w-52">
                <option value="unknown">Not confirmed</option>
                <option value="yes">Commercial use OK</option>
                <option value="no">Not for commercial use</option>
              </Select>
              <Input
                name="note"
                defaultValue={t.note ?? ""}
                maxLength={300}
                placeholder="Note, for example the terms page you read"
                aria-label={`Note for ${t.name}`}
                className="w-full min-w-0 sm:flex-1"
              />
              <SubmitButton className="min-h-11 text-sm" pendingLabel="Saving…">
                Save
              </SubmitButton>
            </form>
          </li>
        );
      })}
    </ul>
  );
}
