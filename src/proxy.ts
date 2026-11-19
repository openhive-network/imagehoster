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
import {assertPublicUrl, base58Dec, mimeMagic, readStream, storeExists, storeRemove, storeWrite} from './utils'
import {domainAllowlist} from './allowlist'
import {checkUrl, validateProxyAuthToken} from './whitelist'

let tracer: opentracing.Tracer
if (process.env.JAEGER_SERVICE_NAME) {
    const jaegerClient = require('jaeger-client')
    tracer = jaegerClient.initTracerFromEnv({}, {})
} else {
    tracer = new opentracing.Tracer()
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

function configInteger(key: string, min: number, max = Number.MAX_SAFE_INTEGER) {
    const value = Number(config.get(key))
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`Invalid ${ key.replace(/_/g, ' ') }`)
    }
    return value
}

// Bounds on keeping the animation of a multi-frame source; a source beyond
// them, or one whose pipeline times out, is resized to its first frame.
const ANIMATED_MAX_FRAMES = configInteger('animated_max_frames', 1)
const ANIMATED_MAX_PIXELS = configInteger('animated_max_pixels', 1)
const ANIMATED_TIMEOUT_S = configInteger('animated_timeout_s', 1, 3600)
const ANIMATED_GIF_EFFORT = configInteger('animated_gif_effort', 1, 10)

// A fetch is aborted beyond PROXY_FETCH_MAX_BYTES; an original above
// PROXY_STORE_ORIGINAL_MAX_BYTES is not stored, only marked as '<origKey>.source'.
const PROXY_FETCH_MAX_BYTES = configInteger('proxy_fetch_max_bytes', 1)
const PROXY_STORE_ORIGINAL_MAX_BYTES = configInteger('proxy_store_original_max_bytes', 0)

// the edge serves a refusal of an oversize source for a day instead of
// fetching the source again on every view
const PAYLOAD_TOO_LARGE_CACHE_CONTROL = 'public, max-age=86400'

const version: string = require('./version')

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

/** A response that announced or sent more than the fetch cap, aborted there. */
class OversizeResponseError extends Error {
    constructor(
        public readonly maxBytes: number,
        public readonly announcedBytes: number | undefined,
        public readonly receivedBytes: number | undefined
    ) {
        super(`Response of ${ announcedBytes !== undefined ? announcedBytes : `over ${ receivedBytes }` } bytes exceeds ${ maxBytes }`)
        this.name = 'OversizeResponseError'
    }
}

function announcedLength(res: http.IncomingMessage) {
    const length = Number(res.headers['content-length'])
    return Number.isInteger(length) ? length : undefined
}

function fetchUrlOnce(url: string, options: needle.NeedleOptions, maxBytes: number) {
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
            // rejecting before abort() keeps the close handler's ShortResponseError
            // from settling the promise first
            const abortOversize = (announcedBytes: number | undefined, receivedBytes: number | undefined) => {
                reject(new OversizeResponseError(maxBytes, announcedBytes, receivedBytes))
                res.req.abort()
            }
            const announcedBytes = announcedLength(res)
            if (announcedBytes !== undefined && announcedBytes > maxBytes) {
                abortOversize(announcedBytes, undefined)
                return
            }
            let receivedBytes = 0
            res.on('data', (chunk: Buffer) => {
                receivedBytes += chunk.length
                if (receivedBytes > maxBytes) {
                    abortOversize(undefined, receivedBytes)
                }
            })
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
async function fetchUrl(url: string, options: needle.NeedleOptions, maxBytes: number, skipSsrfCheck: boolean = false) {
    const maxRedirects = 5
    // Disable needle's built-in redirect following
    const opts = {...options, follow_max: 0}
    let currentUrl = url
    for (let i = 0; i <= maxRedirects; i++) {
        if (!skipSsrfCheck) {
            await assertPublicUrl(new URL(currentUrl))
        }
        const res = await fetchUrlOnce(currentUrl, opts, maxBytes)
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
    GIF,
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
    case 'gif':
        format = OutputFormat.GIF
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
 * non-2xx response or an unaccepted format, PayloadTooLarge as soon as the
 * source announces or sends more than PROXY_FETCH_MAX_BYTES.
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
        } as any, PROXY_FETCH_MAX_BYTES, skipSsrf)
    } catch (cause) {
        span.setTag(opentracing.Tags.ERROR, true)
        span.finish()
        if (cause instanceof OversizeResponseError) {
            ctx.log.info({
                orig_key: origKey,
                source_host: url.host,
                announced_bytes: cause.announcedBytes,
                received_bytes: cause.receivedBytes,
                max_bytes: cause.maxBytes
            }, 'oversize source %s aborted', origKey)
            ctx.set('Cache-Control', PAYLOAD_TOO_LARGE_CACHE_CONTROL)
            throw new APIError({cause, code: APIError.Code.PayloadTooLarge})
        }
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

    APIError.assert(Buffer.isBuffer(res.body), APIError.Code.InvalidImage)
    // a compressed body is counted encoded while it streams in
    if (res.body.length > PROXY_FETCH_MAX_BYTES) {
        ctx.set('Cache-Control', PAYLOAD_TOO_LARGE_CACHE_CONTROL)
        throw new APIError({code: APIError.Code.PayloadTooLarge})
    }

    if (Math.floor((res.statusCode || 404) / 100) !== 2) {
        throw new APIError({code: APIError.Code.InvalidImage})
    }

    return {data: res.body, contentType: await assertAcceptedImage(res.body)}
}

/**
 * How a source with more than one frame was converted: 'animated', or the
 * reason it was not. frames, pixels and timeout exceeded a bound and got the
 * static first-frame result; error is any other failure of the animated
 * pipeline, also answered statically; fits (already within the requested
 * box) and output-larger got the original.
 */
type AnimationOutcome = 'animated' | 'fits' | 'frames' | 'pixels' | 'timeout' | 'error' | 'output-larger'

interface AnimationReport {
    outcome: AnimationOutcome
    frames: number
    /** frames × width × height of the source */
    pixels: number
    sourceBytes: number
    /** wall time of the conversion, in ms */
    ms: number
    error?: string
}

interface ConvertedImage extends EncodedImage {
    /** Set for a source with more than one frame when the requested format can be animated. */
    animation?: AnimationReport
}

/** A static result for an animated source that a later attempt may animate. */
function isRetryableFallback(outcome: AnimationOutcome) {
    return outcome === 'frames' || outcome === 'pixels' || outcome === 'timeout' || outcome === 'error'
}

/**
 * The format an animated source is written in for a requested format,
 * undefined when the request asks for a static one. sharp writes animation
 * as GIF and WebP only, so other sources (APNG) matching their input get WebP.
 */
function animatedFormat(contentType: string, format: OutputFormat): 'gif' | 'webp' | undefined {
    switch (format) {
    case OutputFormat.Match:
        return contentType === 'image/gif' ? 'gif' : 'webp'
    case OutputFormat.GIF:
        return 'gif'
    case OutputFormat.WEBP:
        return 'webp'
    default:
        return undefined
    }
}

/**
 * The box the options ask an image of metadata's (first frame's) size to be
 * resized to; in Fit mode both sides are set.
 */
function resizeBox(metadata: Sharp.Metadata, options: ProxyOptions): {width?: number, height?: number} {
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

    if (options.mode === ScalingMode.Fit) {
        return {width: width || maxWidth, height: height || maxHeight}
    }
    return {width, height}
}

/** Apply the resize the options ask for to image, whose (first frame's) size is metadata's. */
function applyResize(image: Sharp.Sharp, metadata: Sharp.Metadata, options: ProxyOptions) {
    const {width, height} = resizeBox(metadata, options)
    switch (options.mode) {
    case ScalingMode.Cover:
        image.rotate().resize(width, height, {fit: 'cover'})
        break
    case ScalingMode.Fit:
        image.rotate().resize(width, height, { fit: 'inside', withoutEnlargement: true })
        break
    }
}

/**
 * Whether resizing an image of metadata's size as the options ask leaves it
 * as it is: a Fit into a box it already fits, with no orientation to apply.
 */
function fitsUnresized(metadata: Sharp.Metadata, options: ProxyOptions) {
    if (options.mode !== ScalingMode.Fit || (metadata.orientation || 1) !== 1) {
        return false
    }
    const {width, height} = resizeBox(metadata, options)
    return metadata.width! <= width! && metadata.height! <= height!
}

/** Whether the frames of an encoded animation have the size of metadata's first frame. */
async function hasFrameSize(data: Buffer, metadata: Sharp.Metadata) {
    const output = await Sharp(data).metadata()
    return output.width === metadata.width && (output.pageHeight || output.height) === metadata.height
}

/** Resize image to its first frame and encode it in the requested format. */
async function encodeStatic(image: Sharp.Sharp, metadata: Sharp.Metadata, origContentType: string, options: ProxyOptions): Promise<EncodedImage> {
    let contentType = origContentType
    applyResize(image, metadata, options)

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
    case OutputFormat.GIF:
        contentType = 'image/gif'
        image.gif({force: true})
        break
    }

    return {data: await image.toBuffer(), contentType}
}

/** Resize every frame of origData and encode them as format, within ANIMATED_TIMEOUT_S. */
async function encodeAnimated(origData: Buffer, metadata: Sharp.Metadata, format: 'gif' | 'webp', options: ProxyOptions) {
    const image = Sharp(origData, {failOn: 'error', animated: true}).timeout({seconds: ANIMATED_TIMEOUT_S})
    applyResize(image, metadata, options)
    if (format === 'gif') {
        image.gif({effort: ANIMATED_GIF_EFFORT})
    } else {
        image.webp({alphaQuality: 100})
    }
    return image.toBuffer()
}

/**
 * Convert a source of frames frames, keeping its animation within the
 * ANIMATED_ bounds and falling back to encodeStatic of image beyond them.
 * A Fit in the source's format that would not shrink it gives origData
 * itself, as does an animated result larger than origData unless it is a
 * cover crop that changed the frame size.
 */
async function convertAnimated(
    image: Sharp.Sharp, metadata: Sharp.Metadata, frames: number, format: 'gif' | 'webp',
    origData: Buffer, origContentType: string, options: ProxyOptions
): Promise<ConvertedImage> {
    const startTime = Date.now()
    const pixels = frames * metadata.width! * metadata.height!
    const report = (outcome: AnimationOutcome, error?: string): AnimationReport => (
        {outcome, frames, pixels, sourceBytes: origData.length, ms: Date.now() - startTime, error}
    )

    if (options.format === OutputFormat.Match && fitsUnresized(metadata, options)) {
        return {data: origData, contentType: origContentType, animation: report('fits')}
    }

    let outcome: AnimationOutcome
    let errorMessage: string | undefined
    if (frames > ANIMATED_MAX_FRAMES) {
        outcome = 'frames'
    } else if (pixels > ANIMATED_MAX_PIXELS) {
        outcome = 'pixels'
    } else {
        try {
            const data = await encodeAnimated(origData, metadata, format, options)
            // the original still fits a Fit box once scaled down by the client,
            // but has the shape of a cover crop only when that left it unchanged
            if (data.length > origData.length && (options.mode === ScalingMode.Fit || await hasFrameSize(data, metadata))) {
                return {data: origData, contentType: origContentType, animation: report('output-larger')}
            }
            return {data, contentType: `image/${ format }`, animation: report('animated')}
        } catch (error) {
            // whatever stopped the animated pipeline, the static one may still succeed
            if (!(error instanceof Error)) {
                throw error
            }
            // libvips' error buffer is process-global, so another pipeline's
            // text can precede sharp's 'timeout: NN% complete'
            outcome = error.message.includes('timeout:') ? 'timeout' : 'error'
            errorMessage = error.message
        }
    }
    const fallback = await encodeStatic(image, metadata, origContentType, options)
    return {...fallback, animation: report(outcome, errorMessage)}
}

/**
 * Resize and re-encode an original as the options ask. Throws when the
 * original does not decode: InvalidImage when its header cannot be read,
 * Sharp's error when its data cannot.
 */
async function convertImage(origData: Buffer, origContentType: string, options: ProxyOptions): Promise<ConvertedImage> {
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

    const frames = metadata.pages || 1
    const format = frames > 1 ? animatedFormat(origContentType, options.format) : undefined
    if (format === undefined) {
        return encodeStatic(image, metadata, origContentType, options)
    }
    return convertAnimated(image, metadata, frames, format, origData, origContentType, options)
}

function decoderMessage(error: unknown): string {
    if (error instanceof APIError && error.cause) {
        return error.cause.message
    }
    return error instanceof Error ? error.message : String(error)
}

/** Write data to store, refusing with InternalError when there is none. */
async function storeNonEmpty(store: AbstractBlobStore, key: string, data: Buffer) {
    if (data.length === 0) {
        throw new APIError({message: `Refusing to store empty ${ key }`, code: APIError.Code.InternalError})
    }
    await storeWrite(store, key, data)
}

/**
 * Keep a fetched original: store it as origKey when it has at most
 * PROXY_STORE_ORIGINAL_MAX_BYTES, otherwise store only a '<origKey>.source'
 * marker recording where it came from and what it was, so that it can be
 * backfilled later. Returns whether the original was stored. Throws
 * InvalidImage when the header of an original to be marked cannot be read.
 */
async function keepOriginal(
    ctx: KoaContext, store: AbstractBlobStore, origKey: string, url: URL, original: EncodedImage, fetchMs: number
): Promise<boolean> {
    const {data, contentType} = original
    if (data.length <= PROXY_STORE_ORIGINAL_MAX_BYTES) {
        await storeNonEmpty(store, origKey, data)
        return true
    }
    let metadata: Sharp.Metadata
    try {
        metadata = await Sharp(data, {failOn: 'error'}).metadata()
    } catch (cause) {
        if (!(cause instanceof Error)) {
            cause = Error('unexpected error')
        }
        throw new APIError({cause: cause as Error, code: APIError.Code.InvalidImage})
    }
    await storeWrite(store, `${ origKey }.source`, JSON.stringify({
        url: url.toString(),
        content_type: contentType,
        bytes: data.length,
        width: metadata.width,
        height: metadata.pageHeight || metadata.height,
        pages: metadata.pages || 1,
        sha256: createHash('sha256').update(data).digest('hex'),
        fetched_at: new Date().toISOString(),
        version,
        stored: false
    }))
    ctx.log.info({
        orig_key: origKey,
        source_host: url.host,
        bytes: data.length,
        stored: false,
        ms: fetchMs
    }, 'oversize source %s fetched, original not stored', origKey)
    return false
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
        if (head.length > 0) {
            ctx.tag({store: 'resized'})
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
        // left behind by a write that failed after creating the key
        ctx.log.warn({image_key: imageKey}, 'stored result %s is empty, regenerating it', imageKey)
        file.destroy()
        streamSpan.finish()
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
        const fetchStart = Date.now()
        const fetched = await fetchOriginal(ctx, url, origKey, fetchSourceSpan)
        const fetchMs = Date.now() - fetchStart
        origData = fetched.data
        contentType = fetched.contentType

        ctx.log.debug('storing original %s', origKey)
        const storeOriginalSpan = tracer.startSpan('storing original in bucket', {childOf: fetchSourceSpan})
        await keepOriginal(ctx, origStore, origKey, url, fetched, fetchMs)
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
        let converted: ConvertedImage
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
            const refetchStart = Date.now()
            const fresh = await fetchOriginal(ctx, url, origKey, refetchSpan)
            const refetchMs = Date.now() - refetchStart
            converted = await convertImage(fresh.data, fresh.contentType, options)
            if (!await keepOriginal(ctx, origStore, origKey, url, fresh, refetchMs)) {
                await storeRemove(origStore, origKey)
            }
            refetchSpan.finish()
        }
        rv = converted.data
        contentType = converted.contentType
        const {animation} = converted
        const markerKey = `${ imageKey }.animated-fallback`
        ctx.log.debug('storing converted %s', imageKey)
        const storingResizedSpan = tracer.startSpan('storing resized image', {childOf: resizingSpan})
        // The marker goes first, so that a stored fallback never lacks one; a
        // marker left without its result only names a key the next request redoes.
        if (animation && isRetryableFallback(animation.outcome)) {
            await storeWrite(proxyStore, markerKey, JSON.stringify({
                reason: animation.outcome,
                frames: animation.frames,
                pixels: animation.pixels,
                source_bytes: animation.sourceBytes,
                error: animation.error,
                time: new Date().toISOString(),
                version
            }))
        }
        await storeNonEmpty(proxyStore, imageKey, rv)
        if (animation && !isRetryableFallback(animation.outcome)) {
            await storeRemove(proxyStore, markerKey)
        }
        storingResizedSpan.finish()
        if (animation) {
            ctx.log.info({
                image_key: imageKey,
                frames: animation.frames,
                pixels: animation.pixels,
                source_bytes: animation.sourceBytes,
                output_bytes: rv.length,
                ms: animation.ms,
                fallback: animation.outcome === 'animated' ? undefined : animation.outcome,
                error: animation.error
            }, 'animated source %s: %s', imageKey, animation.outcome)
        }
        resizingSpan.finish()
    }

    ctx.set('Content-Type', contentType)
    ctx.set('Cache-Control', tokenBypassed
        ? 'private, no-store'
        : 'public,max-age=29030400,immutable')
    ctx.body = rv
    proxyHandlerSpan.finish()
}
