/** Serve user avatars. */

import * as config from 'config'
import { base58Enc } from './utils'

import {KoaContext, rpcClient} from './common'
import {APIError} from './error'
import { Account } from 'dsteem'

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

    interface IExtendedAccount extends Account {
      posting_json_metadata?: string;
      profile?: {
        version: number
      };
    }

    const [account]: IExtendedAccount[] = await rpcClient.database.getAccounts([username])

    APIError.assert(account, APIError.Code.NoSuchAccount)

    let metadata;
    try {
      metadata = account.posting_json_metadata  ? JSON.parse(account.posting_json_metadata) : JSON.parse(account.json_metadata)
      if (metadata && metadata.profile && metadata.profile.version !== 2) {
        metadata = JSON.parse(account.json_metadata)
      }
    } catch (error) {
      ctx.log.debug(error, 'unable to parse json_metadata for %s', account.name)
      metadata = {}
    }

    let avatarUrl: string = DefaultAvatar
    if (metadata.profile &&
        metadata.profile.profile_image &&
        metadata.profile.profile_image.match(/^https?:\/\//)) {
        avatarUrl = metadata.profile.profile_image
    }

    ctx.set('Cache-Control', 'public,max-age=600')
    ctx.redirect(`/p/${ base58Enc(avatarUrl) }?width=${ size }&height=${ size }`)
}
