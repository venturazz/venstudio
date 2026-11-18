export type FormState = { error?: string; ok?: string } | undefined;

export function str(fd: FormData, key: string, max = 500): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
