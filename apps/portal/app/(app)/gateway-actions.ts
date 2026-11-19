"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/server/auth.ts";
import { gatewayStatus } from "@/lib/server/ai-gateway.ts";
import { hermesStatus } from "@/lib/server/hermes.ts";

export async function recheckGateway() {
  await requireUser("editor");
  await gatewayStatus({ fresh: true });
  revalidatePath("/settings");
  revalidatePath("/");
}

export async function recheckHermes() {
  await requireUser("editor");
  await hermesStatus({ fresh: true });
  revalidatePath("/settings");
  revalidatePath("/");
}
