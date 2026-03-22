/** Misc shared instances. */

import {Client} from '@hiveio/dhive'
import {RouterContext} from '@koa/router'
import {AbstractBlobStore} from 'abstract-blob-store'
import * as config from 'config'
import {createClient} from 'redis'

import {logger} from './logger'

export type RedisClientType = ReturnType<typeof createClient>

/** Koa context extension. */
export interface KoaContext extends RouterContext {
    [k: string]: any
    log: typeof logger
    tag: (metadata: any) => void
}

/** Steemd (jussi) RPC client. */
export const rpcClient = new Client(config.get('rpc_node'))

/** Redis client. */
export let redisClient: RedisClientType | undefined
let redisReady: Promise<void> | undefined

if (config.has('redis_url')) {
    redisClient = createClient({url: config.get('redis_url') as string})
    redisClient.on('error', (err) => logger.error(err, 'Redis client error'))
    redisReady = redisClient.connect().then(() => {
        logger.info('Redis connected')
    }).catch((err) => {
        logger.error(err, 'Redis connection failed')
        redisClient = undefined
    })
} else {
    logger.warn('redis not configured, will not rate-limit uploads')
}

/** Ensure Redis is connected before use. Returns client if ready, undefined otherwise. */
export async function ensureRedis(): Promise<RedisClientType | undefined> {
    if (redisReady) { await redisReady }
    return redisClient?.isReady ? redisClient : undefined
}

/** Blob storage. */

let s3Client: any
function loadStore(key: string): AbstractBlobStore {
    const conf = config.get(key) as any
    if (conf.type === 'memory') {
        logger.warn('using memory store for %s', key)
        return require('abstract-blob-store')()
    } else if (conf.type === 's3') {
        if (!s3Client) {
            const {S3Client: AwsS3Client} = require('@aws-sdk/client-s3')
            const s3Config: any = {}
            if (config.has('aws_sdk_config')) {
                Object.assign(s3Config, config.get('aws_sdk_config'))
            }
            s3Client = new AwsS3Client(s3Config)
        }
        const {S3BlobStore} = require('./s3-blob-store')
        return new S3BlobStore({
            client: s3Client,
            bucket: conf.get('s3_bucket')
        }) as any
    } else if (conf.type === 'fs') {
        const path = conf.get('path')
        logger.warn('using file store for %s, path = %s', key, path)
        return require('fs-blob-store')(path)
    } else {
        throw new Error(`Invalid storage type: ${ conf.type }`)
    }
}

export const uploadStore = loadStore('upload_store')
export const proxyStore = loadStore('proxy_store')

// convert a key like:
//   U5dtZPvjpfzc3fgGtsoNQq7WLNv8sLT
// into a subdirectories based on the last two characters
//   LT/U5dtZPvjpfzc3fgGtsoNQq7WLNv8sLT
// to make lookups more efficient
export function getKeyNameFromHash(hash: string): string {
    if (!config.has('storage_partitioning') || !config.get('storage_partitioning')) {
        return hash
    }
    // we expect the hash to be either a data hash like:
    //   DQmPpQ1mVrziWvgNyK5K64HmRZEMVjQCiNTjgAkBg8wHgJn
    // for uploaded images, or a URL hash like:
    //   U5dtZPvjpfzc3fgGtsoNQq7WLNv8sLT
    // for proxied images.  In either case, the last two
    // characters will be nice and random base58 characters,
    // so this will evenly distribute the files over
    // 58^2 = 3364 partitions.
    // console.assert(hash.length == 47 || hash.length == 31);
    const partition = hash.substring(hash.length - 2)
    return partition + '/' + hash
}
