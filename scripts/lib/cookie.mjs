/**
 * The one definition of the `dsh-auth` browser cookie this repository mints.
 *
 * Why this exists: setup.mjs issued a 30-day cookie and refused a stored grant whose version was
 * not 1, while parity-snapshot.mjs issued 7 days and accepted any version. Two copies of a
 * security-relevant constant drift: a copied tool then mints a credential the Host rejects, or one
 * that stays usable long after the session it was minted for. Both entry points mint through here.
 *
 * @module
 */
import { createHash, createHmac } from 'node:crypto'

/** Cookie payload version the shipping Host issues and accepts. */
export const DSH_AUTH_VERSION = 1

/** Cookie name prefix; the suffix is the base64url SHA-256 of the authority. */
export const COOKIE_NAME_PREFIX = 'dsh-auth-'

/**
 * 7 days: the stricter of the two windows this repository used to issue (7 and 30).
 *
 * The cookie is a bearer credential for the whole remote Host, and re-minting it costs one
 * `tmux capture-pane` plus one `/connect` round trip, so a longer window only keeps a leaked
 * cookie usable for longer. Widen this only against the Host's own expiry, never by a guess.
 */
export const DSH_AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * base64url without padding, the encoding the Host uses for every cookie component.
 * @param buffer - bytes to encode.
 * @returns The unpadded base64url string.
 */
export function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * Reject a stored grant or payload whose version this repository cannot mint correctly.
 * @param version - the version read from the credentials file, or undefined when absent.
 * @param source - what was read; quoted in the error so the operator knows which file to fix.
 * @returns Nothing; throws when the version is not {@link DSH_AUTH_VERSION}.
 */
export function assertCookieVersion(version, source) {
  if (version === DSH_AUTH_VERSION) return
  throw new Error('dsh-auth version ' + String(version) + ' in ' + source + ' is not supported (expected ' + String(DSH_AUTH_VERSION) + ')')
}

/**
 * Mint the browser-session cookie the Host would have issued itself.
 * @param options.authority - origin authority the cookie is scoped to.
 * @param options.secretB64u - base64url 32-byte browser-session signing secret.
 * @param options.now - issuance time in epoch milliseconds; defaults to the current clock.
 * @returns The cookie name and value, ready to pair into a `name=value` header.
 */
export function mintAuthCookie({ authority, secretB64u, now = Date.now() }) {
  const secret = Buffer.from(String(secretB64u).replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (secret.byteLength !== 32) throw new Error('browser-session secret is not 32 bytes')
  const payload = { version: DSH_AUTH_VERSION, authority, issuedAt: now, expiresAt: now + DSH_AUTH_TTL_MS }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  // The wire token carries the same version as the payload: the Host rejects a mismatch by design.
  return {
    name: COOKIE_NAME_PREFIX + b64url(createHash('sha256').update(authority).digest()),
    value: 'v' + String(DSH_AUTH_VERSION) + '.' + body + '.' + b64url(createHmac('sha256', secret).update(body).digest()),
  }
}
