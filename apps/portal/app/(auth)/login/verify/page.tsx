import { redirect } from "next/navigation";
import { getSession } from "@/lib/server/auth.ts";
import { VerifyForm } from "../../forms.tsx";

export const metadata = { title: "Two-factor check" };

export default async function VerifyPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.mfaPending) redirect("/");
  return (
    <>
      <h1 className="text-lg font-semibold">Two-factor check</h1>
      <p className="mb-5 mt-1 text-sm text-muted">Enter the code from your authenticator app for {session.email}.</p>
      <VerifyForm />
    </>
  );
}
