
imagehoster
===========

Hive-powered image hosting and proxying service.


Developing
----------

With node.js and [pnpm](https://pnpm.io) installed, run:

```
git submodule update --init
make devserver
```

This will pull in all dependencies and spin up a hot-reloading development server.

Dependencies are managed with pnpm (`pnpm-lock.yaml`). `pnpm-workspace.yaml` links
to the pnpm catalogs of hive/common-ci-configuration (the `npm-common-config`
submodule), the one place hive apps pin shared packages; a package listed there,
such as `typescript`, is referenced in `package.json` as `catalog:<name>`.

Run `make lint` to run the autolinter, `make test` to run the unit tests.


Deployment
----------

See `docker-compose.example.yml` for a production-like setup. The `Dockerfile`
takes its Node version as the `NODE_VERSION` build arg, which CI sets from
hive/common-ci-configuration; build locally with e.g.
`docker build --build-arg NODE_VERSION=24 .` (with the `npm-common-config` submodule
checked out; the build takes its pnpm version and catalogs from it). The image is built
by CI and pushed to `registry.gitlab.syncad.com/hive/imagehoster` with tags:

  * `<commit-sha>` — every build
  * `latest` — from the `develop` branch
  * `stable` — from the `master` branch

### Image processing memory

The image is based on Debian slim (glibc) rather than Alpine (musl) and preloads
jemalloc (`LD_PRELOAD`) for the service, as sharp recommends for long-running
multi-threaded processes on glibc. On Alpine, resize workers grew by gigabytes of
native memory over weeks of production traffic.

Each worker process runs its own pool of libvips threads, which by default has one
thread per CPU core. `vips_concurrency` (env `VIPS_CONCURRENCY`, default `4`) caps
that pool per worker; `0` keeps sharp's default. libvips also reads
`VIPS_CONCURRENCY` itself, so both agree.

### Empty stored results

A stored resized result with no content is treated as missing: the proxy logs a
warning with its key, regenerates it and overwrites it. An empty original or
resized result is never written. Older deployments could leave zero-byte resized
results behind when a resize failed after the key was created; with an fs proxy
store, list and delete them with

```sh
find <proxy_store.path> -type f -size 0 -print -delete
```

(drop `-delete` to only list them). On img2 the store has ~3,400 partition
directories on spinning disks, so the sweep takes hours. Empty responses that
were already served are cached by Cloudflare for a year; those URLs need a purge
as well.

### Avatar and cover caching

The `/u/<username>/avatar[/<size>]` and `/u/<username>/cover` redirects are sent
with `Cache-Control: public, s-maxage=86400, max-age=600`. Cloudflare uses
`s-maxage` and keeps the redirect for a day; `cf-cache-purger` purges these URLs
within seconds of an account's `account_update2`, so the day is only the fallback
for the purger being down. Browsers ignore `s-maxage` and recheck after 10 minutes,
which is answered from the edge, so a changed avatar or cover shows everywhere
within 10 minutes without extra origin requests. Without the purger the edge can
serve an old image for up to a day. Showing the new image immediately to the user
who just edited their profile (a cache-bust after the save) is the UI's job.

### Proxy whitelist

The proxy endpoint can optionally restrict service to URLs that have been
referenced on the Hive blockchain. This requires the
[proxy-whitelist](https://gitlab.syncad.com/hive/proxy-whitelist) HAF app
running with PostgREST. Enable it in config:

```toml
[whitelist]
enabled = true
apiUrl = 'https://your-api-server/proxy-whitelist-api'
```

Or via env var: `WHITELIST_API_URL=https://...`

### Blacklist

A dynamic blacklist file can block specific URLs and URL patterns. The file
is hot-reloaded on change. See `blacklist.example.json` for the format:

```json
{
  "urls": ["https://example.com/specific-image.jpg"],
  "patterns": ["^https?://([^/]*\\.)?bad-domain\\.com/"]
}
```

Configure the path in your config file under `blacklist.imageBlackList`.


Configuration
-------------

Defaults are in <./config/default.toml> and can be overridden by env vars as defined in <./config/custom-environment-variables.toml>

Load order is: env vars > `config/$NODE_ENV.toml` > `config/default.toml`

See the `config` module docs for more details.

### Worker processes

With `num_workers` other than 1 (`NUM_WORKERS`, 0 = one per CPU) the service runs as a cluster master
supervising that many workers:

* A worker that dies is logged (`worker died, respawning`, with its exit code and signal) and replaced.
* More than 5 worker deaths within 60 seconds is treated as a crash loop: the master logs an error
  (`... worker deaths within 60 s, not respawning ...`), stops the remaining workers and **exits with
  code 1**, so the container's restart policy restarts the whole service rather than leaving a master
  without workers.
* Every `worker_rss_check_interval_ms` (`WORKER_RSS_CHECK_INTERVAL_MS`, default 30000) the master reads
  each worker's resident plus swapped memory from `/proc/<pid>/status`. A worker above
  `worker_max_rss_mb` (`WORKER_MAX_RSS_MB`, default 4096, 0 = disabled) is recycled: a replacement is
  started, and once it listens the old worker is sent SIGTERM. A worker that got SIGTERM stops
  accepting connections, finishes its in-flight requests, answers any further request on a
  keep-alive connection with `Connection: close`, and exits once its idle connections have reached
  the keep-alive timeout (5 s).
  One worker is recycled at a time, logged as `worker memory over limit, recycling` with `rss_mb` and
  `swap_mb`.
* A worker asked to stop that has not exited after `worker_stop_timeout_ms` (`WORKER_STOP_TIMEOUT_MS`,
  default 30000) is killed with SIGKILL (`worker did not stop in time, killing it`).
* On SIGTERM or SIGINT the master stops all workers the same way, respawns none, and exits 0.


API
---

Responses should be determined by the Content-Type header, errors will have a status of `>=400` and a Content-Type of `application/json` with the body in the format:

```json
{
    "error": {
        "name": "error_name",
        "info": {"optional": "metadata"}
    }
}
```

#### `POST /<username>/<signature>` - upload an image.

Multipart image upload, will only consider first file if there are multiple.

Returns a JSON object containing the url to the uploaded image, example:

```json
{
    "url": "https://images.example.com/DQmZi174Xz96UrRVBMNRHb6A2FfU3z1HRPwPPQCgSMgdiUT/test.jpg"
}
```

Requires a signature from a Hive account in good standing, see the "Signing uploads" section below for more information.

#### `POST /hs/<accesstoken>` - upload an image with Hivesigner accessToken.

Multipart image upload, will only consider first file if there are multiple.

Returns a JSON object containing the url to the uploaded image, example:

```json
{
    "url": "https://images.example.com/DQmZi174Xz96UrRVBMNRHb6A2FfU3z1HRPwPPQCgSMgdiUT/test.jpg"
}
```

Requires a access token from a Hivesigner authorized account, for more info: https://hivesigner.com.


#### `GET /<image_hash>/[<filename>]` - fetch an uploaded image.

Download a previously uploaded image.

`filename` is optional but can be provided to help users and applications understand the content type (Content-Type header will still always reflect actual image type).


#### `GET /p/<b58_image_url>[?options]` - proxy and resize an image.

Downloads and serves the provided image, note that a copy will be taken of the image and that will be served on subsequent requests so even if the upstream is removed or changes you will still get the original from the proxy endpoint.

A fetch that returns fewer bytes than its `Content-Length` announced (without a `Content-Encoding`) fails with `upstream_error` and is not stored. A stored copy that cannot be decoded (for example one truncated by an earlier partial fetch) is fetched again from the upstream once and, if the new copy decodes, replaced by it; if the upstream fails or its copy does not decode either, the error is returned and the stored copy is kept so a later request retries. Images that decode with only a decoder warning (such as some camera JPEGs with invalid SOS parameters) are served normally. Uploaded images are never refetched.

##### Params

  * `b58_image_url` - [Base58](https://en.wikipedia.org/wiki/Base58) encoded utf8 string containing the url to the image you wish to proxy.

##### Options

The options are set as query-strings and control how the image is transformed before being proxied.

  * `width` - Desired image width.
  * `height` - Desired image height.
  * `mode` - Resizing mode.
    * `cover` *default* - When set the image will be center cropped if the original aspect ratio does not match the aspect ratio of the upstream image.
    * `fit` - Does not crop the image, it will always keep the upstream aspect ratio and resized to fit within the width and height given.
  * `format` - Output image encoding.
    * `match` *default* - Matches the encoding of the upstream image.
    * `jpeg` - Use JPEG encoding.
    * `png` - Use PNG encoding.
    * `webp` - Use WebP encoding.

If only `width` or `height` are given their counterpart will be calculated based on the upstream image aspect ratio.

##### Examples

Upstream image: `https://ipfs.io/ipfs/QmXa4dAFEhGEuZaX7uUSEvBjbEY5mPxkaS2zHZSnHvocpn` (Base58 encoded `46aP2QbqUqBqwzwxM6L1P6uLNceBDDCM9ZJdv282fpHyc9Wgcz1FduB11aVXtczv9TiCSHF1eEmnRSSdQWQEXA5krJNq`)

Proxy the image as-is:
```
https://steemitimages.com/p/46aP2QbqUqBqwzwxM6L1P6uLNceBDDCM9ZJdv282fpHyc9Wgcz1FduB11aVXtczv9TiCSHF1eEmnRSSdQWQEXA5krJNq
```

Center cropped 512x512px avatar image in WebP format:
```
https://steemitimages.com/p/46aP2QbqUqBqwzwxM6L1P6uLNceBDDCM9ZJdv282fpHyc9Wgcz1FduB11aVXtczv9TiCSHF1eEmnRSSdQWQEXA5krJNq?width=512&height=512&format=webp
```

Aspect resized image fitting inside a 200x500px container:
```
https://steemitimages.com/p/46aP2QbqUqBqwzwxM6L1P6uLNceBDDCM9ZJdv282fpHyc9Wgcz1FduB11aVXtczv9TiCSHF1eEmnRSSdQWQEXA5krJNq?width=200&height=500&mode=fit
```

Aspect resized image with variable width and a height of max 100px:
```
https://steemitimages.com/p/46aP2QbqUqBqwzwxM6L1P6uLNceBDDCM9ZJdv282fpHyc9Wgcz1FduB11aVXtczv9TiCSHF1eEmnRSSdQWQEXA5krJNq?&height=100
```

#### `GET /<width>x<height>/<image_url>` - proxy and resize an image.

## DEPRECATED

Downloads and serves the provided `image_url`, note that a copy will be taken of the image and that will be served on subsequent requests so even if the upstream is removed or changes you will still get the original from the proxy endpoint.

`width` and `height` can be set to `0` to preserve the image dimensions, if they are `>0` the image will be aspect resized (down-sample only) to fit inside the rectangle.

#### `GET /u/<username>/avatar/[<size>]` - get user avatar image.

Serves the avatar for `username`, if no avatar is set a default image will be served (set in service config).

Sizes are:

  * `small` - 64x64
  * `medium` - 128x128
  * `large` - 512x512

Note that the avatars follow the same sizing rules as proxied images, so you are not guaranteed to get a square image, just an image fitting inside of the `size` square.


Signing uploads
---------------

Uploads require a signature made with by a Hive account's posting authority, further that account has to be above a (service configurable) reputation threshold.

Creating a signature (psuedocode):

```python
signature = secp256k1_sign(sha256('ImageSigningChallenge'+image_data), account_private_posting_key)
```

Creating a signature (node.js & [dhive](https://github.com/openhive-network/dhive))

```js
#!/usr/bin/env node

const dhive = require('@hiveio/dhive')
const crypto = require('crypto')
const fs = require('fs')

const [wif, file] = process.argv.slice(2)

if (!wif || !file) {
    process.stderr.write(`Usage: ./sign.js <posting_wif> <file>\n`)
    process.exit(1)
}

const data = fs.readFileSync(file)
const key = dhive.PrivateKey.fromString(wif)
const imageHash = crypto.createHash('sha256')
    .update('ImageSigningChallenge')
    .update(data)
    .digest()

process.stdout.write(key.sign(imageHash).toString() + '\n')
```

```sh
$ ./sign.js 5J9jN691Gf3MKdwvqWVx54drx9qub6koyA3mjhenyN12CURua8W test.jpg
1f78d007a0b12cd17f2d349446c3f9b7cfa096ae53903a11608d6232781fb994a2086263f21e4da831d2a2b0b372f701b83042a629ba3d87791d05f393d5504db2
```


Proxy auth tokens
-----------------

When the proxy whitelist is enabled, images not yet referenced on the blockchain are blocked. To allow editor previews of not-yet-published images, a client can obtain a short-lived auth token by proving ownership of a Hive posting key.

#### `POST /proxy-auth/<username>/<signature>` - obtain a proxy auth token.

The request body must be JSON containing a `timestamp` field (milliseconds since epoch). The timestamp must be within 5 minutes of the server's clock.

The signature is over a challenge string (pseudocode):

```python
challenge = 'Authorize image proxy preview for ' + username + ' at ' + iso8601(timestamp)
signature = secp256k1_sign(sha256(challenge), account_private_posting_key)
```

Creating a signature (node.js & [dhive](https://github.com/openhive-network/dhive)):

```js
const dhive = require('@hiveio/dhive')
const crypto = require('crypto')

const username = 'alice'
const timestamp = Date.now()
const challenge = `Authorize image proxy preview for ${username} at ${new Date(timestamp).toISOString()}`
const challengeHash = crypto.createHash('sha256').update(challenge).digest()

const key = dhive.PrivateKey.fromString(postingWif)
const signature = key.sign(challengeHash).toString()

// POST /proxy-auth/alice/<signature> with body: {"timestamp": <timestamp>}
```

Returns a JSON object:

```json
{
    "token": "<hex_token>",
    "expires_in": 1800
}
```

The token is valid for 30 minutes. Pass it as a `token` query parameter on proxy requests to bypass the whitelist:

```
https://images.example.com/p/<b58_image_url>?token=<hex_token>
```

The same account requirements apply as for uploads: the account must not be blacklisted and must meet the minimum reputation threshold.
