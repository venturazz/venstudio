/**
 * 9router documents its base URL as http://host:20128/v1, so accept the address with or without /v1.
 * Returns the root without /v1; callers add /v1/... themselves.
 */
export function normalizeGatewayBase(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}
