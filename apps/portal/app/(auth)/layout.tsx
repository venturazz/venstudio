import { Clapperboard } from "lucide-react";

export const dynamic = "force-dynamic";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-2">
        <span className="grid size-9 place-items-center rounded-xl bg-accent text-accent-fg">
          <Clapperboard className="size-5" aria-hidden />
        </span>
        <span className="text-lg font-semibold tracking-tight">VenStudio</span>
      </div>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-sm">{children}</div>
    </div>
  );
}
