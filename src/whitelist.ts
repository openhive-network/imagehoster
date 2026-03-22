/** Proxy URL whitelist — only serves images referenced on the Hive blockchain. */

import * as config from 'config'
import {ensureRedis} from './common'
import {logger} from './logger'

// Node 20+ has native fetch; declare the type since @types/node is outdated
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function fetch(url: string, init?: {
    method?: string; headers?: Record<string, string>; body?: string;
}): Promise<{json(): Promise<any>}>

export type UrlStatus = 'whitelisted' | 'blacklisted' | 'unknown'

/**
 * Combined whitelist + blacklist check in a single API call.
 * Returns 'whitelisted', 'blacklisted', or 'unknown'.
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
    try {
        const resp = await fetch(
            `${apiUrl}/whitelist/check`,
            {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({url})
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
