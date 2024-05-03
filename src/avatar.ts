/** Serve user avatars. */

import * as config from 'config'
import { base58Enc } from './utils'

import { Account } from '@hiveio/dhive'
import {KoaContext, rpcClient} from './common'
import {APIError} from './error'

import {performance} from 'perf_hooks'

const DefaultAvatar = config.get('default_avatar') as string
const AvatarSizes: {[size: string]: number} = {
    small: 64,
    medium: 128,
    large: 512,
}

export async function avatarHandler(ctx: KoaContext) {
    ctx.tag({handler: 'avatar'})

    APIError.assert(ctx.method === 'GET', APIError.Code.InvalidMethod)
    APIError.assertParams(ctx.params, ['username'])

    const username = ctx.params['username']
    const size = AvatarSizes[ctx.params['size']] || AvatarSizes.medium

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

    // this was the original setting (10m), likely intended to be a balance between allowing some caching
    // and having your avatar change fairly quickly after you update your account profile.
    // ctx.set('Cache-Control', 'public,max-age=600')
    //
    // We found this to be way too short, so the next attempt was (forever):
    // avatars aren't immutable, of course, but we're marking them as immutable to have them
    // cached forever by varnish/cloudflare.  We run a helper application that monitors accounts
    // for updates, and purges the cache for those accounts whenever that happens.
    // this worked well as far as varnish & cloudflare were concerned, because we proactively tell
    // them to invalidate.  But the users's browser cache will also use this age, and we have no way
    // of telling the user's browser to invalidate their cache.  So now we set it to 1 day as a bit
    // of a compromise.
    ctx.set('Cache-Control', 'public,max-age=86400')

    ctx.set('Server-Timing', `api;dur=${(timeAfterGetAccounts - timeBeforeGetAccounts).toFixed(3)};desc="get_accounts API call"`)
    ctx.redirect(`/p/${ base58Enc(avatarUrl) }?width=${ size }&height=${ size }`)
}
