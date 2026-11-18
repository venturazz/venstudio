"use server";

import { redirect } from "next/navigation";
import { destroySession } from "@/lib/server/auth.ts";

export async function signOut() {
  await destroySession();
  redirect("/login");
}
