import { redirect } from "next/navigation";

/** The run list now lives on /studio. This keeps older links working. Run pages stay at /studio/runs/[id]. */
export default function RunsPage(): never {
  redirect("/studio");
}
