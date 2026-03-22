
imagehoster
===========

Hive-powered image hosting and proxying service.


Developing
----------

With node.js installed, run:

```
make devserver
```

This will pull in all dependencies and spin up a hot-reloading development server.

Run `make lint` to run the autolinter, `make test` to run the unit tests.


Deployment
----------

See `docker-compose.example.yml` for a production-like setup. The image is built
by CI and pushed to `registry.gitlab.syncad.com/hive/imagehoster` with tags:

  * `<commit-sha>` — every build
  * `latest` — from the `develop` branch
  * `stable` — from the `master` branch

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
