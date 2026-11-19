/**
 * Classifies an IP address so the portal never fetches from its own network on a model's say-so. Pure: no DNS,
 * no sockets. Used by lib/server/safe-fetch.ts.
 */

/** Why an address is blocked, or null when it is a normal public address. */
export function blockedAddressReason(ip: string): string | null {
  const v4 = parseV4(ip);
  if (v4) return blockedV4(v4);
  const v6 = parseV6(ip);
  if (v6) return blockedV6(v6);
  return "not a valid IP address";
}

function parseV4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

function blockedV4(p: number[]): string | null {
  const [a, b, c] = p;
  if (a === 0) return "unspecified address";
  if (a === 10) return "private network (10.0.0.0/8)";
  if (a === 100 && b >= 64 && b <= 127) return "shared address space (100.64.0.0/10)";
  if (a === 127) return "loopback address";
  if (a === 169 && b === 254) return "link-local address (169.254.0.0/16)";
  if (a === 172 && b >= 16 && b <= 31) return "private network (172.16.0.0/12)";
  if (a === 192 && b === 0 && c === 0) return "reserved address (192.0.0.0/24)";
  if (a === 192 && b === 168) return "private network (192.168.0.0/16)";
  if (a === 198 && (b === 18 || b === 19)) return "benchmark network (198.18.0.0/15)";
  if (a >= 224) return "multicast or reserved address";
  return null;
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. Accepts :: and a trailing IPv4 part. */
function parseV6(ip: string): number[] | null {
  let s = ip.trim().toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tail) {
    const v4 = parseV4(tail[1]);
    if (!v4) return null;
    s = s.slice(0, s.length - tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (t: string): number[] | null => {
    if (t === "") return [];
    const out: number[] = [];
    for (const g of t.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1]);
  if (!rest) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function blockedV6(g: number[]): string | null {
  if (g.every((x) => x === 0)) return "unspecified address";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback address";
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms carry an IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return blockedV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]) ?? null;
  }
  // NAT64 (64:ff9b::/96 and the local-use 64:ff9b:1::/48) and 6to4 (2002::/16) embed an IPv4 address that a
  // translator on the route would reach, so they are blocked whole.
  if (g[0] === 0x64 && g[1] === 0xff9b) return "NAT64 address (64:ff9b::/96)";
  if (g[0] === 0x2002) return "6to4 address (2002::/16)";
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local address (fe80::/10)";
  if ((g[0] & 0xfe00) === 0xfc00) return "private network (fc00::/7)";
  if ((g[0] & 0xff00) === 0xff00) return "multicast address";
  return null;
}

/** Scheme, host and port the owner configured, for example from HERMES_BASE_URL. Null when it cannot be read. */
export function originOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.hostname.toLowerCase().replace(/^\[|\]$/g, "")}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }
}

/**
 * Trust decision for one hop of a download. Only the first request may use the owner's trusted origins (http and
 * private addresses allowed). A redirect into a trusted origin is refused, and any other redirect is untrusted.
 */
export function hopTrust(raw: string, trustedOrigins: readonly string[], first: boolean): "trusted" | "untrusted" | "refused" {
  if (!matchesTrustedOrigin(raw, trustedOrigins)) return "untrusted";
  return first ? "trusted" : "refused";
}

/** True only when the URL has exactly the scheme, host and port of one of the trusted origins. */
export function matchesTrustedOrigin(raw: string, trustedOrigins: readonly string[]): boolean {
  const o = originOf(raw);
  return o !== null && trustedOrigins.some((t) => t.toLowerCase() === o);
}
