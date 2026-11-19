import { routerImageModel } from "@/lib/server/executors/router-image.ts";

/** Async server component; wrap in <Suspense>. Reads the stored capability scan only. */
export async function RouterImageNote() {
  const model = await routerImageModel();
  return (
    <p className="mb-3 text-sm text-muted">
      {model
        ? `9router lists image models. If Hermes cannot make a picture, the studio asks 9router next (${model.id}).`
        : "9router lists no image models in the last scan, so after Hermes the studio goes to the public-domain library."}
    </p>
  );
}
