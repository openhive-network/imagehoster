/** Resizing image proxy. */

import * as http from 'http'
import * as Koa from 'koa'
import * as needle from 'needle'
import * as Sharp from 'sharp'
import streamHead from 'stream-head/dist-es6'
import {URL} from 'url'

import {APIError} from './error'
import {store} from './store'
import {mimeMagic} from './utils'

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

const AcceptedContentTypes = [
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
]

export async function proxyHandler(ctx: Koa.Context) {
    ctx.tag({handler: 'proxy'})

    APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
    APIError.assertParams(ctx.params, ['width', 'height', 'url'])

    const width = Number.parseInt(ctx.params['width'])
    const height = Number.parseInt(ctx.params['height'])

    APIError.assert(Number.isFinite(width), 'Invalid width')
    APIError.assert(Number.isFinite(height), 'Invalid height')

    let url: URL
    try {
        let urlStr = ctx.request.originalUrl
        urlStr = urlStr.slice(urlStr.indexOf('http'))
        urlStr = urlStr.replace('steemit.com/ipfs/', 'ipfs.io/ipfs/')
        url = new URL(urlStr)
    } catch (cause) {
        throw new APIError({cause, code: APIError.Code.InvalidProxyUrl})
    }

    ctx.log.debug('fetching %s', url.toString())

    // TODO: abort request for too large files
    // TODO: image blacklist (one that is not bypassable by adding ?lol=hax to image urls)

    const res = await fetchUrl(url.toString(), {
        compressed: true,
        parse_response: false,
        follow_max: 5,
        user_agent: 'SteemitProxy/1.0 (+https://github.com/steemit/imagehoster)',
    })

    APIError.assert(Buffer.isBuffer(res.body), APIError.Code.InvalidImage)

    if (Math.floor((res.statusCode || 404) / 100) !== 2) {
        throw new APIError({code: APIError.Code.InvalidImage})
    }

    const contentType = await mimeMagic(res.body)
    APIError.assert(AcceptedContentTypes.includes(contentType), APIError.Code.InvalidImage)
    ctx.set('Content-Type', contentType)

    if (contentType === 'image/gif' && width === 0 && height === 0) {
        // pass trough gif if requested with original size (0x0)
        // this is needed since resizing gifs creates still images
        ctx.body = res.body
        return
    }

    const image = Sharp(res.body).jpeg({
        quality: 85,
        force: false,
    }).png({
        compressionLevel: 9,
        force: false,
    })

    let metadata: Sharp.Metadata
    try {
        metadata = await image.metadata()
    } catch (cause) {
        throw new APIError({cause, code: APIError.Code.InvalidImage})
    }

    APIError.assert(metadata.width && metadata.height, APIError.Code.InvalidImage)

    const newSize = calculateGeo(
        metadata.width as number,
        metadata.height as number,
        width,
        height
    )

    if (newSize.width !== metadata.width || newSize.height !== metadata.height) {
        image.resize(newSize.width, newSize.height)
    }

    ctx.body = await image.toBuffer()
}

// from old codebase
// TODO: simplify and maybe allow center cropped resizes?
function calculateGeo(origWidth: number, origHeight: number, targetWidth: number, targetHeight: number) {
    // Default ratio. Default crop.
    const origRatio  = (origHeight !== 0 ? (origWidth / origHeight) : 1)

    // Fill in missing target dims.
    if (targetWidth === 0 && targetHeight === 0) {
        targetWidth  = origWidth
        targetHeight = origHeight
    } else if (targetWidth === 0) {
        targetWidth  = Math.round(targetHeight * origRatio)
    } else if (targetHeight === 0) {
        targetHeight = Math.round(targetWidth / origRatio)
    }

    // Constrain target dims.
    if (targetWidth > origWidth) {   targetWidth  = origWidth }
    if (targetHeight > origHeight) { targetHeight = origHeight }

    const targetRatio = targetWidth / targetHeight
    if (targetRatio > origRatio) {
        // max out height, and calc a smaller width
        targetWidth = Math.round(targetHeight * origRatio)
    } else if (targetRatio < origRatio) {
        // max out width, calc a smaller height
        targetHeight = Math.round(targetWidth / origRatio)
    }

    return {
        width:  targetWidth,
        height: targetHeight,
    }
}
