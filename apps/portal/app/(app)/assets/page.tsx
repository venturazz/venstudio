import Link from "next/link";
import { FolderOpen } from "lucide-react";
import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { listAssets, VIDEO_KINDS, type AnalysisSummary } from "@/lib/server/assets.ts";
import { provenanceIssues } from "@/lib/studio/provenance.ts";
import { ASSET_KINDS, type AssetKind } from "@/lib/studio/catalog.ts";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, cn, timeAgo } from "@/components/ui.tsx";
import { SubmitButton } from "@/components/client.tsx";
import { UploadForm } from "./upload-form.tsx";
import { analyzeAssetAction } from "./actions.ts";

export const metadata = { title: "Assets" };

function bytesLabel(b: string | number | null) {
  if (b === null) return "";
  const n = Number(b);
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function analysisLine(a: AnalysisSummary) {
  const parts = [
    `${a.cutCount} cuts`,
    `avg shot ${a.avgShotSeconds} s`,
    a.firstCutSeconds !== null ? `first cut at ${a.firstCutSeconds} s` : "no cuts found",
    a.loudnessLufs !== null ? `${a.loudnessLufs} LUFS` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const user = await requireUser();
  const { kind } = await searchParams;
  const filter = ASSET_KINDS.find((k) => k === kind) as AssetKind | undefined;
  const canEdit = hasRole(user.role, "editor");
  const [assets, channels] = await Promise.all([listAssets(filter), db()`SELECT id, name FROM channels ORDER BY name`]);

  return (
    <>
      <PageHeader
        title="Assets"
        description="Everything the studio uses or makes, with its source and licence. Nothing goes into a published video without a licence note."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <div className="flex gap-1 overflow-x-auto pb-1">
            {[undefined, ...ASSET_KINDS].map((k) => (
              <Link
                key={k ?? "all"}
                href={k ? `/assets?kind=${k}` : "/assets"}
                className={cn(
                  "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium",
                  filter === k ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
                )}
              >
                {k ?? "All"}
              </Link>
            ))}
          </div>

          {assets.length === 0 ? (
            <Card>
              <EmptyState
                icon={<FolderOpen className="size-8" />}
                title="No assets yet"
                description="Upload a reference video, an image or a font. Worker renders can be saved here from their job page."
              />
            </Card>
          ) : (
            <Card>
              <ul className="divide-y divide-border">
                {assets.map((a) => {
                  const issues = provenanceIssues(
                    [{ title: a.title, kind: a.kind, source: a.source, license: a.license, originUrl: a.origin_url }],
                    "publish",
                  );
                  const isVideo = VIDEO_KINDS.includes(a.kind);
                  return (
                    <li key={a.id} className="space-y-2 px-4 py-3 sm:px-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 truncate font-medium">{a.title}</p>
                        <Badge tone={a.kind === "reference-video" ? "info" : "neutral"}>{a.kind}</Badge>
                        <Badge>{a.source}</Badge>
                        {issues.length > 0 && <Badge tone="warn">Not ready to publish</Badge>}
                      </div>
                      <p className="text-xs text-muted">
                        {a.license ? `Licence: ${a.license}` : "No licence note"}
                        {a.origin_url && (
                          <>
                            {" · "}
                            <a href={a.origin_url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                              origin
                            </a>
                          </>
                        )}
                        {a.channel ? ` · ${a.channel}` : ""}
                        {a.bytes ? ` · ${bytesLabel(a.bytes)}` : ""} · {timeAgo(a.created_at)}
                      </p>
                      {a.analysis && <p className="text-xs">Analysis: {analysisLine(a.analysis as AnalysisSummary)}</p>}
                      {a.tags.length > 0 && <p className="text-xs text-muted">{a.tags.join(", ")}</p>}
                      <div className="flex flex-wrap gap-2 pt-1">
                        <a href={`/api/assets/${a.id}`} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center rounded-lg border border-border px-3 text-xs font-medium hover:bg-surface-2">
                          Open
                        </a>
                        <a href={`/api/assets/${a.id}?download=1`} className="inline-flex min-h-8 items-center rounded-lg border border-border px-3 text-xs font-medium hover:bg-surface-2">
                          Download
                        </a>
                        {canEdit && isVideo && (
                          <form action={analyzeAssetAction.bind(null, a.id)}>
                            <SubmitButton className="min-h-8 text-xs">{a.analysis ? "Analyze again" : "Analyze"}</SubmitButton>
                          </form>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          {canEdit ? (
            <Card>
              <CardHeader title="Add an asset" description="Saved with its licence and origin." />
              <CardBody>
                <UploadForm channels={channels.map((c) => ({ id: c.id, name: c.name }))} />
              </CardBody>
            </Card>
          ) : (
            <Card>
              <CardBody className="text-sm text-muted">You have view-only access. Ask an editor to add assets.</CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="How the library works" />
            <CardBody className="space-y-2 text-sm text-muted">
              <p>Each asset records its source, licence and origin. Publishing checks these before a video can use it.</p>
              <p>A reference video can be analyzed to learn its pacing. It can never appear in a published video.</p>
              <p>Muse renders and Hermes outputs are saved here, so every video can be traced back to its parts.</p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
