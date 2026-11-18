import 'mocha'
import assert from 'assert'
import {execFile} from 'child_process'
import * as crypto from 'crypto'
import * as http from 'http'
import * as net from 'net'
import needle from 'needle'
import * as multihash from 'multihashes'
import * as path from 'path'
import * as fs from 'fs'
import sharp from 'sharp'
import {URL} from 'url'
import * as util from 'util'

import {app} from './../src/app'
import {getKeyNameFromHash, proxyStore, uploadStore} from './../src/common'
import {imageBlacklist} from './../src/blacklist'
import {readStream, storeExists, storeWrite, base58Enc} from './../src/utils'

import {uploadImage} from './upload'

describe('proxy', function() {
    const port = 63205
    const server = http.createServer(app.callback())

    before((done) => { server.listen(port, '127.0.0.1', done) })
    after((done) => { server.close(done) })

    needle.defaults({follow_max: 1})

    let serveImage = true
    const imageServer = http.createServer((req, res) => {
        if (serveImage) {
            fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
        } else {
            res.writeHead(404)
            res.end()
        }
    })

    before((done) => { imageServer.listen(port+1, '127.0.0.1', done) })
    after((done) => { imageServer.close(done) })

    it('should proxy', async function() {
        this.slow(1000)
        const res = await needle('get', `http://localhost:${ port }/0x0/http://localhost:${ port+1 }/test.jpg`)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert.equal(meta.width, 1280)
        assert.equal(meta.height, 853)
        assert.equal(meta.format, 'jpeg')
        assert.equal(meta.space, 'srgb')
    })

    it('should proxy and resize', async function() {
        this.slow(1000)
        const res = await needle('get', `http://localhost:${ port }/100x0/http://localhost:${ port+1 }/test.jpg`)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert.equal(meta.width, 100)
        assert.equal(meta.height, 67)
        assert.equal(meta.format, 'jpeg')
        assert.equal(meta.space, 'srgb')
    })

    it('should proxy stored image when source is gone', async function() {
        serveImage = false
        const res = await needle('get', `http://localhost:${ port }/100x0/http://localhost:${ port+1 }/test.jpg`)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert.equal(meta.width, 100)
        assert.equal(meta.height, 67)
        assert.equal(meta.format, 'jpeg')
        assert.equal(meta.space, 'srgb')
    })

    it('should proxy directly from upload store', async function() {
        this.slow(1000)
        serveImage = false
        const uploaded = await uploadImage(fs.readFileSync(path.resolve(__dirname, 'test.jpg')), port)
        const [key, fname] = uploaded.body.url.split('/').slice(-2)
        const res = await needle('get', `http://localhost:${ port }/0x0/${ uploaded.body.url }`)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert((await storeExists(proxyStore, key)) === false, 'proxy store has original')
    })

    it('should not proxy stored uploads in unsupported formats', async function() {
        // written to the store directly, bypassing the upload handlers
        const data = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>')
        const imageHash = crypto.createHash('sha256')
            .update('ImageSigningChallenge')
            .update(data)
            .digest()
        const contentHash = 'D' + multihash.toB58String(multihash.encode(imageHash, 'sha2-256'))
        await storeWrite(uploadStore, getKeyNameFromHash(contentHash), data)
        const imageUrl = base58Enc(`http://localhost:${ port }/${ contentHash }/test.svg`)
        const res = await needle('get', `http://localhost:${ port }/p/${ imageUrl }?width=100`)
        assert.equal(res.statusCode, 400)
    })

    it('should proxy using new api', async function() {
        this.slow(1000)
        serveImage = false
        const imageUrl = base58Enc(`http://localhost:${ port+1 }/test.jpg`)
        const res = await needle('get', `http://localhost:${ port }/p/${ imageUrl }?width=100&height=100&format=webp`)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert.equal(meta.width, 100)
        assert.equal(meta.height, 100)
        assert.equal(meta.format, 'webp')
        assert.equal(meta.space, 'srgb')
    })

    it('should block blacklisted URL with query params appended', async function() {
        // Pick a URL from the static blacklist
        const blacklistedUrl = 'https://i.imgur.com/0XObSlG.jpg'
        // Verify the exact URL is blocked (Blacklisted = HTTP 451)
        const exactUrl = base58Enc(blacklistedUrl)
        const res1 = await needle('get', `http://localhost:${ port }/p/${ exactUrl }`)
        assert.equal(res1.statusCode, 451)

        // Verify appending query params doesn't bypass the blacklist
        const bypassUrl = base58Enc(blacklistedUrl + '?_=1')
        const res2 = await needle('get', `http://localhost:${ port }/p/${ bypassUrl }`)
        assert.equal(res2.statusCode, 451)

        // Verify appending fragment doesn't bypass the blacklist
        const fragmentUrl = base58Enc(blacklistedUrl + '#bypass')
        const res3 = await needle('get', `http://localhost:${ port }/p/${ fragmentUrl }`)
        assert.equal(res3.statusCode, 451)
    })

    it('should block blacklisted bare hash in path segments', function() {
        // Bare hash from the static blacklist
        const hash = 'DQmeLKjpW89de2DqfCYxdTM4HPvUgurmpJuZYAN9SP2c9Q5'
        // A URL containing the hash as a path segment should match
        const url = new URL(`https://images.example.com/${ hash }/image.jpg`)
        assert.equal(imageBlacklist.matchesUrl(url), true)
    })

    it('should not block non-blacklisted URLs', function() {
        const url = new URL('https://example.com/totally-fine-image.jpg?_=1')
        assert.equal(imageBlacklist.matchesUrl(url), false)
    })

    it('should not cache upstream errors', async function() {
        this.slow(1000)
        // Use a port where nothing is listening to get a connection refused error
        const badUrl = base58Enc(`http://localhost:${ port+99 }/nonexistent.jpg`)
        const res = await needle('get', `http://localhost:${ port }/p/${ badUrl }?width=100`)
        assert.equal(res.statusCode, 400)
        assert.equal(res.body.error.name, 'upstream_error')
        assert.equal(res.headers['cache-control'], 'no-store',
            'transient errors must not be cached by CDNs')
    })

    it('should resolve double proxied images', async function() {
        this.slow(1000)
        serveImage = false
        const imageUrl = base58Enc(`http://localhost:${ port+1 }/test.jpg`)
        const url1 = `http://localhost:${ port }/p/${ imageUrl }?width=100&height=100`
        const url2 = `http://localhost:${ port }/p/${ base58Enc(url1) }?width=200`
        const res = await needle('get', url2)
        console.log(res.body)
        const image = sharp(res.body)
        const meta = await image.metadata()
        assert.equal(meta.width, 200)
        // this would be 200 if the first url wasn't stripped
        assert.equal(meta.height, 133)
    })

    describe('original repair', function() {
        const fullImage = fs.readFileSync(path.resolve(__dirname, 'test.jpg'))
        // the first 320 KiB, as left behind by a partial fetch
        const truncatedImage = fullImage.subarray(0, 320 * 1024)
        let sosWarningImage: Buffer
        const requests = new Map<string, number>()

        const fixtureServer = http.createServer((req, res) => {
            const name = req.url || ''
            requests.set(name, (requests.get(name) || 0) + 1)
            if (name.startsWith('/full')) {
                res.writeHead(200, {'Content-Length': fullImage.length})
                res.end(fullImage)
            } else if (name.startsWith('/sos')) {
                res.writeHead(200, {'Content-Length': sosWarningImage.length})
                res.end(sosWarningImage)
            } else {
                res.writeHead(404)
                res.end()
            }
        })

        before(async function() {
            // A baseline JPEG whose SOS header carries progressive parameters, the
            // shape of the Samsung camera files in sharp#1880: libjpeg warns
            // "Invalid SOS parameters for sequential JPEG" and decodes it.
            sosWarningImage = await sharp({create: {width: 64, height: 48, channels: 3, background: '#4080c0'}})
                .jpeg({progressive: false})
                .toBuffer()
            const sos = sosWarningImage.indexOf(Buffer.from([0xFF, 0xDA]))
            const components = sosWarningImage[sos + 4]
            sosWarningImage[sos + 5 + components * 2 + 1] = 0 // Se, 63 for a sequential scan
        })
        // closes the connection after part of the body it announced
        const shortServer = net.createServer((socket) => {
            socket.once('data', () => {
                requests.set('short', (requests.get('short') || 0) + 1)
                socket.write(`HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: ${ fullImage.length }\r\n\r\n`)
                socket.end(truncatedImage)
            })
        })

        before((done) => { fixtureServer.listen(port + 2, '127.0.0.1', done) })
        after((done) => { fixtureServer.close(done) })
        before((done) => { shortServer.listen(port + 3, '127.0.0.1', done) })
        after((done) => { shortServer.close(done) })

        function sourceUrl(name: string) {
            return `http://localhost:${ port + 2 }/${ name }`
        }

        function originalKey(url: string) {
            const urlHash = crypto.createHash('sha1').update(new URL(url).toString()).digest()
            return getKeyNameFromHash('U' + multihash.toB58String(multihash.encode(urlHash, 'sha1')))
        }

        function proxy(url: string, query = 'width=100') {
            return needle('get', `http://localhost:${ port }/p/${ base58Enc(url) }?${ query }`)
        }

        it('should refetch and replace a truncated stored original', async function() {
            this.slow(2000)
            const url = sourceUrl('full-truncated.jpg')
            await storeWrite(proxyStore, originalKey(url), truncatedImage)
            const res = await proxy(url)
            assert.equal(res.statusCode, 200)
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.width, 100)
            assert.equal(meta.height, 67)
            assert.equal(requests.get('/full-truncated.jpg'), 1)
            const stored = await readStream(proxyStore.createReadStream(originalKey(url)))
            assert(stored.equals(fullImage), 'stored original was not replaced')
        })

        it('should keep a truncated stored original when the refetch fails', async function() {
            this.slow(2000)
            const url = sourceUrl('missing-truncated.jpg')
            await storeWrite(proxyStore, originalKey(url), truncatedImage)
            for (const attempt of [1, 2]) {
                const res = await proxy(url)
                assert.equal(res.statusCode, 400)
                assert.equal(res.body.error.name, 'invalid_image')
                assert.equal(requests.get('/missing-truncated.jpg'), attempt)
                const stored = await readStream(proxyStore.createReadStream(originalKey(url)))
                assert(stored.equals(truncatedImage), 'stored original was changed')
            }
        })

        it('should keep a truncated stored original when the source is unreachable', async function() {
            this.slow(2000)
            const url = `http://localhost:${ port + 99 }/truncated.jpg`
            await storeWrite(proxyStore, originalKey(url), truncatedImage)
            const res = await proxy(url)
            assert.equal(res.statusCode, 400)
            assert.equal(res.body.error.name, 'upstream_error')
            assert.equal(res.headers['cache-control'], 'no-store')
            const stored = await readStream(proxyStore.createReadStream(originalKey(url)))
            assert(stored.equals(truncatedImage), 'stored original was changed')
        })

        it('should resize a JPEG that decodes with a libjpeg warning', async function() {
            await assert.rejects(sharp(sosWarningImage).toBuffer(), /Invalid SOS parameters/)
            const res = await proxy(sourceUrl('sos.jpg'), 'width=32')
            assert.equal(res.statusCode, 200)
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.width, 32)
            assert.equal(meta.height, 24)
        })

        it('should not store a fetch shorter than its Content-Length', async function() {
            this.slow(2000)
            const url = `http://localhost:${ port + 3 }/short.jpg`
            const res = await proxy(url)
            assert.equal(res.statusCode, 400)
            assert.equal(res.body.error.name, 'upstream_error')
            assert.equal(res.headers['cache-control'], 'no-store')
            assert.equal(await storeExists(proxyStore, originalKey(url)), false)
            assert.equal(requests.get('short'), 1)
        })

        it('should not refetch an undecodable upload', async function() {
            const imageHash = crypto.createHash('sha256')
                .update('ImageSigningChallenge')
                .update(truncatedImage)
                .digest()
            const contentHash = 'D' + multihash.toB58String(multihash.encode(imageHash, 'sha2-256'))
            await storeWrite(uploadStore, getKeyNameFromHash(contentHash), truncatedImage)
            const url = `http://localhost:${ port }/${ contentHash }/truncated.jpg`
            const res = await proxy(url)
            assert.equal(res.statusCode, 500)
            assert.equal(res.body.error.name, 'internal_error')
            assert.equal(await storeExists(proxyStore, originalKey(url)), false)
            const stored = await readStream(uploadStore.createReadStream(getKeyNameFromHash(contentHash)))
            assert(stored.equals(truncatedImage), 'upload was changed')
        })

        describe('empty stored results', function() {
            const emptyResult = Buffer.alloc(0)
            const fitQuery = 'mode=fit&width=100'

            function resizedKey(url: string) {
                return `${ originalKey(url) }_100x0`
            }

            it('should regenerate an empty stored result', async function() {
                this.slow(2000)
                const url = sourceUrl('full-empty-result.jpg')
                await storeWrite(proxyStore, resizedKey(url), emptyResult)
                const res = await proxy(url, fitQuery)
                assert.equal(res.statusCode, 200)
                assert.equal(res.headers['content-type'], 'image/jpeg')
                const meta = await sharp(res.body).metadata()
                assert.equal(meta.width, 100)
                assert.equal(meta.height, 67)
                const stored = await readStream(proxyStore.createReadStream(resizedKey(url)))
                assert(stored.equals(res.body), 'stored result was not replaced')
            })

            it('should not store anything for an empty stored result whose source is unreachable', async function() {
                this.slow(2000)
                const url = `http://localhost:${ port + 99 }/empty-result.jpg`
                await storeWrite(proxyStore, resizedKey(url), emptyResult)
                const res = await proxy(url, fitQuery)
                assert.equal(res.statusCode, 400)
                assert.equal(res.body.error.name, 'upstream_error')
                assert.equal(res.headers['cache-control'], 'no-store')
                assert.equal(await storeExists(proxyStore, originalKey(url)), false)
                const stored = await readStream(proxyStore.createReadStream(resizedKey(url)))
                assert.equal(stored.length, 0)
            })

            it('should write one non-empty result on a first request', async function() {
                this.slow(2000)
                const url = sourceUrl('full-first-result.jpg')
                const res = await proxy(url, fitQuery)
                assert.equal(res.statusCode, 200)
                const stored = await readStream(proxyStore.createReadStream(resizedKey(url)))
                assert(stored.length > 0, 'stored result is empty')
                assert(stored.equals(res.body), 'stored result differs from the response')
            })

            it('should serve a non-empty stored result without resizing', async function() {
                const url = sourceUrl('full-stored-result.jpg')
                await storeWrite(proxyStore, resizedKey(url), sosWarningImage)
                const res = await proxy(url, fitQuery)
                assert.equal(res.statusCode, 200)
                assert(Buffer.from(res.body).equals(sosWarningImage), 'stored result was not served')
                assert.equal(res.headers['cache-control'], 'public,max-age=29030400,immutable')
                assert.equal(requests.get('/full-stored-result.jpg'), undefined)
            })
        })

        it('should fetch a valid original once', async function() {
            this.slow(2000)
            const url = sourceUrl('full-valid.jpg')
            assert.equal((await proxy(url, 'width=100')).statusCode, 200)
            assert.equal((await proxy(url, 'width=200')).statusCode, 200)
            assert.equal(requests.get('/full-valid.jpg'), 1)
        })
    })

})

describe('vips concurrency', function() {

    async function workerConcurrency(vipsConcurrency: string, module = './src/proxy') {
        const script = `require('${ module }'); process.stdout.write(String(require('sharp').concurrency()))`
        const {stdout} = await util.promisify(execFile)(process.execPath, ['-r', 'ts-node/register', '-e', script], {
            cwd: path.resolve(__dirname, '..'),
            env: {...process.env, NODE_ENV: 'test', TS_NODE_TRANSPILE_ONLY: 'true', VIPS_CONCURRENCY: vipsConcurrency},
        })
        return Number(stdout)
    }

    it('should apply the configured default', function() {
        assert.equal(sharp.concurrency(), 4)
    })

    it('should apply the VIPS_CONCURRENCY override', async function() {
        this.slow(10000)
        assert.equal(await workerConcurrency('3'), 3)
    })

    it('should keep the sharp default for 0', async function() {
        this.slow(10000)
        const sharpDefault = await workerConcurrency('0', 'sharp')
        assert.equal(await workerConcurrency('0'), sharpDefault)
    })

    it('should refuse to start with an invalid value', async function() {
        this.slow(10000)
        await assert.rejects(workerConcurrency('-1'), /Invalid vips concurrency/)
    })

})
