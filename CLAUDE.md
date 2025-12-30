# Imagehoster - CLAUDE.md

## Project Overview

Blockchain-based image hosting and proxy service for the Steem blockchain. Enables users to:

- **Upload images** with cryptographic signature verification against blockchain accounts
- **Serve images** with automatic resizing and thumbnail generation
- **Proxy external images** with caching and optimization
- **Manage quotas** via IP-based and data-based rate limiting

Key security features: ECC signature verification, EXIF metadata removal, reputation-based upload restrictions, rate limiting via Tarantool.

## Tech Stack

- **Runtime:** Node.js 6 (ES2015 with Babel transpilation)
- **Framework:** Koa v1.2.4 with koa-router
- **Image Processing:** Sharp (libvips-based)
- **Storage:** AWS S3 (separate buckets for uploads, web, thumbnails)
- **Rate Limiting:** Tarantool in-memory database
- **Cryptography:** ECC (ecurve, bigi, bs58), IPFS multihash encoding
- **Containerization:** Docker, Docker Compose

## Directory Structure

```
imagehoster/
├── app/server/           # Core application
│   ├── server.js         # Entry point, Koa app setup
│   ├── upload-data.js    # Upload handler with signature verification
│   ├── data-server.js    # Download/retrieval handler
│   ├── image-proxy.js    # Image resizing & external proxying
│   ├── amazon-bucket.js  # S3 wrapper functions
│   ├── tarantool.js      # Rate limiting client
│   ├── exif-utils.js     # EXIF data handling
│   └── utils.js          # Reputation calculation
├── config/
│   ├── index.js          # Main configuration
│   └── env_example.sh    # Environment variable template
├── shared/
│   ├── ecc/              # ECC cryptography library (separate npm module)
│   └── api_client/       # Blockchain API client
├── assets/               # Static assets (missing.png)
└── Dockerfile            # Node 6 container

ttdatastore/              # Tarantool quota database
├── quota.lua             # Rate limiting logic
├── app.lua               # Schema & initialization
└── Dockerfile            # Tarantool 1.7 container
```

## Development Commands

```bash
# Install dependencies
cd imagehoster && npm install

# Start development server (requires Tarantool)
export STEEMIT_UPLOAD_TEST_KEY=true
source ./config/env_example.sh  # or env_prod.sh
npm start

# Run tests (ECC module)
npm test

# Docker-based development
docker-compose up

# Start Tarantool separately
cd ttdatastore && tarantool ./app.lua
```

## Key Files

| File | Purpose |
|------|---------|
| `imagehoster/app/server/server.js` | Application entry point |
| `imagehoster/config/index.js` | Configuration (ports, S3, Tarantool, WebSocket) |
| `docker-compose.yml` | Multi-container orchestration |
| `ttdatastore/quota.lua` | Rate limiting logic |
| `imagehoster/shared/ecc/` | Cryptographic signature verification |

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Status check |
| `/healthcheck` | GET | Health endpoint |
| `/:username/:signature` | POST | Upload image with signature |
| `/:hash/:filename?` | GET | Retrieve uploaded image |
| `/:width(\d+)x:height(\d+)/:url(.*)` | GET | Proxy/resize external image |

## Coding Conventions

- **ES2015 syntax** with Babel transpilation (import/export, arrow functions, destructuring)
- **Generator functions** (`function*`) for Koa v1 async middleware pattern
- **Modular organization** - separate files for routes, utilities, config
- **Error responses** - consistent `{error: message}` JSON with 400 status
- **Logging** - console.error for errors, console.log for info
- **Validation** - input validation before processing, MIME type checks (GIF, JPEG, PNG)

## Configuration

Key environment variables (see `config/env_example.sh`):

```bash
AWS_ACCESS_KEY_ID        # AWS credentials
AWS_SECRET_ACCESS_KEY
STEEMIT_UPLOAD_STEEMD_WEBSOCKET  # Blockchain node (default: wss://node.steem.ws)
STEEMIT_UPLOAD_TEST_KEY  # Enable test mode (skip signature verification)
```

Config defaults (`config/index.js`):
- HTTP port: 3234
- Tarantool: localhost:3301
- Min reputation to upload: 10

## CI/CD Notes

No GitLab CI configuration present. Deployment relies on Docker:

```bash
# Build and run containers
docker-compose up --build

# Services exposed:
# - imagehoster: port 80
# - ttdatastore: port 3301
```

GitLab project ID: 212 (per global CLAUDE.md)
