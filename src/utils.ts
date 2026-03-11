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
 * Convert an IPv6 address to its full 8-group hex representation.
 * Needed because string prefix matching on abbreviated forms is unreliable.
 */
function expandIPv6(ip: string): string {
    // Handle IPv4-mapped IPv6 in dotted form (::ffff:1.2.3.4)
    const v4dotted = ip.match(/^(.*):(\d+\.\d+\.\d+\.\d+)$/)
    if (v4dotted) {
        const parts = v4dotted[2].split('.').map(Number)
        const hex1 = ((parts[0] << 8) | parts[1]).toString(16)
        const hex2 = ((parts[2] << 8) | parts[3]).toString(16)
        ip = v4dotted[1] + ':' + hex1 + ':' + hex2
    }

    const halves = ip.split('::')
    if (halves.length === 2) {
        const left = halves[0] ? halves[0].split(':') : []
        const right = halves[1] ? halves[1].split(':') : []
        const missing = 8 - left.length - right.length
        const middle = Array(missing).fill('0')
        const groups = [...left, ...middle, ...right]
        return groups.map((g) => g.padStart(4, '0')).join(':').toLowerCase()
    }
    return ip.split(':').map((g) => g.padStart(4, '0')).join(':').toLowerCase()
}

/**
 * Check if an IPv4 address (as 4 numbers) belongs to a private/reserved range.
 */
function isPrivateIPv4(parts: number[]): boolean {
    if (parts[0] === 127) { return true }                         // loopback
    if (parts[0] === 10) { return true }                          // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) { return true }  // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) { return true }     // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) { return true }     // link-local
    if (parts[0] === 0) { return true }                           // 0.0.0.0/8
    if (parts[0] >= 224) { return true }                          // multicast + reserved
    return false
}

/**
 * Check if an IP address belongs to a private/reserved range.
 * Blocks: loopback, private (RFC1918), link-local, multicast,
 * IPv6 loopback/unspecified/link-local/ULA, IPv4-mapped IPv6 in
 * both dotted (::ffff:127.0.0.1) and hex (::ffff:7f00:1) forms.
 */
export function isPrivateIP(ip: string): boolean {
    if (net.isIPv4(ip)) {
        return isPrivateIPv4(ip.split('.').map(Number))
    }

    if (net.isIPv6(ip)) {
        const full = expandIPv6(ip)
        // full is now 8 groups of 4 hex chars: "0000:0000:...:0000"
        const groups = full.split(':')

        // ::1 (loopback) = 0000:...:0000:0001
        if (full === '0000:0000:0000:0000:0000:0000:0000:0001') { return true }
        // :: (unspecified) = all zeros
        if (full === '0000:0000:0000:0000:0000:0000:0000:0000') { return true }
        // fe80::/10 (link-local)
        const first16 = parseInt(groups[0], 16)
        if ((first16 & 0xffc0) === 0xfe80) { return true }
        // fc00::/7 (ULA)
        if ((first16 & 0xfe00) === 0xfc00) { return true }
        // ff00::/8 (multicast)
        if ((first16 & 0xff00) === 0xff00) { return true }

        // IPv4-mapped (::ffff:x:x) and IPv4-compatible (::x:x)
        // Check if first 80 bits are zero and bits 80-95 are 0000 or ffff
        const prefix80 = groups.slice(0, 5).join(':')
        if (prefix80 === '0000:0000:0000:0000:0000') {
            const g5 = groups[5]
            if (g5 === 'ffff' || g5 === '0000') {
                // Extract IPv4 from last 32 bits (groups 6 and 7)
                const hi = parseInt(groups[6], 16)
                const lo = parseInt(groups[7], 16)
                return isPrivateIPv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff])
            }
        }

        return false
    }

    // Unknown format — block by default
    return true
}

/**
 * Assert that a URL is safe to fetch (not targeting internal resources).
 * Validates scheme and resolves DNS to check for private IPs.
 * Throws if the URL is not safe.
 */
export async function assertPublicUrl(url: URL): Promise<void> {
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
