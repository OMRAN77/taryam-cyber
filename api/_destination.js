// Guard for tools that make outbound connections on the user's behalf.
//
// The only safe place to check "is this target private?" is after DNS resolution:
// a hostname such as internal.example.com can point at 10.0.0.5, and forms like
// 2130706433, 0x7f.0.0.1 or [::1] all reach loopback while looking like ordinary
// input. So this module resolves first, inspects every address it got, and only
// then hands the caller a verified address. Callers must connect to the address
// returned by resolvePublic() — not to the original hostname — otherwise a second
// DNS answer (rebinding) can point somewhere else.
//
// Fail closed: if resolution fails or returns nothing usable, the request is
// rejected rather than retried around the check.
const dns = require('dns').promises;
const net = require('net');

// Ranges that must never be reachable from a shared public tool.
const BLOCKED = [
  ['0.0.0.0', 8],          // "this network"
  ['10.0.0.0', 8],         // private
  ['100.64.0.0', 10],      // carrier-grade NAT
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local (incl. 169.254.169.254 cloud metadata)
  ['172.16.0.0', 12],      // private
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.168.0.0', 16],     // private
  ['198.18.0.0', 15],      // benchmarking
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved + broadcast
];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isBlockedIpv4(ip) {
  const value = ipv4ToInt(ip);
  return BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedIpv6(ip) {
  const a = ip.toLowerCase();
  // Every IPv4-mapped form (::ffff:127.0.0.1) is judged by its IPv4 part.
  const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (a === '::' || a === '::1') return true;
  if (/^f[cd]/.test(a)) return true;               // unique local fc00::/7
  if (/^fe[89ab]/.test(a)) return true;            // link-local fe80::/10
  if (/^ff/.test(a)) return true;                  // multicast
  return false;
}

function isBlockedAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true; // not an IP at all: refuse rather than guess
}

class BlockedTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedTargetError';
    this.code = 'BLOCKED_TARGET';
  }
}

// Resolves a hostname to one address that is safe to connect to.
// Returns { address, family } and throws BlockedTargetError otherwise.
async function resolvePublic(hostname) {
  const host = String(hostname || '').trim().replace(/^\[|\]$/g, '');
  if (!host) throw new BlockedTargetError('Missing host');

  // A literal IP needs no lookup; a hostname that parses as a literal (decimal,
  // hex, octal) is normalised by net.isIP and then blocked if private.
  const literal = net.isIP(host);
  if (literal) {
    if (isBlockedAddress(host)) throw new BlockedTargetError('Private or reserved addresses are not allowed');
    return { address: host, family: literal };
  }

  let records = [];
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new BlockedTargetError('Host could not be resolved');
  }
  if (!Array.isArray(records) || !records.length) throw new BlockedTargetError('Host could not be resolved');

  // One private answer is enough to refuse the whole name: a mixed result is
  // exactly what a rebinding setup looks like.
  for (const r of records) {
    if (isBlockedAddress(r.address)) throw new BlockedTargetError('Host resolves to a private or reserved address');
  }
  return { address: records[0].address, family: records[0].family };
}

// Ports the tools may reach. 443 covers the TLS check; 80/8080 keep the header
// scanner useful for plain-HTTP sites without turning it into a port scanner.
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
const TLS_PORTS = new Set([443, 8443]);

function parseTarget(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new BlockedTargetError('Missing URL');
  // A bare domain gets https://; any other explicit scheme (ftp:, file:, gopher:) is
  // refused rather than turned into a nonsense https host such as "https://ftp//x".
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) throw new BlockedTargetError('Only http/https are supported');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    throw new BlockedTargetError('Invalid URL');
  }
  if (!/^https?:$/.test(url.protocol)) throw new BlockedTargetError('Only http/https are supported');
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) throw new BlockedTargetError('Port ' + port + ' is not allowed');
  return { url, hostname: url.hostname, port };
}

module.exports = { resolvePublic, parseTarget, isBlockedAddress, BlockedTargetError, ALLOWED_PORTS, TLS_PORTS };
