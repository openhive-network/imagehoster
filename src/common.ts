/** Misc shared instances. */

import * as config from 'config'
import {Client} from 'dsteem'
import * as Redis from 'redis'

import {logger} from './logger'

/** Steemd (jussi) RPC client. */
export const rpcClient = new Client(config.get('rpc_node'))

/** Redis client. */
export let redisClient: Redis.RedisClient
if (config.has('redis_url')) {
    redisClient = Redis.createClient({
        url: config.get('redis_url') as string
    })
} else {
    logger.warn('redis not configured, will not rate-limit uploads')
}
