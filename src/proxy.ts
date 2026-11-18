/** Resizing image proxy. */

import {AbstractBlobStore} from 'abstract-blob-store'
import config from 'config'
import {createHash} from 'crypto'
import * as http from 'http'
import * as multihash from 'multihashes'
import * as needle from 'needle'
import Sharp from 'sharp'
import streamHead from 'stream-head/dist-es6'
import {URL} from 'url'

import * as opentracing from 'opentracing'

import {imageBlacklist} from './blacklist'
import {getKeyNameFromHash, KoaContext, proxyStore, uploadStore} from './common'
import {APIError} from './error'
import {assertAcceptedImage} from './image-policy'
import {assertPublicUrl, base58Dec, mimeMagic, readStream, storeExists, storeWrite} from './utils'
import {domainAllowlist} from './allowlist'
import {checkUrl, validateProxyAuthToken} from './whitelist'

let tracer: opentracing.Tracer
if (process.env.JAEGER_SERVICE_NAME) {
    const jaegerClient = require('jaeger-client')
    tracer = jaegerClient.initTracerFromEnv({}, {})
} else {
    tracer = new opentracing.Tracer()
}

const MAX_IMAGE_SIZE = Number.parseInt(config.get('max_image_size'))
if (!Number.isFinite(MAX_IMAGE_SIZE)) {
    throw new Error('Invalid max image size')
}
const SERVICE_URL = new URL(config.get('service_url'))

// Sharp defaults to one libvips thread per core in every worker process;
// 0 keeps that default.
const VIPS_CONCURRENCY = Number(config.get('vips_concurrency'))
if (!Number.isInteger(VIPS_CONCURRENCY) || VIPS_CONCURRENCY < 0) {
    throw new Error('Invalid vips concurrency')
}
if (VIPS_CONCURRENCY > 0) {
    Sharp.concurrency(VIPS_CONCURRENCY)
}

interface NeedleResponse extends http.IncomingMessage {
    body: any
    raw: Buffer
    bytes: number
    cookies?: {[name: string]: any}
}

/** A response body shorter than its Content-Length announced. */
class ShortResponseError extends Error {
    constructor(public readonly expectedBytes: number | undefined, public readonly receivedBytes: number) {
        super(`Received ${ receivedBytes } of ${ expectedBytes === undefined ? 'unknown' : expectedBytes } bytes`)
        this.name = 'ShortResponseError'
    }
}

function announcedLength(res: http.IncomingMessage) {
    const length = Number(res.headers['content-length'])
    return Number.isInteger(length) ? length : undefined
}

function fetchUrlOnce(url: string, options: needle.NeedleOptions) {
    return new Promise<NeedleResponse>((resolve, reject) => {
        const request = needle.get(url, options, (error, response) => {
            if (error) {
                reject(error)
                return
            }
            // With a Content-Encoding the announced length is that of the
            // encoded body, which response.bytes does not necessarily match.
            const expectedBytes = announcedLength(response)
            if (!response.headers['content-encoding'] && expectedBytes !== undefined && response.bytes < expectedBytes) {
                reject(new ShortResponseError(expectedBytes, response.bytes))
                return
            }
            resolve(response)
        })
        // needle neither finishes nor fails when the connection closes early,
        // it waits for its read timeout instead.
        request.on('response', (res: http.IncomingMessage & {req: http.ClientRequest}) => {
            let receivedBytes = 0
            res.on('data', (chunk: Buffer) => { receivedBytes += chunk.length })
            res.once('close', () => {
                if (!res.complete) {
                    // abort() rather than destroy(): it is what clears needle's timer
                    res.req.abort()
                    reject(new ShortResponseError(announcedLength(res), receivedBytes))
                }
            })
        })
    })
}

/**
 * Fetch a URL, following redirects manually so we can check each
 * hop against the SSRF blocklist. Without this, an attacker can
 * redirect from a public URL to an internal one.
 */
async function fetchUrl(url: string, options: needle.NeedleOptions, skipSsrfCheck: boolean = false) {
    const maxRedirects = 5
    // Disable needle's built-in redirect following
    const opts = {...options, follow_max: 0}
    let currentUrl = url
    for (let i = 0; i <= maxRedirects; i++) {
        if (!skipSsrfCheck) {
            await assertPublicUrl(new URL(currentUrl))
        }
        const res = await fetchUrlOnce(currentUrl, opts)
        const status = res.statusCode || 0
        if (status >= 301 && status <= 308 && res.headers.location) {
            currentUrl = new URL(res.headers.location, currentUrl).toString()
            continue
        }
        return res
    }
    throw new Error('Too many redirects')
}

enum ScalingMode {
    /**
     * Scales the image to cover the rectangle defined by width and height.
     * Any overflow will be cropped equally on all sides (center weighted).
     */
    Cover,
    /**
     * Scales the image to fit into the rectangle defined by width and height.
     * This mode will only downsample.
     */
    Fit,
}

enum OutputFormat {
    /** Matches the input format, default. */
    Match,
    JPEG,
    PNG,
    WEBP,
}

interface ProxyOptions {
    /** Image width, if unset min(orig_width, max_image_width) will be used. */
    width?: number
    /** Image height, if unset min(orig_height, max_image_height) will be used. */
    height?: number
    /** Scaling mode to use if the image has to be resized. */
    mode: ScalingMode
    /** Output format for the proxied image. */
    format: OutputFormat
}

function parseUrl(value: string): URL {
    let url: URL
    try {
        url = new URL(base58Dec(value))
    } catch (cause) {
        if (!(cause instanceof Error)) {
            cause = Error('unexpected error')
        }
        throw new APIError({cause: cause as Error, code: APIError.Code.InvalidProxyUrl})
    }
    return url
}

function parseOptions(query: {[key: string]: any}): ProxyOptions {
    const width = Number.parseInt(query['width']) || undefined
    const height = Number.parseInt(query['height']) || undefined
    let mode: ScalingMode
    switch (query['mode']) {
    case undefined:
    case 'cover':
        mode = ScalingMode.Cover
        break
    case 'fit':
        mode = ScalingMode.Fit
        break
    default:
        throw new APIError({message: 'Invalid scaling mode', code: APIError.Code.InvalidParam})
    }
    let format: OutputFormat
    switch (query['format']) {
    case undefined:
    case 'match':
        format = OutputFormat.Match
        break
    case 'jpeg':
    case 'jpg':
        format = OutputFormat.JPEG
        break
    case 'png':
        format = OutputFormat.PNG
        break
    case 'webp':
        format = OutputFormat.WEBP
        break
    default:
        throw new APIError({message: 'Invalid output format', code: APIError.Code.InvalidParam})
    }
    return {width, height, mode, format}
}

function getImageKey(origKey: string, options: ProxyOptions): string {
    if (options.mode === ScalingMode.Fit && options.format === OutputFormat.Match) {
        // follow legacy key convention where possible
        return `${ origKey }_${ options.width || 0 }x${ options.height || 0 }`
    }
    const rv = [origKey, ScalingMode[options.mode], OutputFormat[options.format]]
    if (options.width) {
        rv.push(options.width.toFixed(0))
    }
    if (options.height) {
        rv.push(options.height.toFixed(0))
    }
    return rv.join('_')
}

export function safeParseInt(value: any): number | undefined {
    // If the number can't be parsed (like if it's `nil` or `undefined`), then
    // `basicNumber` will be `NaN`.
    const basicNumber = parseInt(value, 10)
    return isNaN(basicNumber) ? undefined : basicNumber
}

interface EncodedImage {
    data: Buffer
    contentType: string
}

/**
 * Fetch an original from its source. Throws UpstreamError when the source
 * cannot be reached or sends less than it announced, InvalidImage for a
 * non-2xx response or an unaccepted format, PayloadTooLarge above
 * MAX_IMAGE_SIZE.
 */
async function fetchOriginal(ctx: KoaContext, url: URL, origKey: string, span: opentracing.Span): Promise<EncodedImage> {
    const skipSsrf = process.env.NODE_ENV === 'test'
    let res: NeedleResponse
    try {
        res = await fetchUrl(url.toString(), {
            open_timeout: 5 * 1000,
            response_timeout: 5 * 1000,
            read_timeout: 60 * 1000,
            compressed: true,
            parse_response: false,
            user_agent: 'HiveProxy/1.0 (+https://gitlab.syncad.com/hive/imagehoster)'
        } as any, skipSsrf)
    } catch (cause) {
        span.setTag(opentracing.Tags.ERROR, true)
        span.finish()
        if (cause instanceof ShortResponseError) {
            ctx.log.warn({
                orig_key: origKey,
                url: url.toString(),
                expected_bytes: cause.expectedBytes,
                received_bytes: cause.receivedBytes
            }, 'short fetch of %s, not storing it', origKey)
        }
        if (!(cause instanceof Error)) {
            cause = Error('unexpected error')
        }
        throw new APIError({cause: cause as Error, code: APIError.Code.UpstreamError})
    }

    APIError.assert(res.bytes <= MAX_IMAGE_SIZE, APIError.Code.PayloadTooLarge)
    APIError.assert(Buffer.isBuffer(res.body), APIError.Code.InvalidImage)

    if (Math.floor((res.statusCode || 404) / 100) !== 2) {
        throw new APIError({code: APIError.Code.InvalidImage})
    }

    return {data: res.body, contentType: await assertAcceptedImage(res.body)}
}

/**
 * Resize and re-encode an original as the options ask. Throws when the
 * original does not decode: InvalidImage when its header cannot be read,
 * Sharp's error when its data cannot.
 */
async function convertImage(origData: Buffer, origContentType: string, options: ProxyOptions): Promise<EncodedImage> {
    let contentType = origContentType
    // 'error' rather than the default 'warning' lets libjpeg warnings (invalid
    // SOS parameters, extraneous bytes) decode, while truncated data still throws.
    const image = Sharp(origData, {failOn: 'error'}).jpeg({
        quality: 85,
        force: false
    }).png({
        compressionLevel: 9,
        force: false
    }).webp({
        alphaQuality: 100,
        force: false
    })

    let metadata: Sharp.Metadata
    try {
        metadata = await image.metadata()
    } catch (cause) {
        if (!(cause instanceof Error)) {
            cause = Error('unexpected error')
        }
        throw new APIError({cause: cause as Error, code: APIError.Code.InvalidImage})
    }

    APIError.assert(metadata.width && metadata.height, APIError.Code.InvalidImage)

    const maxWidth: number = safeParseInt(config.get('proxy_store.max_image_width')) || 1280
    const maxHeight: number = safeParseInt(config.get('proxy_store.max_image_height')) || 8000
    const maxCustomWidth: number = safeParseInt(config.get('proxy_store.max_custom_image_width')) || 8000
    const maxCustomHeight: number = safeParseInt(config.get('proxy_store.max_custom_image_height')) || 8000
    let width: number | undefined = safeParseInt(options.width)
    let height: number | undefined = safeParseInt(options.height)

    // If no width and height are provided, it will use the default image
    // width and height, but cap it to the config-provided max image width
    // and height. This is so we can save on bandwidth for the default case.
    //
    // If width and height are provided, it will use the provided width and
    // height. This is so clients who need a higher-res image can still get
    // one.
    if (width) {
        if (width > maxCustomWidth) { width = maxCustomWidth }
    } else {
        if (metadata.width && metadata.width > maxWidth) { width = maxWidth }
    }
    if (height) {
        if (height > maxCustomHeight) { height = maxCustomHeight }
    } else {
        if (metadata.height && metadata.height > maxHeight) { height = maxHeight }
    }

    switch (options.mode) {
    case ScalingMode.Cover:
        image.rotate().resize(width, height, {fit: 'cover'})
        break
    case ScalingMode.Fit:
        if (!width) { width = maxWidth }
        if (!height) { height = maxHeight }

        image.rotate().resize(width, height, { fit: 'inside', withoutEnlargement: true })
        break
    }

    switch (options.format) {
    case OutputFormat.Match:
        break
    case OutputFormat.JPEG:
        image.jpeg({force: true})
        contentType = 'image/jpeg'
        break
    case OutputFormat.PNG:
        image.png({force: true})
        contentType = 'image/png'
        break
    case OutputFormat.WEBP:
        contentType = 'image/webp'
        image.webp({force: true})
        break
    }

    return {data: await image.toBuffer(), contentType}
}

function decoderMessage(error: unknown): string {
    if (error instanceof APIError && error.cause) {
        return error.cause.message
    }
    return error instanceof Error ? error.message : String(error)
}

export async function proxyHandler(ctx: KoaContext) {
    const myContext = tracer.extract(opentracing.FORMAT_HTTP_HEADERS, ctx.headers)
    const proxyHandlerSpan = tracer.startSpan('proxyHandler', {childOf: myContext ? myContext : undefined})
    ctx.tag({handler: 'proxy'})

    APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
    APIError.assertParams(ctx.params, ['url'])

    const options = parseOptions(ctx.query)
    let url = parseUrl(ctx.params.url)

    // console.log('url is: ',url);

    // resolve double proxied images
    while (url.origin === SERVICE_URL.origin && url.pathname.slice(0, 2) === '/p') {
        url = parseUrl(url.pathname.slice(3))
    }

    if (options.width) {
        APIError.assert(Number.isFinite(options.width), 'Invalid width')
    }
    if (options.height) {
        APIError.assert(Number.isFinite(options.height), 'Invalid height')
    }

    // Default cache for in-progress requests; overridden on success
    // (immutable) or on transient errors (no-store) by errorMiddleware
    ctx.set('Cache-Control', 'public,max-age=600')

    // refuse to proxy images on blacklist
    if (imageBlacklist.matchesUrl(url)) {
        ctx.log.debug('URL %s is blacklisted', url.toString())
        APIError.assert(!imageBlacklist.matchesUrl(url), APIError.Code.Blacklisted)
    } else {
        ctx.log.debug('URL %s is not blacklisted', url.toString())
    }

    // where the original image is/will be stored
    let origStore: AbstractBlobStore
    let origKey: string

    const origIsUpload = SERVICE_URL.origin === url.origin && url.pathname[1] === 'D'
    ctx.tag({is_upload: origIsUpload})
    if (origIsUpload) {
        // ctx.log.debug('origIsUpload')
        // if we are proxying or own image use the uploadStore directly
        // to avoid storing two copies of the same data
        origStore = uploadStore
        origKey = getKeyNameFromHash(url.pathname.slice(1).split('/')[0])
    } else {
        const urlHash = createHash('sha1')
            .update(url.toString())
            .digest()
        origStore = proxyStore
        origKey = 'U' + multihash.toB58String(
            multihash.encode(urlHash, 'sha1')
        )
        origKey = getKeyNameFromHash(origKey)
    }

    // Whitelist check: only serve proxy requests for URLs referenced on the blockchain
    let tokenBypassed = false
    const domainAllowed = !origIsUpload && domainAllowlist.matchesDomain(url)
    if (!origIsUpload && !domainAllowed) {
        // Check for editor preview auth token (bypasses whitelist)
        const token = ctx.query['token'] as string | undefined
        let tokenValid = false
        if (token) {
            const tokenUser = await validateProxyAuthToken(token)
            if (tokenUser) {
                tokenValid = true
                tokenBypassed = true
                ctx.tag({proxy_auth_user: tokenUser})
            }
        }

        if (!tokenValid) {
            const originalUrl = url.toString()
            const urlStatus = await checkUrl(originalUrl)
            if (urlStatus === 'blacklisted') {
                ctx.status = 451
                ctx.set('Cache-Control', 'public, max-age=86400')
                proxyHandlerSpan.finish()
                return
            }
            if (urlStatus === 'unknown') {
                ctx.status = 403
                ctx.set('Cache-Control', 'no-cache, no-store')
                proxyHandlerSpan.finish()
                return
            }
        }
    }

    const imageKey = getImageKey(origKey, options)
    // ctx.log.debug('Checking imageKey %s (origKey = %s)', imageKey, origKey)

    // check if we already have a converted image for requested key
    if (await storeExists(proxyStore, imageKey)) {
        ctx.tag({store: 'resized'})
        ctx.log.debug('streaming %s from store', imageKey)
        const file = proxyStore.createReadStream(imageKey)
        file.on('error', (error) => {
            ctx.log.error(error, 'unable to read %s', imageKey)
            ctx.res.writeHead(500, 'Internal Error')
            ctx.res.end()
            file.destroy()
        })
        const streamSpan = tracer.startSpan('streaming stored image', {childOf: proxyHandlerSpan})
        const {head, stream} = await streamHead(file, {bytes: 16384})
        const mimeType = await mimeMagic(head)
        ctx.set('Content-Type', mimeType)
        ctx.set('Cache-Control', tokenBypassed
            ? 'private, no-store'
            : 'public,max-age=29030400,immutable')
        ctx.body = stream
        streamSpan.finish()
        proxyHandlerSpan.finish()
        return
    }

    // ctx.log.debug('we don\'t already have a resized image to stream')
    // check if we have the original
    let origData: Buffer
    let contentType: string
    const origIsStored = await storeExists(origStore, origKey)
    if (origIsStored) {
        ctx.tag({store: 'original'})
        const readSpan = tracer.startSpan('reading original image from store', {childOf: proxyHandlerSpan})
        origData = await readStream(origStore.createReadStream(origKey))
        // stored originals include uploads, which are not checked against the
        // fetch path below
        contentType = await assertAcceptedImage(origData)
        readSpan.finish()
    } else {
        APIError.assert(origIsUpload === false, 'Upload not found')
        ctx.tag({store: 'fetch'})
        ctx.log.debug({url: url.toString()}, 'fetching image')

        const fetchSourceSpan = tracer.startSpan('fetch image from source', {childOf: proxyHandlerSpan})
        const fetched = await fetchOriginal(ctx, url, origKey, fetchSourceSpan)
        origData = fetched.data
        contentType = fetched.contentType

        ctx.log.debug('storing original %s', origKey)
        const storeOriginalSpan = tracer.startSpan('storing original in bucket', {childOf: fetchSourceSpan})
        await storeWrite(origStore, origKey, origData)
        storeOriginalSpan.finish()
        fetchSourceSpan.finish()
    }

    let rv: Buffer
    const isGifOriginalPassthrough = (
        contentType === 'image/gif' &&
        options.width === undefined &&
        options.height === undefined &&
        options.format === OutputFormat.Match &&
        options.mode === ScalingMode.Fit
    )
    // Pass through AVIF when the client isn't asking for a different output
    // format. Sharp would otherwise re-encode via libaom, which is ~10-50x
    // slower than JPEG/WebP. Width/height hints are ignored in this path —
    // AVIF sources typically arrive already sized by their upstream.
    const isAvifPassthrough = (
        contentType === 'image/avif' &&
        options.format === OutputFormat.Match
    )
    if (isGifOriginalPassthrough || isAvifPassthrough) {
        // pass trough gif if requested with original size
        // this is needed since resizing gifs creates still images
        rv = origData
    } else {
        const resizingSpan = tracer.startSpan('resizing', {childOf: proxyHandlerSpan})
        let converted: EncodedImage
        try {
            converted = await convertImage(origData, contentType, options)
        } catch (decodeError) {
            // A stored proxy original that does not decode is most likely a
            // partial fetch; the source is the only place a good copy can come from.
            if (!origIsStored || origIsUpload) {
                throw decodeError
            }
            ctx.log.warn({
                orig_key: origKey,
                url: url.toString(),
                decoder_error: decoderMessage(decodeError)
            }, 'stored original %s does not decode, refetching from source', origKey)
            const refetchSpan = tracer.startSpan('refetch undecodable original', {childOf: resizingSpan})
            const fresh = await fetchOriginal(ctx, url, origKey, refetchSpan)
            converted = await convertImage(fresh.data, fresh.contentType, options)
            await storeWrite(origStore, origKey, fresh.data)
            refetchSpan.finish()
        }
        rv = converted.data
        contentType = converted.contentType
        ctx.log.debug('storing converted %s', imageKey)
        const storingResizedSpan = tracer.startSpan('storing resized image', {childOf: resizingSpan})
        await storeWrite(proxyStore, imageKey, rv)
        storingResizedSpan.finish()
        resizingSpan.finish()
    }

    ctx.set('Content-Type', contentType)
    ctx.set('Cache-Control', tokenBypassed
        ? 'private, no-store'
        : 'public,max-age=29030400,immutable')
    ctx.body = rv
    proxyHandlerSpan.finish()
}
