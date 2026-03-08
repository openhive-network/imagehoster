/** Resizing image proxy. */

import {AbstractBlobStore} from 'abstract-blob-store'
import * as config from 'config'
import {createHash} from 'crypto'
import * as http from 'http'
import * as multihash from 'multihashes'
import * as needle from 'needle'
import * as Sharp from 'sharp'
import streamHead from 'stream-head/dist-es6'
import {URL} from 'url'

import * as opentracing from 'opentracing'

import {imageBlacklist} from './blacklist'
import {getKeyNameFromHash, KoaContext, proxyStore, uploadStore} from './common'
import {APIError} from './error'
import {assertPublicUrl, base58Dec, mimeMagic, readStream, storeExists, storeWrite} from './utils'
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

/** Image types allowed to be proxied and resized. */
const AcceptedContentTypes = [
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/svg+xml'
]

interface NeedleResponse extends http.IncomingMessage {
    body: any
    raw: Buffer
    bytes: number
    cookies?: {[name: string]: any}
}

function fetchUrl(url: string, options: needle.NeedleOptions) {
    return new Promise<NeedleResponse>((resolve, reject) => {
        needle.get(url, options, (error, response) => {
            if (error) {
                reject(error)
            } else {
                resolve(response)
            }
        })
    })
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

    // cache all proxy requests for minimum 10 minutes, including failures
    ctx.set('Cache-Control', 'public,max-age=600')

    // refuse to proxy images on blacklist
    if (imageBlacklist.includes(url.toString())) {
        ctx.log.debug('URL %s is blacklisted', url.toString())
        APIError.assert(!imageBlacklist.includes(url.toString()), APIError.Code.Blacklisted)
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
    if (!origIsUpload) {
        // Check for editor preview auth token (bypasses whitelist)
        const token = ctx.query['token'] as string | undefined
        let tokenValid = false
        if (token) {
            const tokenUser = await validateProxyAuthToken(token)
            if (tokenUser) {
                tokenValid = true
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
                ctx.status = 451
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
        ctx.set('Cache-Control', 'public,max-age=29030400,immutable')
        ctx.body = stream
        streamSpan.finish()
        proxyHandlerSpan.finish()
        return
    }

    // ctx.log.debug('we don\'t already have a resized image to stream')
    // check if we have the original
    let origData: Buffer
    let contentType: string
    if (await storeExists(origStore, origKey)) {
        ctx.tag({store: 'original'})
        const readSpan = tracer.startSpan('reading original image from store', {childOf: proxyHandlerSpan})
        origData = await readStream(origStore.createReadStream(origKey))
        contentType = await mimeMagic(origData)
        readSpan.finish()
    } else {
        APIError.assert(origIsUpload === false, 'Upload not found')
        ctx.tag({store: 'fetch'})
        ctx.log.debug({url: url.toString()}, 'fetching image')

        // Validate URL is not targeting internal/private resources
        try {
            await assertPublicUrl(url)
        } catch (cause) {
            throw new APIError({
                code: APIError.Code.InvalidProxyUrl,
                message: 'URL not allowed',
            })
        }

        const fetchSourceSpan = tracer.startSpan('fetch image from source', {childOf: proxyHandlerSpan})

        let res: NeedleResponse
        try {
            res = await fetchUrl(url.toString(), {
                open_timeout: 5 * 1000,
                response_timeout: 5 * 1000,
                read_timeout: 60 * 1000,
                compressed: true,
                parse_response: false,
                follow_max: 5,
                user_agent: 'HiveProxy/1.0 (+https://gitlab.syncad.com/hive/imagehoster)',
            } as any)
        } catch (cause) {
            fetchSourceSpan.setTag(opentracing.Tags.ERROR, true)
            fetchSourceSpan.finish()
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

        contentType = await mimeMagic(res.body)
        APIError.assert(AcceptedContentTypes.includes(contentType), APIError.Code.InvalidImage)

        origData = res.body

        ctx.log.debug('storing original %s', origKey)
        const storeOriginalSpan = tracer.startSpan('storing original in bucket', {childOf: fetchSourceSpan})
        await storeWrite(origStore, origKey, origData)
        storeOriginalSpan.finish()
        fetchSourceSpan.finish()
    }

    let rv: Buffer
    if (contentType === 'image/gif' &&
        options.width === undefined &&
        options.height === undefined &&
        options.format === OutputFormat.Match &&
        options.mode === ScalingMode.Fit
    ) {
        // pass trough gif if requested with original size
        // this is needed since resizing gifs creates still images
        rv = origData
    } else {
        const resizingSpan = tracer.startSpan('resizing', {childOf: proxyHandlerSpan})
        const image = Sharp(origData).jpeg({
            quality: 85,
            force: false,
        }).png({
            compressionLevel: 9,
            force: false,
        }).webp({
            alphaQuality: 100,
            force: false,
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

        rv = await image.toBuffer()
        ctx.log.debug('storing converted %s', imageKey)
        const storingResizedSpan = tracer.startSpan('storing resized image', {childOf: resizingSpan})
        await storeWrite(proxyStore, imageKey, rv)
        storingResizedSpan.finish()
        resizingSpan.finish()
    }

    ctx.set('Content-Type', contentType)
    ctx.set('Cache-Control', 'public,max-age=29030400,immutable')
    ctx.body = rv
    proxyHandlerSpan.finish()
}
