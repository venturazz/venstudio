import { LinkButton } from "@/components/ui.tsx";

export type StudioSection = "runs" | "new" | "styles" | "templates" | "test-render";

const LINKS: Array<{ id: StudioSection; href: string; label: string }> = [
  { id: "runs", href: "/studio", label: "Runs" },
  { id: "styles", href: "/studio/styles", label: "Styles" },
  { id: "templates", href: "/studio/templates", label: "Templates" },
  { id: "test-render", href: "/studio/test-render", label: "Test render" },
];

/** The same Studio links on every Studio page. New video is the one primary action. Wraps on a 390 px phone. */
export function StudioNav({ current }: { current: StudioSection }) {
  return (
    <nav aria-label="Studio" className="flex flex-wrap gap-2">
      {current !== "new" && (
        <LinkButton href="/studio/new" variant="primary">
          New video
        </LinkButton>
      )}
      {LINKS.map((l) => (
        <LinkButton key={l.id} href={l.href} variant={current === l.id ? "ghost" : "secondary"} aria-current={current === l.id ? "page" : undefined}>
          {l.label}
        </LinkButton>
      ))}
    </nav>
  );
}
