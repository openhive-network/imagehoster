/** Serve user cover images. */

import config from 'config'
import { base58Enc, isValidAccountName } from './utils'

import { Account } from '@hiveio/dhive'
import {KoaContext, rpcClient} from './common'
import {APIError} from './error'
import {fetchProfileUrl} from './whitelist'

const DefaultCover = config.get('default_cover') as string
const sizeW = 1344
const sizeH = 240

export async function coverHandler(ctx: KoaContext) {
    ctx.tag({handler: 'cover'})

    APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
    APIError.assertParams(ctx.params, ['username'])

    const username = ctx.params['username']
    // dhive throws client-side on names it cannot serialise; answer them like a missing account.
    APIError.assert(isValidAccountName(username), APIError.Code.NoSuchAccount)

    const lookup = await fetchProfileUrl('cover', username)
    if (lookup.status !== 'skipped') {
        ctx.set('Server-Timing', `wl;dur=${lookup.durationMs.toFixed(3)};desc="whitelist /cover"`)
    }

    let coverUrl: string
    if (lookup.status === 'found') {
        ctx.tag({cover_source: lookup.url ? 'api' : 'default'})
        coverUrl = lookup.url || DefaultCover
    } else {
        ctx.tag({cover_source: 'rpc'})
        coverUrl = await rpcCoverUrl(ctx, username)
    }

    // Same edge/browser split as avatars; the purger also purges /u/<name>/cover.
    ctx.set('Cache-Control', 'public, s-maxage=86400, max-age=600')
    ctx.redirect(`/p/${ base58Enc(coverUrl) }?width=${ sizeW }&height=${ sizeH }`)
}

async function rpcCoverUrl(ctx: KoaContext, username: string): Promise<string> {
    interface ExtendedAccount extends Account {
        posting_json_metadata?: string
    }

    const [account]: ExtendedAccount[] = await rpcClient.database.getAccounts([username])

    APIError.assert(account, APIError.Code.NoSuchAccount)

    let metadata

    // read from `posting_json_metadata` if version flag is set
    if (account.posting_json_metadata) {
        try {
            metadata = JSON.parse(account.posting_json_metadata)
            if (!metadata.profile || !metadata.profile.version) {
                metadata = {}
            }
        } catch (error) {
            ctx.log.debug(error, 'unable to parse json_metadata for %s', account.name)
            metadata = {}
        }
    }

    // otherwise, fall back to reading from `json_metadata`
    if (!metadata || !metadata.profile) {
        try {
            metadata = JSON.parse(account.json_metadata)
        } catch (error) {
            ctx.log.debug(error, 'unable to parse json_metadata for %s', account.name)
            metadata = {}
        }
    }

    let coverUrl: string = DefaultCover
    if (metadata.profile &&
        metadata.profile.cover_image &&
        metadata.profile.cover_image.match(/^https?:\/\//)) {
        coverUrl = metadata.profile.cover_image
    }

    return coverUrl
}
