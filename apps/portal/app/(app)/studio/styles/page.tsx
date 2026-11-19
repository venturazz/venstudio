import { requireUser } from "@/lib/server/auth.ts";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui.tsx";
import { ENGINES, FAMILY_LABELS, STYLES, THEMES, VIDEO_FORMATS, type Family, type Style } from "@/lib/studio/catalog.ts";

export const metadata = { title: "Style library" };

const MUSE_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = {
  "muse-ok": "ok",
  "muse-slow": "warn",
  "muse-test": "warn",
  "gpu-preferred": "danger",
  external: "neutral",
};
const MUSE_LABEL: Record<string, string> = {
  "muse-ok": "Muse: runs well",
  "muse-slow": "Muse: slow, CPU only",
  "muse-test": "Muse: verify first",
  "gpu-preferred": "Needs a GPU worker",
  external: "AI provider",
};

export default async function StyleLibraryPage() {
  await requireUser();
  const families = [...new Set(STYLES.map((s) => s.family))] as Family[];
  return (
    <>
      <PageHeader
        title="Style library"
        description="Every style the studio can plan, with the engine that renders it and what Muse can do with it."
      />
      <div className="space-y-8">
        {families.map((family) => (
          <section key={family} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{FAMILY_LABELS[family]}</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {STYLES.filter((s) => s.family === family).map((s) => (
                <StyleCard key={s.id} style={s} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Themes" description="Topics the studio knows how to frame, with their content rules." />
          <CardBody>
            <ul className="space-y-3 text-sm">
              {THEMES.map((t) => (
                <li key={t.id}>
                  <p className="font-medium">{t.label}</p>
                  <p className="text-xs text-muted">{t.policy.join(" ")}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Engines" description="What renders each style, and where it can run." />
          <CardBody>
            <ul className="space-y-3 text-sm">
              {Object.values(ENGINES).map((e) => (
                <li key={e.id} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{e.label}</p>
                    <Badge tone={MUSE_TONE[e.muse]}>{MUSE_LABEL[e.muse]}</Badge>
                    <Badge>{e.tier}</Badge>
                  </div>
                  <p className="text-xs text-muted">{e.note}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
      <p className="mt-6 text-xs text-muted">
        Formats: short {VIDEO_FORMATS.short.width}×{VIDEO_FORMATS.short.height}, long {VIDEO_FORMATS.long.width}×{VIDEO_FORMATS.long.height}.
      </p>
    </>
  );
}

function StyleCard({ style: s }: { style: Style }) {
  const engine = ENGINES[s.engine];
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{s.label}</p>
        {s.formats.map((f) => (
          <Badge key={f}>{f === "short" ? "Short" : "Long"}</Badge>
        ))}
      </div>
      <p className="mt-1 text-sm text-muted">{s.description}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={MUSE_TONE[engine.muse]}>{MUSE_LABEL[engine.muse]}</Badge>
        <span className="text-muted">
          Engine: {engine.label} · {s.narration ? "with narration" : "no narration"}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted">Matches: {s.keywords.slice(0, 6).join(", ")}</p>
      {s.cautions.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-muted">
          {s.cautions.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      {s.sources.length > 0 && (
        <p className="mt-2 break-all text-xs">
          {s.sources.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="mr-3 text-accent underline-offset-2 hover:underline">
              source
            </a>
          ))}
        </p>
      )}
    </Card>
  );
}
