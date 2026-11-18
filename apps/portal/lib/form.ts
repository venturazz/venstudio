export type FormValues = Record<string, string>;
export type FormState = { error?: string; ok?: string; values?: FormValues } | undefined;

export function str(fd: FormData, key: string, max = 500): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Fields never echoed back to the browser. */
const SECRET = /password|token|code|current|next|confirm/i;

/**
 * Error result that keeps what the user typed. React 19 resets a form after its action runs,
 * so forms read these back as default values. Secret fields are dropped.
 */
export function fail(fd: FormData, error: string): { error: string; values: FormValues } {
  const values: FormValues = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v === "string" && !k.startsWith("$") && !SECRET.test(k)) values[k] = v.slice(0, 4000);
  }
  return { error, values };
}
