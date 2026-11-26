/**
 * The five routes that mount a remote Host into this one.
 *
 * Why they are a module: each handler is short, but all five must agree on things the mount
 * used to decide inline — which credential leg it speaks for, whether the host connection
 * policy still has anything to admit, and how failure is answered on HTTP versus a raw socket.
 * Keeping them together makes those agreements reviewable in one place.
 *
 * @module
 */

/** Page-facing endpoints served by the mount itself, never proxied to the remote. */
const ASSET_BLOCK_CSS = '/__dsh_remote_host__/asset/block.css'
const REPORT_PATH = '/__dsh_remote_host__/report'
const TRACE_PATH = '/__dsh_remote_host__/trace'

/**
 * What each handler does about the host connection policy.
 *
 * `checked` handlers ask the policy themselves and answer 401 (HTTP) or 403 (upgrade) when it
 * refuses. The two `exempt` upgrade legs are dialled by the page itself: its origin is
 * `dsh-app://app`, which can never equal this Host's authority, so a request-local policy check
 * has nothing to judge there and would only refuse every remote stream. The WebServer's own
 * authorize step is their gate. The exemption is declared here so it reads as a decision instead
 * of a forgotten call.
 */
export const ADMISSION = Object.freeze({
  mount: 'checked',
  orchestratorApi: 'checked',
  orchestratorUpgrade: 'exempt',
  streamMountUpgrade: 'exempt',
  muxUpgrade: 'checked',
})

/** Answer a request the host connection policy refused, in the mount's own vocabulary. */
function refuseHttp(res) {
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end('dsh-remote-host: not admitted by the host connection policy\n')
}

/**
 * Build the handlers of one mount.
 * @param options.dial - where the mount currently dials (blocked while a tunnel is down).
 * @param options.authority - `host:port` the remote credential was minted for.
 * @param options.credentials - cookie file, its refresher, and the upgrade legs' relay options.
 * @param options.admit - host connection policy check; true when admitted.
 * @param options.mount - same-origin mount path.
 * @param options.log - diagnostics sink; called for every line, gating is the caller's.
 * @param options.proxies - the HTTP and WebSocket forwarders owned by the mount.
 * @param options.relay - remote mux relay; present only when streams are enabled.
 * @param options.page - page-side endpoints: stylesheet, shim revision, trace sink, report.
 * @returns one handler per route, keyed like {@link ADMISSION}.
 */
export function createRouteHandlers(options) {
  const { dial, authority, credentials, admit, mount, log, proxies, relay, page } = options

  const mountHttp = (req, res) => {
    try {
      if (admit(req) !== true) {
        refuseHttp(res)
        return
      }
      const url = req.url ?? '/'
      const path = url.length > mount.length ? url.slice(mount.length) : '/'
      if (path === ASSET_BLOCK_CSS) {
        // Ported workspace-block stylesheet, served from the repository so the block and its
        // styles ship together.
        try {
          const css = page.blockCss()
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
          res.end(css)
        } catch (error) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('dsh-remote-host: block.css missing\n')
        }
        return
      }
      if (path === REPORT_PATH) {
        if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            try { page.setReport(JSON.parse(body)) } catch { page.setReport({ error: 'unparsable' }) }
            res.writeHead(204, { 'cache-control': 'no-store' })
            res.end()
          })
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        // `rev` lets a loaded page notice that the shim on disk changed.
        res.end(JSON.stringify({ ...(page.report() ?? { report: 'none yet' }), rev: page.revision() }))
        return
      }
      if (path === TRACE_PATH) {
        // Breadcrumbs are written locally and never proxied: the remote host has no business
        // seeing what this renderer was doing.
        if (req.method !== 'POST' || page.trace.enabled !== true) {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end('{"ok":true}')
          return
        }
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
          // Bound the buffer: a runaway page must not pin memory on the Host.
          if (body.length > page.trace.bodyLimit) body = body.slice(0, page.trace.bodyLimit)
        })
        req.on('end', () => {
          try { page.trace.append(body) } catch (error) { /* swallowed again, deliberately */ }
          try {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end('{"ok":true}')
          } catch (error) { /* the page may already be gone */ }
        })
        return
      }
      req.url = path
      proxies.request(req, res, dial, authority, credentials.cookieFile, { refresh: credentials.proxyRefresh })
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-remote-host: ' + String(error))
    }
  }

  // The super agent plugin serves its data under /orchestrator/api/ on THIS host, and its panel
  // calls it with plain fetch — which the browser shim never sees. Proxying that prefix at the
  // root makes the panel read the mounted instance.
  const orchestratorApi = (req, res) => {
    try {
      if (admit(req) !== true) {
        refuseHttp(res)
        return
      }
      // req.url already is /orchestrator/api/…, which is what the remote serves.
      proxies.request(req, res, dial, authority, credentials.cookieFile)
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-remote-host: ' + String(error))
    }
  }

  // Exempt from the handler-local check for the reason in {@link ADMISSION}.
  const orchestratorUpgrade = (req, socket, head) => {
    try {
      proxies.upgrade(req, socket, head, dial, authority, credentials.cookieFile, credentials.upgrade)
    } catch (error) {
      try { socket.destroy() } catch { /* ignore */ }
    }
  }

  // Exempt from the handler-local check for the reason in {@link ADMISSION}.
  const streamMountUpgrade = (req, socket, head) => {
    try {
      const url = req.url ?? '/'
      req.url = url.startsWith(mount) ? url.slice(mount.length) : url
      proxies.upgrade(req, socket, head, dial, authority, credentials.cookieFile, credentials.upgrade)
    } catch (error) {
      console.error('[dsh-remote-host] stream relay failed: ' + String(error))
      socket.destroy()
    }
  }

  const muxUpgrade = (req, socket, head) => {
    try {
      log('mux upgrade ' + String(req.url ?? '?')
        + ' origin=' + String(req.headers.origin ?? '-')
        + ' cookie=' + (req.headers.cookie === undefined ? 'none' : String(req.headers.cookie.length)))
      // Same admission as the HTTP mount: the connection service is a host-owned seam, so the
      // shared helper tolerates its absence instead of failing the upgrade closed.
      if (admit(req) !== true) {
        log('mux upgrade refused by the connection policy')
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      relay.upgrade(req, socket, head)
    } catch (error) {
      console.error('[dsh-remote-host] mux upgrade failed: ' + String(error))
      socket.destroy()
    }
  }

  return { mountHttp, orchestratorApi, orchestratorUpgrade, streamMountUpgrade, muxUpgrade }
}
