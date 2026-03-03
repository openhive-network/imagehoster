/** Proxy auth endpoint — issues session tokens for editor preview bypass. */

import {Signature} from '@hiveio/dhive'
import * as config from 'config'
import {createHash, randomBytes} from 'crypto'

import {accountBlacklist} from './blacklist'
import {KoaContext, redisClient, rpcClient} from './common'
import {APIError} from './error'

const UPLOAD_LIMITS = config.get('upload_limits') as any

/** Token TTL in seconds (30 minutes). */
const TOKEN_TTL = 1800

/**
 * Compute reputation log10 score from raw reputation value.
 * Same formula as used in upload.ts.
 */
function repLog10(rep2: any): number {
    if (rep2 == null) { return rep2 }
    let rep = String(rep2)
    const neg = rep.charAt(0) === '-'
    rep = neg ? rep.substring(1) : rep
    let out = Math.log10(rep.length > 15 ? Number(rep.substring(0, 15)) : Number(rep))
    if (rep.length > 15) {
        out = out + (rep.length - 15)
    }
    if (isNaN(out)) { out = 0 }
    out = Math.max(out - 9, 0)
    out = (neg ? -1 : 1) * out
    out = (out * 9) + 25
    return out
}

/**
 * POST /proxy-auth/:username/:signature
 *
 * Verifies that the caller holds the posting key for :username,
 * then issues a short-lived Redis token that bypasses the proxy whitelist.
 *
 * The signature is over SHA256("ProxySigningChallenge" + timestamp),
 * where timestamp is provided in the JSON body.
 */
export async function proxyAuthHandler(ctx: KoaContext) {
    ctx.tag({handler: 'proxy_auth'})

    APIError.assert(ctx.method === 'POST', {code: APIError.Code.InvalidMethod})
    APIError.assertParams(ctx.params, ['username', 'signature'])
    APIError.assert(redisClient, {message: 'Redis not configured'})

    const username = ctx.params['username']
    const sig = ctx.params['signature']

    // Parse timestamp from body
    const body = (ctx.request as any).body || {}
    const timestamp = body.timestamp
    APIError.assert(timestamp && typeof timestamp === 'number',
                    {message: 'Request body must include numeric timestamp'})

    // Reject if timestamp is too old (> 5 minutes) or in the future (> 1 minute)
    const now = Date.now()
    APIError.assert(Math.abs(now - timestamp) < 5 * 60 * 1000,
                    {message: 'Timestamp too far from current time'})

    // Verify signature
    const challengeHash = createHash('sha256')
        .update('ProxySigningChallenge')
        .update(String(timestamp))
        .digest()

    const signature = Signature.fromString(sig)

    ctx.log.debug('Fetching %s\'s public keys for proxy auth', username)
    const [account] = await rpcClient.database.getAccounts([username])
    APIError.assert(account, APIError.Code.NoSuchAccount)

    let validSignature = false
    let publicKey: string
    try {
        publicKey = signature.recover(challengeHash).toString()
    } catch (cause) {
        throw new APIError({code: APIError.Code.InvalidSignature, cause})
    }

    const thresholdPosting = account.posting.weight_threshold
    for (const auth of account.posting.key_auths) {
        if (auth[0] === publicKey && auth[1] >= thresholdPosting) {
            validSignature = true
            break
        }
    }

    APIError.assert(validSignature, APIError.Code.InvalidSignature)
    APIError.assert(!accountBlacklist.includes(account.name), APIError.Code.Blacklisted)
    APIError.assert(repLog10(account.reputation) >= UPLOAD_LIMITS.reputation, APIError.Code.Deplorable)

    // Generate token and store in Redis
    const token = randomBytes(24).toString('hex')
    await new Promise<void>((resolve, reject) => {
        redisClient!.set(`proxy:auth:token:${token}`, username, 'EX', TOKEN_TTL, (err) => {
            if (err) { reject(err) } else { resolve() }
        })
    })

    ctx.log.info({username}, 'proxy auth token issued')

    ctx.status = 200
    ctx.body = {token, expires_in: TOKEN_TTL}
}
