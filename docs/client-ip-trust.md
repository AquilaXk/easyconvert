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
3. **With nothing configured the request is unattributed** (the default). Rate limits and quotas use the single
   shared key `unattributed`, and IP allowlists never match it. Production without `TRUSTED_PROXIES` is therefore
   throttled as one client (the edge middleware logs a one-time warning) rather than trusting spoofable headers.
4. When the socket peer is known (`peerIp`), an untrusted peer is the client and its headers are ignored. A
   trusted peer defaults to loopback and private ranges when `TRUSTED_PROXIES` is unset.
5. `CF-Connecting-IP` is honoured only with `TRUSTED_CDN=cloudflare` and only when the nearest hop is inside the
   Cloudflare ranges (shipped in `CLOUDFLARE_IP_RANGES`; override with `TRUSTED_CDN_RANGES`). Cloudflare edge
   addresses are also treated as skippable hops while walking `X-Forwarded-For`.
6. If both `X-Forwarded-For` and `Forwarded` (RFC 7239) are present they must agree on the client, otherwise the
   request is unattributed. Placeholder hops (`unknown`, obfuscated `_token`) also yield `unattributed`.

## Operator checklist

- Firewall the origin so only the declared proxy hops can reach it. In headers-only mode the declaration is a
  promise, not something the server can verify.
- The proxy must append to, not trust, an incoming `X-Forwarded-For`
  (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).

## Configuration

| Variable | Meaning |
| --- | --- |
| `TRUSTED_PROXIES` | Comma-separated CIDRs or addresses of trusted hops (at most 256). Setting it declares a front proxy. |
| `TRUSTED_CDN` | `cloudflare`. Enables `CF-Connecting-IP` for a verified edge hop. |
| `TRUSTED_CDN_RANGES` | CIDR list replacing the shipped ranges for the configured CDN. Requires `TRUSTED_CDN`. |

## Failure modes

- Malformed forwarding data from a trusted sender (not an address, empty hop, header over 4096 characters, more
  than 32 hops) is rejected with HTTP 400 (`InvalidForwardingHeaderError`).
- Malformed trust configuration is rejected with HTTP 500 (`ClientIpConfigError`) and logged.
- Addresses are validated and canonicalised (ports and brackets stripped, IPv4-mapped IPv6 folded to IPv4, IPv6
  in RFC 5952 form) so alternate spellings share one rate-limit identity.
