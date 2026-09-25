// Secure-port convention for the LAN deployment.
//
// A page served over https:// cannot fetch http:// or connect to ws:// — the
// browser blocks it as mixed content. So every service the panel talks to has
// a TLS twin on the `https-front` proxy, and the panel must pick it whenever
// the page itself is https. One rule, one place:
//
//     insecure port + 10  ==  secure port      (state server, ACP bridges)
//
// The two older services predate the rule and keep their historical +1 ports:
// the panel bundle (25808 -> 25809) and GigaAM STT (25905 -> 25906, see stt.ts).
//
// Nothing here changes the http path: opened over http:// everything resolves
// exactly as before, so a local non-TLS session still works.

/** Insecure port -> secure port. `+10` unless the pair is an explicit legacy one. */
const SECURE_PORT: Record<number, number> = {
  25808: 25809, // the panel bundle itself (front serves it)
  25905: 25906, // GigaAM STT (matches stt.ts)
};

const SECURE_PORT_OFFSET = 10;

/** The port that serves `port` over TLS when the page itself is https. */
export function securePortFor(port: number): number {
  return SECURE_PORT[port] ?? port + SECURE_PORT_OFFSET;
}

/** True when the page itself is served over https (or a Vite dev https origin). */
export function isSecurePage(): boolean {
  return (
    typeof location !== 'undefined' && location.protocol === 'https:'
  );
}

/**
 * Rewrite a loopback/LAN URL the same way a browser would have to: `ws://` ->
 * `wss://` and `http://` -> `https://`, on the service's secure port. A URL
 * that already carries the right scheme is returned untouched (so a user who
 * edited Settings to point at a real TLS endpoint keeps it).
 */
export function toSecureUrl(raw: string): string {
  if (!isSecurePage() || !raw) return raw;
  const match = /^(ws|http)(:\/\/)([^/:]+)(?::(\d+))?(\/.*)?$/.exec(raw);
  if (!match) return raw;
  // No path in the input stays no-path: callers append "/health", "/api/…"
  // themselves — defaulting rest to "/" would give them a doubled slash and
  // the state server's exact-match routes would 404.
  const [, scheme, slashes, host, port, rest = ''] = match;
  const secureScheme = scheme === 'ws' ? 'wss' : 'https';
  const securePort = port ? securePortFor(Number(port)) : '';
  return `${secureScheme}${slashes}${host}${securePort ? `:${securePort}` : ''}${rest}`;
}

/**
 * The panel's own origin when served securely, i.e. the entry point a user
 * should bookmark. With no secure context (plain http) this returns null.
 * On a secure page `location.port` already IS the TLS port, so this is just
 * the current origin — `securePortFor` applies to insecure service ports,
 * not to the page itself.
 */
export function securePanelUrl(): string | null {
  if (!isSecurePage() || typeof location === 'undefined') return null;
  return location.origin;
}
