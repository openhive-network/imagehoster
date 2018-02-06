/** Misc utils. */

import {Magic, MAGIC_MIME_TYPE} from 'mmmagic'

const magic = new Magic(MAGIC_MIME_TYPE)

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
export function mimeMagic(data: Buffer) {
    return new Promise<string>((resolve, reject) => {
        magic.detect(data, (error, result) => {
            if (error) { reject(error) } else { resolve(result) }
        })
    })

}
