// Server-side URL validation for user-configured AI providers and result URLs.
// A provider URL is an SSRF boundary: it must never be allowed to point at a
// loopback, link-local, or private service from the Next/Electron host.

import { lookup } from 'node:dns/promises'
import net from 'node:net'

function isPrivateAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
  }
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase()
    // IPv4-mapped IPv6 literals are still IPv4 destinations. Treat a mapped
    // private address exactly like its IPv4 representation.
    if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7))
    return normalized === '::1' || normalized === '::' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb')
  }
  return true
}

/**
 * Accept only public HTTPS URLs. All DNS answers are checked before use; a
 * redirect is forbidden by callers, so a valid provider cannot pivot a
 * request to a private address after validation.
 */
export async function requireSafeExternalHttpsUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Provider URL is invalid.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port === '0') {
    throw new Error('Provider URL must be a public HTTPS URL without embedded credentials.')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || (net.isIP(hostname) !== 0 && isPrivateAddress(hostname))) {
    throw new Error('Provider URL must not target a local or private address.')
  }
  let records: { address: string }[]
  try {
    records = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new Error('Provider hostname could not be resolved.')
  }
  if (records.length === 0 || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error('Provider URL resolves to a local or private address.')
  }
  return url
}

export function appendProviderPath(base: URL, suffix: string): string {
  return `${base.toString().replace(/\/+$/, '')}${suffix}`
}
