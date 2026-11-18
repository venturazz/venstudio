import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { Card, CardBody, PageHeader } from "@/components/ui.tsx";
import { ChannelForm } from "../channel-form.tsx";
import { createChannel } from "../actions.ts";

export const metadata = { title: "New channel" };

export default async function NewChannelPage() {
  await requireUser("editor");
  const workers = await db()`SELECT id, name FROM workers WHERE status <> 'revoked' ORDER BY name`;
  return (
    <>
      <PageHeader title="New channel" />
      <Card>
        <CardBody>
          <ChannelForm
            action={createChannel}
            workers={workers.map((w) => ({ id: w.id, name: w.name }))}
            submitLabel="Create channel"
          />
        </CardBody>
      </Card>
    </>
  );
}
