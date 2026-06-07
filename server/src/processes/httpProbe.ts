/**
 * Per-port "does this speak HTTP?" probe. Used to decide whether the
 * processes-panel Ports column renders a port as a clickable link.
 *
 * Strategy: HEAD http://127.0.0.1:<port>/ with a 200ms timeout. Any
 * HTTP response — including 4xx/5xx — counts as positive (the port
 * has an HTTP server, even if `/` isn't its real route). On
 * connection failure / timeout, retry once after 1s before giving up
 * (handles the "port just started accepting" race).
 *
 * Cache is keyed by port number alone; a port can only be bound by
 * one process at a time, so when a port disappears from the latest
 * sweep we drop its cache entry so a reuse gets re-probed.
 *
 * In-flight probes are deduped so the same port never gets two
 * concurrent HEAD requests.
 */

import http from 'node:http';

export class HttpProbe {
  private cache = new Map<number, boolean>();
  private inflight = new Map<number, Promise<boolean>>();

  /** Last-known result, or null when never probed (or evicted). */
  get(port: number): boolean | null {
    return this.cache.has(port) ? this.cache.get(port)! : null;
  }

  /** Probe a port, returning the (cached or fresh) result. Concurrent
   * calls for the same port share the same Promise. Negative results
   * are NOT cached — every sweep retries non-HTTP ports so a server
   * that was busy / not-yet-ready during the first probe still gets a
   * second chance to upgrade to a link. Only positives are sticky. */
  async probe(port: number): Promise<boolean> {
    if (this.cache.has(port)) return this.cache.get(port)!;
    const existing = this.inflight.get(port);
    if (existing) return existing;
    const p = this.runProbe(port).then((ok) => {
      if (ok) this.cache.set(port, true);
      this.inflight.delete(port);
      return ok;
    });
    this.inflight.set(port, p);
    return p;
  }

  /** Drop cache entries for ports not in `keep`. Call after each port
   * sweep so a dead → reused port gets re-probed instead of inheriting
   * the prior process's result. */
  retainOnly(keep: Set<number>): void {
    for (const port of this.cache.keys()) {
      if (!keep.has(port)) this.cache.delete(port);
    }
  }

  private async runProbe(port: number): Promise<boolean> {
    // Try IPv4 first, then fall back to IPv6. Plenty of dev servers
    // (vite under recent node, anything that does `app.listen(port)`
    // without an explicit host) bind to `::` or `::1` only and refuse
    // 127.0.0.1 connections — without the v6 fallback those ports
    // always stamp as not-HTTP. 1s per attempt keeps the worst case
    // bounded.
    if (await tryHead('127.0.0.1', port, 1000)) return true;
    return tryHead('::1', port, 1000);
  }
}

function tryHead(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = http.request(
      { method: 'HEAD', host, port, path: '/', timeout: timeoutMs },
      (res) => {
        res.resume();
        // Only 2xx/3xx count as "user-friendly browser destination".
        // 4xx (e.g. an API server's 404 on `/`) and 5xx still speak
        // HTTP, but clicking them takes you nowhere useful — so they
        // stay as plain text in the panel.
        const status = res.statusCode ?? 0;
        settle(status >= 200 && status < 400);
      },
    );
    req.on('error', () => settle(false));
    req.on('timeout', () => {
      req.destroy();
      settle(false);
    });
    req.end();
  });
}
