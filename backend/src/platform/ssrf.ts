// backend/src/platform/ssrf.ts
// Completion Plan Section 6 & 9: SSRF protection for outbound HTTP calls (OIDC JWKS/token, alert webhooks, connectors).
import net from "node:net";
import { AppConfig, isHardenedEnv, loadConfig } from "./config";
import { AppError } from "./errors";

const ALWAYS_BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "169.254.169.254",
  "100.100.100.200",
  "fd00:ec2::254"
]);

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateOrReservedIpv6(rawIp: string): boolean {
  const ip = rawIp.toLowerCase().replace(/^\[|\]$/g, "");
  if (ip === "::" || ip === "::1") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("ff")) return true;
  // IPv4-mapped IPv6 (::ffff:169.254.169.254)
  const v4Match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match && v4Match[1]) {
    return isPrivateOrReservedIpv4(v4Match[1]);
  }
  return false;
}

export interface OutboundUrlCheckOptions {
  cfg?: AppConfig;
  allowLocalInDev?: boolean;
  label?: string;
}

/**
 * Validates an outbound URL before invoking fetch().
 * - Always rejects non-http(s) protocols, embedded credentials, and cloud metadata endpoints.
 * - In hardened environments (staging/production) or when allowLocalInDev=false, requires HTTPS
 *   and refuses loopback, RFC1918 private networks, link-local addresses, and .local/.internal hostnames.
 */
export function assertSafeOutboundUrl(rawUrl: string, opts: OutboundUrlCheckOptions = {}): URL {
  const cfg = opts.cfg ?? loadConfig();
  const label = opts.label || "Outbound URL";
  const allowLocalInDev = opts.allowLocalInDev ?? true;
  const hardened = isHardenedEnv(cfg.appEnv);

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError("VALIDATION", `${label} is not a valid URL.`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AppError("VALIDATION", `${label} must use http or https protocol.`);
  }

  if (parsed.username || parsed.password) {
    throw new AppError("VALIDATION", `${label} must not contain embedded credentials.`);
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) {
    throw new AppError("VALIDATION", `${label} must specify a hostname.`);
  }

  // Always block cloud metadata endpoints in every environment
  if (ALWAYS_BLOCKED_HOSTS.has(host) || host.startsWith("169.254.")) {
    throw new AppError("FORBIDDEN", `${label} targets a prohibited metadata or link-local address.`);
  }

  const restrictPrivate = hardened || !allowLocalInDev;
  if (restrictPrivate) {
    if (parsed.protocol !== "https:") {
      throw new AppError("FORBIDDEN", `${label} must use HTTPS.`);
    }
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      throw new AppError("FORBIDDEN", `${label} cannot target loopback or internal hostnames.`);
    }
    const ipVersion = net.isIP(host);
    if (ipVersion === 4 && isPrivateOrReservedIpv4(host)) {
      throw new AppError("FORBIDDEN", `${label} cannot target private or reserved IPv4 addresses.`);
    }
    if (ipVersion === 6 && isPrivateOrReservedIpv6(host)) {
      throw new AppError("FORBIDDEN", `${label} cannot target private or reserved IPv6 addresses.`);
    }
  }

  return parsed;
}
