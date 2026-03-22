# Imagehoster - CLAUDE.md

## Project Overview

Image hosting and proxy service for the Hive blockchain ecosystem. Provides:

- **Image uploads** with cryptographic signature verification against Hive blockchain accounts
- **Image proxy** for external URLs referenced in Hive content, with resizing and format conversion
- **Avatar/cover** endpoints that resolve user profile images from on-chain metadata
- **Legacy proxy** compatibility with the older `/{W}x{H}/{url}` format

Serves `images.hive.blog`.

## Tech Stack

- **Runtime:** Node.js 18+ (TypeScript)
- **Framework:** Koa v2 with koa-router, async/await
- **Image Processing:** Sharp (libvips-based) — resize, format conversion, quality control
- **Storage:** Abstract blob store (S3 in production, fs or memory for dev)
- **Rate Limiting:** Redis (for upload rate limiting)
- **Blockchain:** @hiveio/dhive for account lookups and signature verification
- **Containerization:** Docker

## Directory Structure

```
src/
├── app.ts              # Koa application setup, middleware chain
├── routes.ts           # Route registration (all endpoints)
├── proxy.ts            # Image proxy handler (/p/ endpoint)
├── legacy-proxy.ts     # Legacy proxy redirects (/{W}x{H}/{url} → /p/)
├── avatar.ts           # Avatar endpoint (/u/:username/avatar)
├── cover.ts            # Cover image endpoint (/u/:username/cover)
├── upload.ts           # Upload handlers (signature, HiveSigner, checksum)
├── serve.ts            # Serve uploaded images (/:hash)
├── blacklist.ts        # URL and account blacklists
├── common.ts           # Shared instances (RPC client, Redis, blob stores)
├── error.ts            # APIError class and error middleware
├── logger.ts           # Bunyan logging and request logger middleware
├── utils.ts            # Base58 encoding, MIME detection, store helpers
└── version.ts          # Build version

config/
├── default.toml                    # Default configuration
├── production.toml                 # Production overrides
└── custom-environment-variables.toml  # Env var → config mapping

test/
├── app.ts              # Healthcheck tests
├── proxy.ts            # Proxy endpoint tests
├── upload.ts           # Upload tests
├── utils.ts            # Utility function tests
├── common.ts           # Test helpers
└── test.jpg            # Test fixture
```

## Development Commands

```bash
# Install dependencies
yarn install

# Build TypeScript
make lib

# Run tests
make ci-test

# Run development server
node lib/app.js
# Or with ts-node:
ts-node src/app.ts
```

## API Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/` | GET | No | Healthcheck |
| `/.well-known/healthcheck.json` | GET | No | Healthcheck |
| `/p/:url` | GET | No | Proxy/resize external image (Base58-encoded URL) |
| `/:width(\d+)x:height(\d+)/:url(.*)` | GET | No | Legacy proxy → 301 to `/p/` |
| `/u/:username/avatar/:size?` | GET | No | User avatar → 302 to `/p/` |
| `/u/:username/cover` | GET | No | User cover → 302 to `/p/` |
| `/:hash/:filename?` | GET | No | Serve uploaded image |
| `/:username/:signature` | POST | Posting key | Upload image (signature-based) |
| `/cs/:username/:signature` | POST | Posting key | Upload image (checksum signature) |
| `/hs/:accesstoken` | POST | HiveSigner | Upload image (HiveSigner token) |

### Proxy URL Format

External URLs are Base58-encoded in the path:
```
/p/{base58(url)}?width=W&height=H&mode=cover|fit&format=match|jpeg|png|webp
```

### Upload Key Format

Uploaded images are keyed by content hash:
- Prefix `D` + Base58(multihash(SHA256(`ImageSigningChallenge` + data)))
- Example: `DQmb2HNSGKN3pakguJ4ChCRjgkVuDN9WniFRPmrxoJ4sjR4`

### Proxy Cache Key Format

Proxied images are keyed by URL hash:
- Prefix `U` + Base58(multihash(SHA1(url)))
- Resize variants: `{key}_{width}x{height}` or `{key}_{mode}_{format}[_{w}][_{h}]`

## Configuration

Configuration uses [node-config](https://github.com/node-config/node-config) with TOML files.

Key settings in `config/default.toml`:

| Setting | Default | Purpose |
|---------|---------|---------|
| `port` | 8800 | Listen port |
| `proxy` | false | Trust X-Forwarded-For (set true behind reverse proxy) |
| `rpc_node` | `https://api.hive.blog` | Hive RPC endpoint |
| `max_image_size` | 15000000 | Max image size in bytes (15MB) |
| `proxy_store.type` | memory | Proxy cache backend (memory/fs/s3) |
| `upload_store.type` | memory | Upload backend (memory/fs/s3) |
| `proxy_store.max_image_width` | 1280 | Default max width for proxied images |
| `proxy_store.max_image_height` | 8000 | Default max height for proxied images |

Environment variable overrides defined in `config/custom-environment-variables.toml`.

## Coding Conventions

- **TypeScript** with strict compilation
- **Async/await** for all async operations
- **Koa v2 middleware** pattern
- **Bunyan** structured logging (JSON format)
- Error responses: `{ error: { name: "snake_case_error", info: {...} } }`
- Image MIME types detected via magic bytes, not file extensions
- Accepted proxy formats: `image/gif`, `image/jpeg`, `image/png`, `image/webp`, `image/svg+xml`

## Branch History

- **`develop`** — Current active branch (TypeScript/Koa v2 rewrite)
- **`master`** — Mirror of develop
- **`legacy-develop`** — Archived original JavaScript codebase (Node.js 6, Koa v1, Tarantool rate limiting). Preserved for historical reference.

## CI/CD

Docker image built from `Dockerfile`. Multi-stage build:
1. Build stage: install deps, compile TypeScript, run tests
2. Production stage: minimal Alpine image with compiled JS

## Testing

```bash
# Run all tests
make ci-test

# Tests use in-memory blob stores (no S3 needed)
# A local HTTP server is spun up to serve test fixtures
```

Tests cover: healthcheck, proxy (including resize, format conversion, double-proxy resolution, legacy format), uploads, and utility functions.
