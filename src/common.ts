/** Misc shared instances. */

import {Client} from '@hiveio/dhive'
import {AbstractBlobStore} from 'abstract-blob-store'
import * as config from 'config'
import {IRouterContext} from 'koa-router'
import * as Redis from 'redis'

import {logger} from './logger'

/** Koa context extension. */
export interface KoaContext extends IRouterContext {
    [k: string]: any
    log: typeof logger
    tag: (metadata: any) => void
}

/** Steemd (jussi) RPC client. */
export const rpcClient = new Client(config.get('rpc_node'))

/** Redis client. */
export let redisClient: Redis.RedisClient | undefined
if (config.has('redis_url')) {
    redisClient = Redis.createClient({
        url: config.get('redis_url') as string
    })
} else {
    logger.warn('redis not configured, will not rate-limit uploads')
}

/** Blob storage. */

let S3Client: any
function loadStore(key: string): AbstractBlobStore {
    const conf = config.get(key) as any
    if (conf.type === 'memory') {
        logger.warn('using memory store for %s', key)
        return require('abstract-blob-store')()
    } else if (conf.type === 's3') {
        if (!S3Client) {
            const aws = require('aws-sdk')
            S3Client = new aws.S3(config.has('aws_sdk_config') ? config.get('aws_sdk_config') : {})
        }
        return require('s3-blob-store')({
            client: S3Client,
            bucket: conf.get('s3_bucket'),
        })
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
    // we expect the hash to be either a data hash like:
    //   DQmPpQ1mVrziWvgNyK5K64HmRZEMVjQCiNTjgAkBg8wHgJn
    // for uploaded images, or a URL hash like:
    //   U5dtZPvjpfzc3fgGtsoNQq7WLNv8sLT
    // for proxied images.  In either case, the last two
    // characters will be nice and random base58 characters,
    // so this will evenly distribute the files over 
    // 58^2 = 3364 partitions.
    console.assert(hash.length == 47 || hash.length == 31);
    const partition = hash.substr(hash.length - 2);
    return partition + '/' + hash;
}
