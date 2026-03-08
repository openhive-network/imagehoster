/** Misc utils. */

import {AbstractBlobStore, BlobKey} from 'abstract-blob-store'
import * as dns from 'dns'
import {fromBuffer} from 'file-type'
import * as multihash from 'multihashes'
import * as net from 'net'
import {URL} from 'url'

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

/**
 * Check if an IP address belongs to a private/reserved range.
 * Blocks: loopback, private (RFC1918), link-local, multicast,
 * IPv6 loopback/unspecified/link-local/ULA, IPv4-mapped IPv6.
 */
function isPrivateIP(ip: string): boolean {
    // IPv4
    if (net.isIPv4(ip)) {
        const parts = ip.split('.').map(Number)
        if (parts[0] === 127) { return true }                         // loopback
        if (parts[0] === 10) { return true }                          // 10.0.0.0/8
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) { return true }  // 172.16.0.0/12
        if (parts[0] === 192 && parts[1] === 168) { return true }     // 192.168.0.0/16
        if (parts[0] === 169 && parts[1] === 254) { return true }     // link-local
        if (parts[0] === 0) { return true }                           // 0.0.0.0/8
        if (parts[0] >= 224) { return true }                          // multicast + reserved
        return false
    }

    // IPv6
    if (net.isIPv6(ip)) {
        const normalized = ip.toLowerCase()
        if (normalized === '::1') { return true }                     // loopback
        if (normalized === '::') { return true }                      // unspecified
        if (normalized.startsWith('fe80:')) { return true }           // link-local
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) { return true } // ULA
        if (normalized.startsWith('ff')) { return true }              // multicast
        // IPv4-mapped IPv6 (::ffff:x.x.x.x)
        const v4match = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
        if (v4match) { return isPrivateIP(v4match[1]) }
        return false
    }

    // Unknown format — block by default
    return true
}

/**
 * Assert that a URL is safe to fetch (not targeting internal resources).
 * Validates scheme and resolves DNS to check for private IPs.
 * Throws if the URL is not safe. Skipped in test environment.
 */
export async function assertPublicUrl(url: URL): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
        return
    }
    // Only allow http and https schemes
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only http and https URLs are allowed')
    }

    const hostname = url.hostname

    // If hostname is an IP literal, check directly
    if (net.isIP(hostname)) {
        if (isPrivateIP(hostname)) {
            throw new Error('URL resolves to a private IP address')
        }
        return
    }

    // Block hostnames that look like they target internal resources
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
        throw new Error('URL targets a local/internal hostname')
    }

    // Resolve DNS and check all returned IPs
    const lookup = dns.promises.lookup
    try {
        const results = await lookup(hostname, {all: true})
        for (const result of results) {
            if (isPrivateIP(result.address)) {
                throw new Error('URL resolves to a private IP address')
            }
        }
    } catch (err: any) {
        if (err.message && (err.message.includes('private') || err.message.includes('local'))) {
            throw err
        }
        // DNS resolution failure — let needle handle it (will fail naturally)
    }
}

/** Encode utf8 string with Base58. */
export function base58Enc(value: string): string {
    return multihash.toB58String(Buffer.from(value, 'utf8'))
}

/** Decode utf8 string from Base58. */
export function base58Dec(value: string): string {
    return multihash.fromB58String(value).toString('utf8')
}
