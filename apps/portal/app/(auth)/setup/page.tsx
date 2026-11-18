import { redirect } from "next/navigation";
import { db } from "@/lib/server/db.ts";
import { env } from "@/lib/server/env.ts";
import { Alert } from "@/components/ui.tsx";
import { SetupForm } from "../forms.tsx";

export const metadata = { title: "First-time setup" };

export default async function SetupPage() {
  const [{ n }] = await db()`SELECT count(*)::int AS n FROM users`;
  if (n > 0) redirect("/login");
  return (
    <>
      <h1 className="text-lg font-semibold">First-time setup</h1>
      <p className="mb-5 mt-1 text-sm text-muted">Create the owner account. This page closes once an owner exists.</p>
      {env().SETUP_TOKEN ? (
        <SetupForm />
      ) : (
        <Alert tone="warn">Set SETUP_TOKEN in the server environment and restart the portal to continue.</Alert>
      )}
    </>
  );
}
