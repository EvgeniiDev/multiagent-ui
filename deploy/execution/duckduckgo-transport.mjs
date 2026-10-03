// Transport compatibility for the registered pi-web-access DuckDuckGo parser.
// A GET search currently yields an anomaly shell; the public HTML form POST
// returns results. Preserve the extension's proxy transport and TLS checks.
export function installDuckDuckGoTransport({fetchImpl = globalThis.fetch, target = globalThis} = {}) {
  if (fetchImpl?.__acpDuckDuckGoTransport === true) return fetchImpl;
  if (typeof fetchImpl !== 'function' || fetchImpl.__piWebAccessProxyFetch !== true) {
    throw new Error('DuckDuckGo transport requires the registered proxy fetch');
  }
  const wrapped = (input, init = {}) => {
    let url;
    try { url = new URL(input instanceof Request ? input.url : input); }
    catch { return fetchImpl(input, init); }
    const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.protocol !== 'https:' || url.hostname !== 'html.duckduckgo.com'
      || (url.port && url.port !== '443') || url.username || url.password
      || url.pathname !== '/html/' || !url.searchParams.has('q') || method !== 'GET') {
      return fetchImpl(input, init);
    }
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('content-type', 'application/x-www-form-urlencoded');
    const body = url.searchParams.toString();
    url.search = '';
    // Request-level signal/credentials survive when init does not override.
    const requestOptions = input instanceof Request ? {
      signal: input.signal, credentials: input.credentials, redirect: input.redirect,
    } : {};
    return fetchImpl(url, {...requestOptions, ...init, headers, method:'POST', body});
  };
  wrapped.__piWebAccessProxyFetch = true;
  wrapped.__acpDuckDuckGoTransport = true;
  target.fetch = wrapped;
  return wrapped;
}

export function duckDuckGoExtensionSource() {
  return `import originalExtension from '/work/node_modules/pi-web-access/index.ts';
import {installGlobalProxyFetch} from '/work/node_modules/pi-web-access/utils.ts';
import {installDuckDuckGoTransport} from '/work/conf/duckduckgo-transport.mjs';
export default function(pi) {
  installGlobalProxyFetch();
  installDuckDuckGoTransport();
  return originalExtension(pi);
}
`;
}
