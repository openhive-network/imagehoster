/** Image formats accepted for upload and proxying. */

import * as Sharp from 'sharp'

import {APIError} from './error'
import {mimeMagic} from './utils'

/**
 * Content types, as detected from the data by mimeMagic, that may be uploaded,
 * proxied and handed to Sharp.
 */
export const AcceptedContentTypes = [
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif'
]

/**
 * libvips selects a decoder by inspecting the data itself, independently of
 * the content type checks above. Disable all decoders and enable only the ones
 * needed for AcceptedContentTypes, so data in any other format is rejected by
 * Sharp instead of being parsed.
 */
Sharp.block({operation: ['VipsForeignLoad']})
Sharp.unblock({
    operation: [
        'VipsForeignLoadNsgif',
        'VipsForeignLoadJpeg',
        'VipsForeignLoadPng',
        'VipsForeignLoadWebp',
        'VipsForeignLoadHeif' // AVIF
    ]
})

/** Throws InvalidImage unless data is in one of the AcceptedContentTypes. */
export async function assertAcceptedImage(data: Buffer) {
    const contentType = await mimeMagic(data)
    APIError.assert(AcceptedContentTypes.includes(contentType), APIError.Code.InvalidImage)
    return contentType
}
