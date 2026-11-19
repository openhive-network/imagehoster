/** Serve user avatars. */

import config from 'config'
import { base58Enc, isValidAccountName } from './utils'

import { Account } from '@hiveio/dhive'
import {KoaContext, rpcClient} from './common'
import {APIError} from './error'
import {fetchProfileUrl} from './whitelist'

import {performance} from 'perf_hooks'

const DefaultAvatar = config.get('default_avatar') as string
const AvatarSizes: {[size: string]: number} = {
    small: 64,
    medium: 128,
    large: 512
}

export async function avatarHandler(ctx: KoaContext) {
    ctx.tag({handler: 'avatar'})

    APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
    APIError.assertParams(ctx.params, ['username'])

    const username = ctx.params['username']
    // dhive throws client-side on names it cannot serialise; answer them like a missing account.
    APIError.assert(isValidAccountName(username), APIError.Code.NoSuchAccount)
    const size = AvatarSizes[ctx.params['size']] || AvatarSizes.medium

    const serverTiming: string[] = []
    const lookup = await fetchProfileUrl('avatar', username)
    if (lookup.status !== 'skipped') {
        serverTiming.push(`wl;dur=${lookup.durationMs.toFixed(3)};desc="whitelist /avatar"`)
    }

    let avatarUrl: string
    if (lookup.status === 'found') {
        ctx.tag({avatar_source: lookup.url ? 'api' : 'default'})
        avatarUrl = lookup.url || DefaultAvatar
    } else {
        ctx.tag({avatar_source: 'rpc'})
        const resolved = await rpcAvatarUrl(ctx, username)
        serverTiming.push(`api;dur=${resolved.durationMs.toFixed(3)};desc="get_accounts API call"`)
        avatarUrl = resolved.url
    }

    // The edge (s-maxage) holds the redirect for a day because cf-cache-purger purges it
    // within seconds of an account update; the day only matters if the purger is down.
    // Browsers (max-age) can't be purged, so they recheck after 10 minutes, which is an
    // edge hit rather than an origin request.
    ctx.set('Cache-Control', 'public, s-maxage=86400, max-age=600')

    ctx.set('Server-Timing', serverTiming.join(', '))
    ctx.redirect(`/p/${ base58Enc(avatarUrl) }?width=${ size }&height=${ size }`)
}

async function rpcAvatarUrl(ctx: KoaContext, username: string): Promise<{url: string, durationMs: number}> {
    interface ExtendedAccount extends Account {
      posting_json_metadata?: string
    }

    const timeBeforeGetAccounts = performance.now()
    let account: ExtendedAccount
    try {
        account = (await rpcClient.database.getAccounts([username]))[0]
    } catch (e) {
        ctx.log.error(e, 'getAccounts() threw for %s', username)
        throw e
    }
    const timeAfterGetAccounts = performance.now()

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

    let avatarUrl: string = DefaultAvatar
    if (metadata.profile &&
        metadata.profile.profile_image &&
        metadata.profile.profile_image.match(/^https?:\/\//)) {
        avatarUrl = metadata.profile.profile_image
    }

    return {url: avatarUrl, durationMs: timeAfterGetAccounts - timeBeforeGetAccounts}
}
