// @ts-check
/**
 * Tiny cookie jar for E2E tests. Records Set-Cookie and replays Cookie.
 */

export function makeCookieJar() {
  /** @type {Map<string,string>} */
  const jar = new Map();

  function ingest(setCookieHeader) {
    if (!setCookieHeader) return;
    const headers = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : [setCookieHeader];
    for (const h of headers) {
      const [pair] = h.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (v === "") jar.delete(k);
      else jar.set(k, v);
    }
  }

  function header() {
    return Array.from(jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  return { ingest, header, jar };
}

/**
 * Wrap a `fetch` to attach + persist cookies across calls.
 * @param {(path: string, init?: RequestInit) => Promise<Response>} baseFetch
 */
export function withCookies(baseFetch) {
  const jar = makeCookieJar();
  return {
    jar,
    fetch: async (path, init = {}) => {
      const headers = new Headers(init.headers || {});
      const c = jar.header();
      if (c) headers.set("Cookie", c);
      const r = await baseFetch(path, { ...init, headers });
      jar.ingest(r.headers.get("set-cookie") || undefined);
      return r;
    },
  };
}
