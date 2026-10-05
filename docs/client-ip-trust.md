# Client IP attribution and trusted proxies

Rate limits, anonymous quotas, login throttling and API-key IP allowlists all identify the caller through one
resolver: `resolveClientIp` in `src/lib/security/client-ip.ts`. Forwarding headers are client-writable unless a
proxy under your control rewrites them, so they are only read under the contract below.

## Deployment contract

1. The socket peer is the only address a client cannot forge. Next.js middleware and App Router route handlers
   cannot see it, so on those paths the peer is unknown unless the caller passes `peerIp` (custom server, or a
   Node-style request that exposes `socket.remoteAddress`). `request.ip` and `X-Real-IP` are never consulted.
2. **Behind a platform proxy or load balancer, set `TRUSTED_PROXIES`** to the CIDR list of your proxy hops
   (comma separated, IPv4 and IPv6). That declares that the origin accepts connections only from those hops and
   that the nearest hop appends the address it saw to `X-Forwarded-For` (or `Forwarded`). The chain is walked
   right to left, skipping trusted hops; the first untrusted address is the client. Entries to its left are never
   read.
3. **Production must declare a trust mode.** Set `TRUSTED_PROXIES` to a CIDR list, or to `none`. With
   `NODE_ENV=production` and neither `TRUSTED_PROXIES` nor `TRUSTED_CDN` set, the edge middleware answers
   `/api/*` with `503` (`client-ip-trust-unconfigured`, with `Retry-After`) and logs once; `GET`/`HEAD
   /api/health` and non-API pages stay up. Nothing throws at import time, and development and tests keep
   running undeclared.
4. **A directly exposed deployment cannot attribute clients.** Without a proxy the middleware never sees the
   socket peer, and a forwarding header from an unknown sender could be anything, so no per-client limit is
   possible. `TRUSTED_PROXIES=none` acknowledges this: forwarding headers are never read, and every request is
   *unattributed*. Unset in development behaves the same way.
5. **Unattributed is a degraded mode, not fairness.**
   - All unattributed requests share the key `unattributed` and one edge bucket, sized for site-wide traffic
     (600 burst, 100/s) instead of one client (60 burst, 10/s). `GET`/`HEAD /api/health` is exempt from it.
   - Login keeps its per-email counter and lockout but skips the per-IP counter, so one client cannot lock out
     everyone.
   - Anonymous access keeps the burst limiter but has no daily quota, because a shared quota would let one
     client exhaust it for all. Trade-off: until a trust mode is declared, anonymous callers are limited only
     by the shared burst bucket. Declare `TRUSTED_PROXIES` to restore per-client daily quotas.
   - IP allowlists never match `unattributed`.
6. When the socket peer is known (`peerIp`), an untrusted peer is the client and its headers are ignored. A
   trusted peer defaults to loopback and private ranges when `TRUSTED_PROXIES` is unset.
7. `CF-Connecting-IP` is honoured only with `TRUSTED_CDN=cloudflare` and only when the nearest hop is inside the
   Cloudflare ranges (shipped in `CLOUDFLARE_IP_RANGES`; override with `TRUSTED_CDN_RANGES`). Cloudflare edge
   addresses are also treated as skippable hops while walking `X-Forwarded-For`.
8. Only one forwarding header is read: `TRUSTED_PROXY_HEADER=x-forwarded-for` (default) or `forwarded`
   (RFC 7239). The other header is client-writable behind a proxy that does not maintain it, so it is ignored
   (never parsed, never compared). Placeholder hops (`unknown`, obfuscated `_token`) in the declared header
   yield `unattributed`.

## Operator checklist

- Firewall the origin so only the declared proxy hops can reach it. In headers-only mode the declaration is a
  promise, not something the server can verify.
- The proxy must append to, not trust, an incoming `X-Forwarded-For`
  (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).

## Configuration

| Variable | Meaning |
| --- | --- |
| `TRUSTED_PROXIES` | Comma-separated CIDRs or addresses of trusted hops (at most 256), or `none` for direct exposure. Required in production. |
| `TRUSTED_PROXY_HEADER` | `x-forwarded-for` (default) or `forwarded`: the single header your proxy maintains. |
| `TRUSTED_CDN` | `cloudflare`. Enables `CF-Connecting-IP` for a verified edge hop. |
| `TRUSTED_CDN_RANGES` | CIDR list replacing the shipped ranges for the configured CDN. Requires `TRUSTED_CDN`. |

## API-key allowlists

Allowlist entries are matched against the full resolved address (never the /64 rate-limit bucket). Bare
entries may carry a port or brackets (`1.2.3.4:80`, `[2001:db8::1]:443`), which are ignored. CIDR entries with
host bits set (`192.168.1.77/24`) match their network. The `unattributed` key matches only a `*` entry.

## Failure modes

- Malformed forwarding data from a trusted sender (not an address, empty hop, header over 4096 characters, more
  than 32 hops) is rejected with HTTP 400 (`InvalidForwardingHeaderError`).
- Malformed trust configuration is rejected with HTTP 503 and `Retry-After` (`ClientIpConfigError`) by the
  middleware, API guard and login route, and logged. Empty list entries (trailing commas, spaces) are ignored.
- Addresses are validated and canonicalised (ports and brackets stripped, IPv4-mapped IPv6 folded to IPv4, IPv6
  in RFC 5952 form) so alternate spellings share one rate-limit identity.
