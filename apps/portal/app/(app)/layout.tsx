import Link from "next/link";
import { Clapperboard, Cpu, LayoutDashboard, ListVideo, LogOut, Settings, Tv } from "lucide-react";
import { requireUser } from "@/lib/server/auth.ts";
import { BottomNav, SideNav, type NavItem } from "@/components/client.tsx";
import { signOut } from "./actions.ts";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const icon = "size-5 shrink-0";
  const items: NavItem[] = [
    { href: "/", label: "Overview", icon: <LayoutDashboard className={icon} aria-hidden /> },
    { href: "/channels", label: "Channels", icon: <Tv className={icon} aria-hidden /> },
    { href: "/jobs", label: "Jobs", icon: <ListVideo className={icon} aria-hidden /> },
    { href: "/workers", label: "Workers", icon: <Cpu className={icon} aria-hidden /> },
    { href: "/settings", label: "Settings", icon: <Settings className={icon} aria-hidden /> },
  ];

  return (
    <div className="lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface px-3 py-4 lg:flex">
        <Link href="/" className="mb-6 flex items-center gap-2 px-3">
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-fg">
            <Clapperboard className="size-4" aria-hidden />
          </span>
          <span className="font-semibold tracking-tight">VenStudio</span>
        </Link>
        <SideNav items={items} />
        <div className="mt-auto border-t border-border px-3 pt-3">
          <p className="truncate text-sm font-medium">{user.name}</p>
          <p className="truncate text-xs text-muted">
            {user.email} · {user.role}
          </p>
          <form action={signOut} className="mt-2">
            <button className="flex items-center gap-2 text-xs text-muted hover:text-fg">
              <LogOut className="size-3.5" aria-hidden /> Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-surface/90 px-4 py-3 backdrop-blur lg:hidden">
          <Link href="/" className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-lg bg-accent text-accent-fg">
              <Clapperboard className="size-4" aria-hidden />
            </span>
            <span className="font-semibold tracking-tight">VenStudio</span>
          </Link>
          <form action={signOut}>
            <button className="grid size-10 place-items-center rounded-lg text-muted hover:bg-surface-2" aria-label="Sign out">
              <LogOut className="size-5" aria-hidden />
            </button>
          </form>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-5 sm:px-6 lg:px-8 lg:pb-10 lg:pt-8">{children}</main>
      </div>

      <BottomNav items={items} />
    </div>
  );
}
