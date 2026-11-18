import { redirect } from "next/navigation";
import { db } from "@/lib/server/db.ts";
import { getSession } from "@/lib/server/auth.ts";
import { LoginForm } from "../forms.tsx";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  const session = await getSession();
  if (session && !session.mfaPending) redirect("/");
  const [{ n }] = await db()`SELECT count(*)::int AS n FROM users`;
  if (n === 0) redirect("/setup");
  return (
    <>
      <h1 className="text-lg font-semibold">Sign in</h1>
      <p className="mb-5 mt-1 text-sm text-muted">Welcome back to the studio.</p>
      <LoginForm />
    </>
  );
}
