/** Misc shared instances. */

import * as config from 'config'
import * as Redis from 'redis'
import {AbstractBlobStore} from 'abstract-blob-store'
import {Client} from 'dsteem'

import {logger} from './logger'

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
export let store: AbstractBlobStore

const storageConf: any = config.get('storage')
if (storageConf.type === 'memory') {
    logger.warn('using memory store')
    store = require('abstract-blob-store')()
} else if (storageConf.type === 's3') {
    const aws = require('aws-sdk')
    const S3BlobStore = require('s3-blob-store')
    const client = new aws.S3()
    const bucket = storageConf.get('s3_bucket')
    store = new S3BlobStore({client, bucket})
} else {
    throw new Error(`Invalid storage type: ${ storageConf.type }`)
}

