/** Serve files from upload store. */

import streamHead from 'stream-head/dist-es6'

import {imageBlacklist} from './blacklist'
import {getKeyNameFromHash, KoaContext, uploadStore} from './common'
import {APIError} from './error'
import {mimeMagic} from './utils'

export async function serveHandler(ctx: KoaContext) {
    ctx.tag({handler: 'serve'})

    APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
    APIError.assertParams(ctx.params, ['hash'])

    const hash = ctx.params['hash']
    APIError.assert(hash.length === 47, APIError.Code.InvalidParam)

    // refuse to proxy image hashes on blacklist
    if (imageBlacklist.includes(hash)) {
        ctx.log.debug('Image hash %s is blacklisted', hash)
        APIError.assert(!imageBlacklist.includes(hash), APIError.Code.Blacklisted)
    } else {
        ctx.log.debug('Image hash %s is not blacklisted', hash)
    }

    const keyName = getKeyNameFromHash(hash)

    const file = uploadStore.createReadStream(keyName)
    file.on('error', (error) => {
        if (error.notFound || error.code === 'NoSuchKey') {
            ctx.res.writeHead(404, 'Not Found')
        } else {
            ctx.log.error(error, 'unable to read %s', ctx.params['hash'])
            ctx.res.writeHead(500, 'Internal Error')
        }
        ctx.res.end()
        file.destroy()
    })

    const {head, stream} = await streamHead(file, {bytes: 16384})
    const mimeType = await mimeMagic(head)

    ctx.response.set('Content-Type', mimeType)
    ctx.response.set('Cache-Control', 'public,max-age=29030400,immutable')
    ctx.body = stream
}
