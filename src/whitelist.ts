/** Proxy URL whitelist — only serves images referenced on the Hive blockchain. */

import * as config from 'config'
import {redisClient} from './common'
import {logger} from './logger'

/**
 * Check if a URL is in the proxy whitelist (referenced in a Hive post).
 * Returns true if whitelisted OR if the feature is disabled/Redis unavailable (fail-open).
 */
export async function isWhitelisted(url: string): Promise<boolean> {
    if (!config.get('whitelist.enabled')) {
        return true
    }
    if (!redisClient) {
        return true
    }
    return new Promise<boolean>((resolve) => {
        redisClient!.sismember('proxy:whitelist:urls', url, (err, result) => {
            if (err) {
                logger.warn(err, 'whitelist check failed, allowing request (fail-open)')
                resolve(true)
            } else {
                resolve(result === 1)
            }
        })
    })
}

/**
 * Check if a URL is permanently blocked via the URL blacklist.
 * Returns false if the feature is disabled/Redis unavailable (fail-open).
 */
export async function isUrlBlacklisted(url: string): Promise<boolean> {
    if (!config.get('whitelist.enabled')) {
        return false
    }
    if (!redisClient) {
        return false
    }
    return new Promise<boolean>((resolve) => {
        redisClient!.sismember('proxy:whitelist:url_blacklist', url, (err, result) => {
            if (err) {
                logger.warn(err, 'URL blacklist check failed, allowing request (fail-open)')
                resolve(false)
            } else {
                resolve(result === 1)
            }
        })
    })
}

/**
 * Validate a proxy auth token (for editor preview bypass).
 * Returns the username if the token is valid, null otherwise.
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
