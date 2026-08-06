import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isPrivateIpv4(ip) {
  const n = ipv4ToInt(ip);
  const ranges = [
    [ipv4ToInt("0.0.0.0"), ipv4ToInt("0.255.255.255")],
    [ipv4ToInt("10.0.0.0"), ipv4ToInt("10.255.255.255")],
    [ipv4ToInt("127.0.0.0"), ipv4ToInt("127.255.255.255")],
    [ipv4ToInt("169.254.0.0"), ipv4ToInt("169.254.255.255")],
    [ipv4ToInt("172.16.0.0"), ipv4ToInt("172.31.255.255")],
    [ipv4ToInt("192.168.0.0"), ipv4ToInt("192.168.255.255")],
  ];
  return ranges.some(([start, end]) => n >= start && n <= end);
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe80")) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
  }
  return false;
}

export function isPrivateIpAddress(ip) {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true;
}

export async function assertSafePublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return { ok: false, error: "That doesn’t look like a valid URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs are allowed." };
  }

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "0.0.0.0"
  ) {
    return { ok: false, error: "That host isn’t publicly reachable." };
  }

  if (isIP(host) && isPrivateIpAddress(host)) {
    return { ok: false, error: "That host isn’t publicly reachable." };
  }

  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (!records.length) {
      return { ok: false, error: "Couldn’t resolve that hostname." };
    }
    for (const record of records) {
      if (isPrivateIpAddress(record.address)) {
        return { ok: false, error: "That host resolves to a private address." };
      }
    }
    return {
      ok: true,
      url,
      resolvedAddresses: records.map((r) => r.address),
    };
  } catch {
    return { ok: false, error: "Couldn’t resolve that hostname." };
  }
}
