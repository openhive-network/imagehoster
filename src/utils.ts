/** Misc utils. */

import {AbstractBlobStore, BlobKey} from 'abstract-blob-store'
import {fromBuffer} from 'file-type'
import * as multihash from 'multihashes'

/** Parse boolean value from string. */
export function parseBool(input: any): boolean {
    if (typeof input === 'string') {
        input = input.toLowerCase().trim()
    }
    switch (input) {
        case true:
        case 1:
        case '1':
        case 'y':
        case 'yes':
        case 'on':
            return true
        case 0:
        case false:
        case '0':
        case 'n':
        case 'no':
        case 'off':
            return false
        default:
            throw new Error(`Ambiguous boolean: ${ input }`)
    }
}

/** Convert CamelCase to snake_case. */
export function camelToSnake(value: string) {
    return value
        .replace(/([A-Z])/g, (_, m) => `_${ m.toLowerCase() }`)
        .replace(/^_/, '')
}

/** Read stream into memory. */
export function readStream(stream: NodeJS.ReadableStream) {
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        stream.on('data', (chunk) => { chunks.push(chunk) })
        stream.on('error', reject)
        stream.on('end', () => {
            resolve(Buffer.concat(chunks))
        })
    })
}

/** Return mimetype of data. */
export async function mimeMagic(data: Buffer) {
    const mimeInfo = await fromBuffer(data)
    return mimeInfo?.mime || 'application/octet-stream'
}

/** Async version of abstract-blob-store exists. */
export function storeExists(store: AbstractBlobStore, key: BlobKey) {
    return new Promise<boolean>((resolve, reject) => {
        store.exists(key, (error, exists) => {
            if (error) {
                reject(error)
            } else {
                resolve(exists)
            }
        })
    })
}

/** Write data to store. */
export function storeWrite(store: AbstractBlobStore, key: BlobKey, data: Buffer | string) {
    return new Promise(async (resolve, reject) => {
        const stream = store.createWriteStream(key, (error, metadata) => {
            if (error) { reject(error) } else { resolve(metadata) }
        })
        stream.write(data)
        stream.end()
    })
}

/** Encode utf8 string with Base58. */
export function base58Enc(value: string): string {
    return multihash.toB58String(Buffer.from(value, 'utf8'))
}

/** Decode utf8 string from Base58. */
export function base58Dec(value: string): string {
    return multihash.fromB58String(value).toString('utf8')
}
