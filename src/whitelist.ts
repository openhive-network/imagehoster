/** Proxy URL whitelist — only serves images referenced on the Hive blockchain. */

import config from 'config'
import {accountBlacklist} from './blacklist'
import {ensureRedis} from './common'
import {logger} from './logger'

import {performance} from 'perf_hooks'

export type UrlStatus = 'whitelisted' | 'blacklisted' | 'unknown'

/**
 * Combined whitelist + blacklist check in a single API call.
 * Returns 'whitelisted', 'blacklisted', or 'unknown'.
 * Sends the current account blacklist so the API reports URLs referenced only by
 * those accounts as 'unknown'; the field is omitted when the list is empty so the
 * request stays compatible with an API that predates it.
 * On error or if disabled, returns 'whitelisted' (fail-open).
 */
export async function checkUrl(url: string): Promise<UrlStatus> {
    if (!config.get('whitelist.enabled')) {
        return 'whitelisted'
    }
    const apiUrl = config.has('whitelist.apiUrl')
        ? config.get('whitelist.apiUrl') as string : ''
    if (!apiUrl) {
        return 'whitelisted'
    }
    const blacklistedAccounts = accountBlacklist.entries()
    const body = blacklistedAccounts.length > 0
        ? {url, blacklisted_accounts: blacklistedAccounts}
        : {url}
    try {
        const resp = await fetch(
            `${apiUrl}/whitelist/check`,
            {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            }
        )
        const result = await resp.json() as string
        if (result === 'blacklisted' || result === 'unknown') {
            return result
        }
        return 'whitelisted'
    } catch (err) {
        logger.warn(err, 'whitelist check failed, allowing request (fail-open)')
        return 'whitelisted'
    }
}

export type ProfileImageKind = 'avatar' | 'cover'

/**
 * Answer of the whitelist API for an account's avatar or cover:
 * - `skipped`: the API is not configured and was not asked;
 * - `found`: the API knows the account; `url` is null when it has no image
 *   (or one that is not an http(s) URL);
 * - `fallback`: the API does not know the account, failed, timed out or
 *   answered something unreadable, so the caller has to ask the RPC.
 * `durationMs` is how long the API took when it was asked.
 */
export type ProfileUrlLookup =
    | {status: 'skipped'}
    | {status: 'found', url: string | null, durationMs: number}
    | {status: 'fallback', durationMs: number}

const ProfileWarnIntervalMs = 60 * 1000
const lastProfileWarning: {[kind: string]: number} = {}
const suppressedProfileWarnings: {[kind: string]: number} = {}

function warnProfileFailure(kind: ProfileImageKind, name: string, info: any) {
    const now = Date.now()
    if (lastProfileWarning[kind] !== undefined && now - lastProfileWarning[kind] < ProfileWarnIntervalMs) {
        suppressedProfileWarnings[kind] = (suppressedProfileWarnings[kind] || 0) + 1
        return
    }
    const suppressed = suppressedProfileWarnings[kind] || 0
    lastProfileWarning[kind] = now
    suppressedProfileWarnings[kind] = 0
    logger.warn({...info, profile_kind: kind, account: name, suppressed},
        'whitelist /%s lookup failed, falling back to get_accounts', kind)
}

/**
 * Ask the whitelist API for the avatar or cover URL of a (validated) account name,
 * with a `whitelist.profileTimeoutMs` timeout. Failures are logged as a warning at
 * most once per minute per kind and answered with `fallback`; this never throws.
 */
export async function fetchProfileUrl(kind: ProfileImageKind, name: string): Promise<ProfileUrlLookup> {
    if (!config.get('whitelist.enabled')) {
        return {status: 'skipped'}
    }
    const apiUrl = config.has('whitelist.apiUrl')
        ? config.get('whitelist.apiUrl') as string : ''
    if (!apiUrl) {
        return {status: 'skipped'}
    }
    const timeoutMs = Number(config.get('whitelist.profileTimeoutMs'))
    const start = performance.now()
    const elapsed = () => performance.now() - start
    let body: unknown
    try {
        const resp = await fetch(
            `${apiUrl}/${kind}/${encodeURIComponent(name)}`,
            {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(timeoutMs)}
        )
        if (resp.status === 404) {
            await resp.body?.cancel()
            return {status: 'fallback', durationMs: elapsed()}
        }
        if (resp.status !== 200) {
            await resp.body?.cancel()
            warnProfileFailure(kind, name, {status: resp.status})
            return {status: 'fallback', durationMs: elapsed()}
        }
        body = await resp.json()
    } catch (err) {
        warnProfileFailure(kind, name, {err})
        return {status: 'fallback', durationMs: elapsed()}
    }
    if (body === null) {
        return {status: 'found', url: null, durationMs: elapsed()}
    }
    if (typeof body !== 'string') {
        warnProfileFailure(kind, name, {body_type: typeof body})
        return {status: 'fallback', durationMs: elapsed()}
    }
    return {status: 'found', url: body.match(/^https?:\/\//) ? body : null, durationMs: elapsed()}
}

/**
 * Validate a proxy auth token (for editor preview bypass).
 * Returns the username if the token is valid, null otherwise.
 * Still uses Redis — auth tokens are short-lived and stay in the imagehoster's own Redis.
 */
export async function validateProxyAuthToken(token: string): Promise<string | null> {
    const client = await ensureRedis()
    if (!client) {
        return null
    }
    try {
        return await client.get(`proxy:auth:token:${token}`)
    } catch (err) {
        logger.warn(err, 'proxy auth token check failed')
        return null
    }
}
