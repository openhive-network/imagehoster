/** Proxy URL whitelist — only serves images referenced on the Hive blockchain. */

import * as config from 'config'
import {redisClient} from './common'
import {logger} from './logger'

// Node 20+ has native fetch; declare the type since @types/node is outdated
declare function fetch(url: string, init?: {method?: string; headers?: Record<string, string>; body?: string}): Promise<{json(): Promise<any>}>

/**
 * Check if a URL is in the proxy whitelist (referenced in a Hive post).
 * Calls the PostgREST API endpoint.
 * Returns true if whitelisted OR if the feature is disabled/API unavailable (fail-open).
 */
export async function isWhitelisted(url: string): Promise<boolean> {
    if (!config.get('whitelist.enabled')) {
        return true
    }
    const apiUrl = config.has('whitelist.apiUrl') ? config.get('whitelist.apiUrl') as string : ''
    if (!apiUrl) {
        return true
    }
    try {
        const resp = await fetch(
            `${apiUrl}/whitelist/check`,
            {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({url}),
            }
        )
        const result = await resp.json()
        return result === true
    } catch (err) {
        logger.warn(err, 'whitelist check failed, allowing request (fail-open)')
        return true
    }
}

/**
 * Check if a URL is permanently blocked via the URL blacklist.
 * Calls the PostgREST API endpoint.
 * Returns false if the feature is disabled/API unavailable (fail-open).
 */
export async function isUrlBlacklisted(url: string): Promise<boolean> {
    if (!config.get('whitelist.enabled')) {
        return false
    }
    const apiUrl = config.has('whitelist.apiUrl') ? config.get('whitelist.apiUrl') as string : ''
    if (!apiUrl) {
        return false
    }
    try {
        const resp = await fetch(
            `${apiUrl}/whitelist/url-blacklisted`,
            {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({url}),
            }
        )
        const result = await resp.json()
        return result === true
    } catch (err) {
        logger.warn(err, 'URL blacklist check failed, allowing request (fail-open)')
        return false
    }
}

/**
 * Validate a proxy auth token (for editor preview bypass).
 * Returns the username if the token is valid, null otherwise.
 * Still uses Redis — auth tokens are short-lived and stay in the imagehoster's own Redis.
 */
export async function validateProxyAuthToken(token: string): Promise<string | null> {
    if (!redisClient) {
        return null
    }
    return new Promise<string | null>((resolve) => {
        redisClient!.get(`proxy:auth:token:${token}`, (err, result) => {
            if (err) {
                logger.warn(err, 'proxy auth token check failed')
                resolve(null)
            } else {
                resolve(result)
            }
        })
    })
}
