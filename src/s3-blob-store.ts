/**
 * Minimal S3 blob store implementing the abstract-blob-store interface.
 * Only implements the methods actually used by this application:
 * createReadStream, createWriteStream, and exists.
 */

import {
    S3Client as AwsS3Client,
    GetObjectCommand,
    PutObjectCommand,
    HeadObjectCommand,
} from '@aws-sdk/client-s3'
import {PassThrough, Readable} from 'stream'

interface S3BlobStoreOptions {
    client: AwsS3Client
    bucket: string
}

export class S3BlobStore {
    private s3: AwsS3Client
    private bucket: string

    constructor(opts: S3BlobStoreOptions) {
        this.s3 = opts.client
        this.bucket = opts.bucket
    }

    createReadStream(opts: any): Readable {
        const key = typeof opts === 'string' ? opts : opts.key
        const passthrough = new PassThrough()

        this.s3.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
        })).then((res) => {
            const body = res.Body
            if (!body || typeof (body as any).pipe !== 'function') {
                passthrough.destroy(new Error('S3 response body is not a readable stream'))
                return
            }
            ;(body as Readable).on('error', (err) => passthrough.destroy(err))
            ;(body as Readable).pipe(passthrough)
        }).catch((err) => {
            passthrough.destroy(err)
        })

        return passthrough
    }

    createWriteStream(opts: any, done?: (error: any, metadata?: any) => void): PassThrough {
        const key = typeof opts === 'string' ? opts : opts.key
        const passthrough = new PassThrough()
        const chunks: Buffer[] = []

        passthrough.on('data', (chunk: Buffer) => chunks.push(chunk))
        passthrough.on('end', () => {
            const body = Buffer.concat(chunks)
            this.s3.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: body,
            })).then(() => {
                if (done) done(null, {key})
            }).catch((err) => {
                if (done) done(err)
            })
        })
        passthrough.on('error', (err) => {
            if (done) done(err)
        })

        return passthrough
    }

    exists(opts: any, done: (error: any, exists?: boolean) => void) {
        const key = typeof opts === 'string' ? opts : opts.key
        this.s3.send(new HeadObjectCommand({
            Bucket: this.bucket,
            Key: key,
        })).then(() => {
            done(null, true)
        }).catch((err) => {
            if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
                done(null, false)
            } else {
                done(err)
            }
        })
    }
}
