import 'mocha'
import assert from 'assert'
import {ChildProcess, execFile, spawn} from 'child_process'
import * as crypto from 'crypto'
import * as http from 'http'
import * as net from 'net'
import * as os from 'os'
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

    function originalKey(url: string) {
        const urlHash = crypto.createHash('sha1').update(new URL(url).toString()).digest()
        return getKeyNameFromHash('U' + multihash.toB58String(multihash.encode(urlHash, 'sha1')))
    }

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

    describe('oversize sources', function() {
        this.timeout(60000)
        const servicePort = port + 6
        const fixturePort = port + 7
        const fetchMaxBytes = 600000
        const storeOriginalMaxBytes = 50000
        const records: any[] = []
        const sources = new Map<string, Buffer>()
        const bytesWritten = new Map<string, number>()
        let child: ChildProcess
        let storePath: string

        /** Write length bytes in paced chunks, announcing them or not, until the client goes away. */
        function stream(name: string, res: http.ServerResponse, length: number, announce: boolean) {
            res.writeHead(200, announce ? {'Content-Type': 'image/jpeg', 'Content-Length': length} : {'Content-Type': 'image/jpeg'})
            const chunk = Buffer.alloc(16 * 1024, 0xFF)
            let written = 0
            const timer = setInterval(() => {
                if (res.destroyed || written >= length) {
                    clearInterval(timer)
                    res.end()
                    return
                }
                res.write(chunk)
                written += chunk.length
                bytesWritten.set(name, written)
            }, 2)
            res.once('close', () => clearInterval(timer))
        }

        const fixtureServer = http.createServer((req, res) => {
            const name = (req.url || '').slice(1)
            if (name === 'announced-huge.jpg') {
                stream(name, res, fetchMaxBytes * 10, true)
            } else if (name === 'streamed-huge.jpg') {
                stream(name, res, fetchMaxBytes * 10, false)
            } else if (sources.has(name)) {
                const data = sources.get(name)!
                res.writeHead(200, {'Content-Length': data.length})
                res.end(data)
            } else {
                res.writeHead(404)
                res.end()
            }
        })

        function noise(width: number, height: number) {
            return sharp({create: {width, height, channels: 3, background: '#000', noise: {type: 'gaussian', mean: 128, sigma: 60}}})
        }

        /** The service as `node src/app.ts`, with low fetch and store caps and an fs proxy store. */
        before(async function() {
            const large = await noise(500, 400).jpeg({quality: 90}).toBuffer()
            const frames = await Promise.all([0, 1, 2].map(() => noise(200, 150).png().toBuffer()))
            const largeGif = await sharp(frames, {join: {animated: true}}).gif({effort: 1}).toBuffer()
            const small = await sharp({create: {width: 64, height: 48, channels: 3, background: '#4080c0'}}).jpeg().toBuffer()
            for (const data of [large, largeGif]) {
                assert(data.length > storeOriginalMaxBytes && data.length < fetchMaxBytes, `fixture of ${ data.length } bytes`)
            }
            assert(small.length <= storeOriginalMaxBytes)
            sources.set('large.jpg', large)
            sources.set('large.gif', largeGif)
            sources.set('small.jpg', small)
            await new Promise<void>((resolve) => fixtureServer.listen(fixturePort, '127.0.0.1', resolve))

            storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'imagehoster-oversize-'))
            child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/app.ts'], {
                cwd: path.resolve(__dirname, '..'),
                env: {
                    ...process.env,
                    NODE_ENV: 'test',
                    TS_NODE_TRANSPILE_ONLY: 'true',
                    LOG_LEVEL: 'info',
                    PORT: String(servicePort),
                    NUM_WORKERS: '1',
                    NODE_CONFIG: JSON.stringify({proxy_store: {type: 'fs', path: storePath}}),
                    PROXY_FETCH_MAX_BYTES: String(fetchMaxBytes),
                    PROXY_STORE_ORIGINAL_MAX_BYTES: String(storeOriginalMaxBytes)
                },
                stdio: ['ignore', 'pipe', 'inherit']
            })
            let buffer = ''
            child.stdout!.on('data', (chunk: Buffer) => {
                const lines = (buffer + chunk.toString()).split('\n')
                buffer = lines.pop()!
                for (const line of lines) {
                    try {
                        records.push(JSON.parse(line))
                    } catch (error) {
                        continue
                    }
                }
            })
            const deadline = Date.now() + 30000
            while (!records.some((r) => r.msg === `listening on port ${ servicePort }`)) {
                assert(child.exitCode === null && Date.now() < deadline, 'service did not start')
                await new Promise((resolve) => setTimeout(resolve, 100))
            }
        })
        after(function(done) {
            child.kill('SIGKILL')
            fs.rmSync(storePath, {recursive: true, force: true})
            fixtureServer.close(() => done())
        })

        function sourceUrl(name: string) {
            return `http://localhost:${ fixturePort }/${ name }`
        }

        function proxy(url: string, query: string) {
            return needle('get', `http://localhost:${ servicePort }/p/${ base58Enc(url) }?${ query }`)
        }

        function stored(key: string) {
            return fs.existsSync(path.join(storePath, key))
        }

        function readSourceMarker(url: string) {
            return JSON.parse(fs.readFileSync(path.join(storePath, `${ originalKey(url) }.source`), 'utf8'))
        }

        it('should resize a source above the store cap, storing the variant and a marker but not the original', async function() {
            this.slow(5000)
            const url = sourceUrl('large.jpg')
            const source = sources.get('large.jpg')!
            const res = await proxy(url, 'width=300')
            assert.equal(res.statusCode, 200)
            const meta = await sharp(res.body).metadata()
            assert.equal(meta.width, 300)
            assert.equal(meta.format, 'jpeg')
            assert(stored(`${ originalKey(url) }_Cover_Match_300`), 'variant was not stored')
            assert.equal(stored(originalKey(url)), false)

            const marker = readSourceMarker(url)
            assert.equal(marker.stored, false)
            assert.equal(marker.url, url)
            assert.equal(marker.content_type, 'image/jpeg')
            assert.equal(marker.bytes, source.length)
            assert.equal(marker.width, 500)
            assert.equal(marker.height, 400)
            assert.equal(marker.pages, 1)
            assert.equal(marker.sha256, crypto.createHash('sha256').update(source).digest('hex'))
            assert.equal(typeof marker.version, 'string')

            const [log] = records.filter((r) => r.orig_key === originalKey(url) && r.msg.startsWith('oversize source'))
            assert.equal(log.source_host, `localhost:${ fixturePort }`)
            assert.equal(log.bytes, source.length)
            assert.equal(log.stored, false)
            assert.equal(typeof log.ms, 'number')

            // another size fetches the source again and rewrites the marker
            await new Promise((resolve) => setTimeout(resolve, 5))
            const second = await proxy(url, 'width=200')
            assert.equal(second.statusCode, 200)
            assert.equal((await sharp(second.body).metadata()).width, 200)
            assert(stored(`${ originalKey(url) }_Cover_Match_200`), 'second variant was not stored')
            assert.equal(stored(originalKey(url)), false)
            assert(Date.parse(readSourceMarker(url).fetched_at) > Date.parse(marker.fetched_at), 'marker was not rewritten')
        })

        it('should store a source at or below the store cap, without a marker', async function() {
            const url = sourceUrl('small.jpg')
            const res = await proxy(url, 'width=32')
            assert.equal(res.statusCode, 200)
            assert(fs.readFileSync(path.join(storePath, originalKey(url))).equals(sources.get('small.jpg')!), 'original was not stored')
            assert.equal(stored(`${ originalKey(url) }.source`), false)
        })

        it('should pass an unresized oversize GIF through without storing it', async function() {
            const url = sourceUrl('large.gif')
            const res = await proxy(url, 'mode=fit')
            assert.equal(res.statusCode, 200)
            assert.equal(res.headers['content-type'], 'image/gif')
            assert(Buffer.from(res.body).equals(sources.get('large.gif')!), 'source was not served')
            assert.equal(stored(originalKey(url)), false)
            const marker = readSourceMarker(url)
            assert.equal(marker.stored, false)
            assert.equal(marker.pages, 3)
            assert.equal(marker.width, 200)
            assert.equal(marker.height, 150)
        })

        it('should refuse a source announcing more than the fetch cap before reading it, cacheably', async function() {
            const url = sourceUrl('announced-huge.jpg')
            const res = await proxy(url, 'width=300')
            assert.equal(res.statusCode, 413)
            assert.equal(res.headers['cache-control'], 'public, max-age=86400')
            assert((bytesWritten.get('announced-huge.jpg') || 0) < fetchMaxBytes, `${ bytesWritten.get('announced-huge.jpg') } bytes written`)
            assert.equal(stored(originalKey(url)), false)
            const [log] = records.filter((r) => r.orig_key === originalKey(url) && r.msg.startsWith('oversize source'))
            assert.equal(log.announced_bytes, fetchMaxBytes * 10)
            assert.equal(log.max_bytes, fetchMaxBytes)
        })

        it('should abort a source streaming past the fetch cap without a Content-Length, cacheably', async function() {
            const url = sourceUrl('streamed-huge.jpg')
            const res = await proxy(url, 'width=300')
            assert.equal(res.statusCode, 413)
            assert.equal(res.headers['cache-control'], 'public, max-age=86400')
            // the client stops at the cap; a few paced chunks may be in flight
            const written = bytesWritten.get('streamed-huge.jpg') || 0
            assert(written < fetchMaxBytes + 256 * 1024, `${ written } bytes written`)
            assert.equal(stored(originalKey(url)), false)
            const [log] = records.filter((r) => r.orig_key === originalKey(url) && r.msg.startsWith('oversize source'))
            assert(log.received_bytes > fetchMaxBytes)
            assert.equal(log.announced_bytes, undefined)
        })

        it('should still refuse an upload above max_image_size', async function() {
            const status = await new Promise<number>((resolve, reject) => {
                const req = http.request({
                    host: '127.0.0.1',
                    port,
                    method: 'POST',
                    path: '/hs/token',
                    headers: {'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': 15000001}
                }, (res) => {
                    res.resume()
                    resolve(res.statusCode || 0)
                })
                req.on('error', reject)
                req.end()
            })
            assert.equal(status, 413)
        })
    })

    describe('animated images', function() {
        const fixtures = new Map<string, Buffer>()
        const fixtureServer = http.createServer((req, res) => {
            const data = fixtures.get(req.url || '')
            if (data) {
                res.writeHead(200, {'Content-Length': data.length})
                res.end(data)
            } else {
                res.writeHead(404)
                res.end()
            }
        })

        before((done) => { fixtureServer.listen(port + 4, '127.0.0.1', done) })
        after((done) => { fixtureServer.close(done) })

        /** A frame of gradients with a diagonal stripe pattern that moves with index. */
        function frame(width: number, height: number, index: number) {
            const raw = Buffer.alloc(width * height * 3)
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const offset = (y * width + x) * 3
                    raw[offset] = x * 255 / width
                    raw[offset + 1] = y * 255 / height
                    raw[offset + 2] = (index * 16 + x + y) & 255
                }
            }
            return sharp(raw, {raw: {width, height, channels: 3}}).png().toBuffer()
        }

        async function animation(format: 'gif' | 'webp', width: number, height: number, frames: number) {
            const pngs = await Promise.all(Array.from({length: frames}, (_, index) => frame(width, height, index)))
            const image = sharp(pngs, {join: {animated: true}})
            return (format === 'gif' ? image.gif({effort: 1}) : image.webp()).toBuffer()
        }

        function serve(name: string, data: Buffer) {
            fixtures.set(`/${ name }`, data)
            return `http://localhost:${ port + 4 }/${ name }`
        }

        function markerKey(imageKey: string) {
            return `${ imageKey }.animated-fallback`
        }

        let animatedGif: Buffer
        let animatedWebp: Buffer

        before(async function() {
            animatedGif = await animation('gif', 200, 150, 4)
            animatedWebp = await animation('webp', 200, 150, 4)
        })

        describe('within the bounds', function() {

            function proxy(url: string, query: string) {
                return needle('get', `http://localhost:${ port }/p/${ base58Enc(url) }?${ query }`)
            }

            /** Run with the animated pipeline, the only sharp instance given a timeout, replaced by replace. */
            async function withAnimatedPipeline<T>(replace: (image: any, args: any[], timeout: Function) => any, run: () => Promise<T>) {
                const timeout = sharp.prototype.timeout
                sharp.prototype.timeout = function(this: any, ...args: any[]) { return replace(this, args, timeout) }
                try {
                    return await run()
                } finally {
                    sharp.prototype.timeout = timeout
                }
            }

            function failingPipeline(message: string) {
                return (image: any) => {
                    image.toBuffer = () => Promise.reject(new Error(message))
                    return image
                }
            }

            async function readMarker(imageKey: string) {
                return JSON.parse((await readStream(proxyStore.createReadStream(markerKey(imageKey)))).toString())
            }

            it('should keep the animation of a resized GIF', async function() {
                this.slow(2000)
                const url = serve('animated.gif', animatedGif)
                const res = await needle('get', `http://localhost:${ port }/100x0/${ url }`)
                assert.equal(res.statusCode, 200)
                assert.equal(res.headers['content-type'], 'image/gif')
                const meta = await sharp(res.body).metadata()
                assert.equal(meta.format, 'gif')
                assert.equal(meta.pages, 4)
                assert.equal(meta.width, 100)
                assert.equal(meta.height, 75)
                const imageKey = `${ originalKey(url) }_100x0`
                assert(Buffer.from(res.body).equals(await readStream(proxyStore.createReadStream(imageKey))))
                assert.equal(await storeExists(proxyStore, markerKey(imageKey)), false)
            })

            it('should keep the animation of a resized WebP', async function() {
                this.slow(2000)
                const res = await proxy(serve('animated.webp', animatedWebp), 'width=100')
                assert.equal(res.statusCode, 200)
                assert.equal(res.headers['content-type'], 'image/webp')
                const meta = await sharp(res.body).metadata()
                assert.equal(meta.format, 'webp')
                assert.equal(meta.pages, 4)
                assert.equal(meta.width, 100)
            })

            it('should write the animation in an explicitly requested format', async function() {
                this.slow(2000)
                const asWebp = await proxy(serve('as-webp.gif', animatedGif), 'mode=fit&width=100&format=webp')
                assert.equal(asWebp.headers['content-type'], 'image/webp')
                const webpMeta = await sharp(asWebp.body).metadata()
                assert.equal(webpMeta.format, 'webp')
                assert.equal(webpMeta.pages, 4)
                // lossless, as lossy WebP is smaller than any GIF of it
                const lossless = await sharp(animatedGif, {animated: true}).webp({lossless: true}).toBuffer()
                const asGif = await proxy(serve('as-gif.webp', lossless), 'mode=fit&width=100&format=gif')
                assert.equal(asGif.headers['content-type'], 'image/gif')
                const gifMeta = await sharp(asGif.body).metadata()
                assert.equal(gifMeta.format, 'gif')
                assert.equal(gifMeta.pages, 4)
                assert.equal(gifMeta.width, 100)
            })

            it('should crop every frame alike in cover mode', async function() {
                this.slow(2000)
                const res = await proxy(serve('cover.gif', animatedGif), 'width=50&height=50')
                const meta = await sharp(res.body).metadata()
                assert.equal(meta.pages, 4)
                assert.equal(meta.width, 50)
                assert.equal(meta.height, 50)
            })

            it('should give the first frame for format=jpeg', async function() {
                const url = serve('as-jpeg.gif', animatedGif)
                const res = await proxy(url, 'mode=fit&width=100&format=jpeg')
                assert.equal(res.headers['content-type'], 'image/jpeg')
                const meta = await sharp(res.body).metadata()
                assert.equal(meta.format, 'jpeg')
                assert.equal(meta.pages, undefined)
                assert.equal(meta.width, 100)
                assert.equal(await storeExists(proxyStore, markerKey(`${ originalKey(url) }_Fit_JPEG_100`)), false)
            })

            it('should serve the original when the animation would grow', async function() {
                this.slow(2000)
                // GIF frames take several times the bytes of lossy WebP ones
                const url = serve('grows.webp', animatedWebp)
                const res = await proxy(url, 'mode=fit&width=150&format=gif')
                assert.equal(res.statusCode, 200)
                assert.equal(res.headers['content-type'], 'image/webp')
                assert(Buffer.from(res.body).equals(animatedWebp), 'original was not served')
                assert.equal(await storeExists(proxyStore, markerKey(`${ originalKey(url) }_Fit_GIF_150`)), false)
            })

            it('should delete the fallback marker of a key it animates', async function() {
                const url = serve('marked.gif', animatedGif)
                const imageKey = `${ originalKey(url) }_100x0`
                await storeWrite(proxyStore, markerKey(imageKey), JSON.stringify({reason: 'timeout'}))
                const res = await proxy(url, 'mode=fit&width=100')
                assert.equal((await sharp(res.body).metadata()).pages, 4)
                assert.equal(await storeExists(proxyStore, markerKey(imageKey)), false)
            })

            it('should resize 34 frames of 421x750 at the configured GIF effort in under 6 s', async function() {
                // about 2.5 s at effort 2 and 11 s at sharp's default effort 7 on a Xeon
                this.timeout(60000)
                this.slow(10000)
                const url = serve('large.gif', await animation('gif', 421, 750, 34))
                const start = Date.now()
                const res = await proxy(url, 'mode=fit&width=300')
                const elapsed = Date.now() - start
                const meta = await sharp(res.body).metadata()
                assert.equal(meta.pages, 34)
                assert.equal(meta.width, 300)
                assert(elapsed < 6000, `took ${ elapsed } ms`)
            })

            it('should resize single-frame GIF, WebP and PNG to a single frame', async function() {
                this.slow(2000)
                const still = await frame(200, 150, 0)
                const sources: Array<[string, Buffer]> = [
                    ['gif', await sharp(still).gif().toBuffer()],
                    ['webp', await sharp(still).webp().toBuffer()],
                    ['png', still]
                ]
                for (const [format, data] of sources) {
                    const url = serve(`still.${ format }`, data)
                    const res = await proxy(url, 'mode=fit&width=100')
                    assert.equal(res.headers['content-type'], `image/${ format }`)
                    const meta = await sharp(res.body).metadata()
                    assert.equal(meta.format, format)
                    assert.equal(meta.pages || 1, 1)
                    assert.equal(meta.width, 100)
                    assert.equal(await storeExists(proxyStore, markerKey(`${ originalKey(url) }_100x0`)), false)
                }
            })

            it('should serve a GIF that already fits a Fit box without the animated pipeline', async function() {
                this.timeout(60000)
                this.slow(10000)
                const source = await animation('gif', 421, 750, 34)
                const url = serve('fits.gif', source)
                const imageKey = `${ originalKey(url) }_640x0`
                await storeWrite(proxyStore, markerKey(imageKey), JSON.stringify({reason: 'timeout'}))
                let pipelines = 0
                const res = await withAnimatedPipeline((image, args, timeout) => {
                    pipelines++
                    return timeout.apply(image, args)
                }, () => needle('get', `http://localhost:${ port }/640x0/${ url }`))
                assert.equal(pipelines, 0)
                assert.equal(res.statusCode, 200)
                assert.equal(res.headers['content-type'], 'image/gif')
                assert(Buffer.from(res.body).equals(source), 'original was not served')
                assert.equal((await sharp(res.body).metadata()).pages, 34)
                assert(source.equals(await readStream(proxyStore.createReadStream(imageKey))))
                assert.equal(await storeExists(proxyStore, markerKey(imageKey)), false)
            })

            it('should keep a cropped animation larger than the source', async function() {
                this.slow(2000)
                // a two-colour checkerboard packs into a few bytes; upscaled, it does not
                const checkers = await Promise.all(Array.from({length: 4}, (_, index) => {
                    const raw = Buffer.alloc(60 * 40 * 3)
                    for (let pixel = 0; pixel < 60 * 40; pixel++) {
                        raw.fill((pixel % 60 + Math.floor(pixel / 60) + index) & 1 ? 255 : 0, pixel * 3, pixel * 3 + 3)
                    }
                    return sharp(raw, {raw: {width: 60, height: 40, channels: 3}}).png().toBuffer()
                }))
                const source = await sharp(checkers, {join: {animated: true}}).gif({effort: 10}).toBuffer()
                const res = await proxy(serve('cover-grows.gif', source), 'width=50&height=50&mode=cover')
                assert.equal(res.statusCode, 200)
                assert.equal(res.headers['content-type'], 'image/gif')
                assert(res.body.length > source.length, `output of ${ res.body.length } bytes is not larger than ${ source.length }`)
                const meta = await sharp(res.body).metadata()
                assert.equal(meta.pages, 4)
                assert.equal(meta.width, 50)
                assert.equal(meta.pageHeight || meta.height, 50)
            })

            it('should give the first frame when the animated pipeline fails, and mark it', async function() {
                const url = serve('fails.gif', animatedGif)
                const imageKey = `${ originalKey(url) }_100x0`
                await storeWrite(proxyStore, markerKey(imageKey), JSON.stringify({reason: 'timeout'}))
                const res = await withAnimatedPipeline(failingPipeline('gifsave: out of memory'), () => proxy(url, 'mode=fit&width=100'))
                assert.equal(res.statusCode, 200)
                assert.equal(res.headers['content-type'], 'image/gif')
                const meta = await sharp(res.body).metadata()
                assert.equal(meta.pages || 1, 1)
                assert.equal(meta.width, 100)
                const marker = await readMarker(imageKey)
                assert.equal(marker.reason, 'error')
                assert.equal(marker.error, 'gifsave: out of memory')
                assert.equal(marker.frames, 4)
            })

            it('should recognise a timeout behind another pipeline\'s error text', async function() {
                const url = serve('prefixed-timeout.gif', animatedGif)
                const imageKey = `${ originalKey(url) }_100x0`
                const message = 'VipsJpeg: premature end of JPEG file\ntimeout: 42% complete'
                await withAnimatedPipeline(failingPipeline(message), () => proxy(url, 'mode=fit&width=100'))
                const marker = await readMarker(imageKey)
                assert.equal(marker.reason, 'timeout')
                assert.equal(marker.error, message)
            })

            it('should pass an unresized GIF through', async function() {
                const res = await needle('get', `http://localhost:${ port }/p/${ base58Enc(serve('unresized.gif', animatedGif)) }`)
                assert.equal(res.headers['content-type'], 'image/gif')
                assert(Buffer.from(res.body).equals(animatedGif), 'original was not served')
            })
        })

        describe('beyond the bounds', function() {
            this.timeout(60000)
            const servicePort = port + 5
            const records: any[] = []
            let child: ChildProcess
            let storePath: string

            /** The service as `node src/app.ts`, with low bounds and an fs proxy store. */
            before(async function() {
                storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'imagehoster-animated-'))
                child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/app.ts'], {
                    cwd: path.resolve(__dirname, '..'),
                    env: {
                        ...process.env,
                        NODE_ENV: 'test',
                        TS_NODE_TRANSPILE_ONLY: 'true',
                        LOG_LEVEL: 'info',
                        PORT: String(servicePort),
                        NUM_WORKERS: '1',
                        NODE_CONFIG: JSON.stringify({proxy_store: {type: 'fs', path: storePath}}),
                        ANIMATED_MAX_FRAMES: '6',
                        ANIMATED_MAX_PIXELS: '2000000',
                        ANIMATED_TIMEOUT_S: '1',
                        ANIMATED_GIF_EFFORT: '10'
                    },
                    stdio: ['ignore', 'pipe', 'inherit']
                })
                let buffer = ''
                child.stdout!.on('data', (chunk: Buffer) => {
                    const lines = (buffer + chunk.toString()).split('\n')
                    buffer = lines.pop()!
                    for (const line of lines) {
                        try {
                            records.push(JSON.parse(line))
                        } catch (error) {
                            continue
                        }
                    }
                })
                const deadline = Date.now() + 30000
                while (!records.some((r) => r.msg === `listening on port ${ servicePort }`)) {
                    assert(child.exitCode === null && Date.now() < deadline, 'service did not start')
                    await new Promise((resolve) => setTimeout(resolve, 100))
                }
            })
            after(function() {
                child.kill('SIGKILL')
                fs.rmSync(storePath, {recursive: true, force: true})
            })

            function proxy(url: string, query: string) {
                return needle('get', `http://localhost:${ servicePort }/p/${ base58Enc(url) }?${ query }`)
            }

            function animatedLog(imageKey: string) {
                return records.filter((r) => r.image_key === imageKey && r.msg.startsWith('animated source'))
            }

            function readMarker(imageKey: string) {
                return JSON.parse(fs.readFileSync(path.join(storePath, markerKey(imageKey)), 'utf8'))
            }

            async function assertFirstFrame(res: any, width: number) {
                assert.equal(res.statusCode, 200)
                assert.equal(res.headers['content-type'], 'image/gif')
                const meta = await sharp(res.body).metadata()
                assert.equal(meta.pages || 1, 1)
                assert.equal(meta.width, width)
            }

            it('should give the first frame of a GIF beyond animated_max_frames, and mark it', async function() {
                this.slow(5000)
                const source = await animation('gif', 40, 30, 8)
                const url = serve('many-frames.gif', source)
                const imageKey = `${ originalKey(url) }_20x0`
                const res = await proxy(url, 'mode=fit&width=20')
                await assertFirstFrame(res, 20)
                const [log] = animatedLog(imageKey)
                assert.equal(log.fallback, 'frames')
                assert.equal(log.frames, 8)
                const marker = readMarker(imageKey)
                assert.equal(marker.reason, 'frames')
                assert.equal(marker.frames, 8)
                assert.equal(marker.pixels, 8 * 40 * 30)
                assert.equal(marker.source_bytes, source.length)
                assert.equal(typeof marker.version, 'string')
                assert(Date.parse(marker.time) > 0)

                // the stored result is served without the marker, and without converting again
                fs.unlinkSync(path.join(storePath, markerKey(imageKey)))
                const stored = await proxy(url, 'mode=fit&width=20')
                assert(Buffer.from(stored.body).equals(res.body))
                assert.equal(animatedLog(imageKey).length, 1)
            })

            it('should give the first frame of a GIF beyond animated_max_pixels, and mark it', async function() {
                this.slow(5000)
                const url = serve('many-pixels.gif', await animation('gif', 640, 640, 5))
                const imageKey = `${ originalKey(url) }_100x0`
                await assertFirstFrame(await proxy(url, 'mode=fit&width=100'), 100)
                assert.equal(animatedLog(imageKey)[0].fallback, 'pixels')
                const marker = readMarker(imageKey)
                assert.equal(marker.reason, 'pixels')
                assert.equal(marker.frames, 5)
                assert.equal(marker.pixels, 5 * 640 * 640)
            })

            it('should log a GIF that fits a Fit box as fits, beyond animated_max_frames', async function() {
                this.slow(10000)
                const source = await animation('gif', 421, 750, 34)
                const url = serve('fits-logged.gif', source)
                const imageKey = `${ originalKey(url) }_640x0`
                const res = await proxy(url, 'mode=fit&width=640')
                assert.equal(res.statusCode, 200)
                assert(Buffer.from(res.body).equals(source), 'original was not served')
                const [log] = animatedLog(imageKey)
                assert.equal(log.fallback, 'fits')
                assert.equal(log.frames, 34)
                assert.equal(log.output_bytes, source.length)
                assert.equal(fs.existsSync(path.join(storePath, markerKey(imageKey))), false)
            })

            it('should give the first frame when the animation times out, mark it and retry once the result is deleted', async function() {
                this.slow(20000)
                // noise takes cgif at effort 10 well beyond a second
                const noise = await Promise.all(Array.from({length: 6}, () => sharp({
                    create: {width: 560, height: 560, channels: 3, background: '#000', noise: {type: 'gaussian', mean: 128, sigma: 60}}
                }).png().toBuffer()))
                const url = serve('slow.gif', await sharp(noise, {join: {animated: true}}).gif({effort: 1}).toBuffer())
                const imageKey = `${ originalKey(url) }_Cover_GIF_550`

                await assertFirstFrame(await proxy(url, 'width=550&format=gif'), 550)
                const [first] = animatedLog(imageKey)
                assert.equal(first.fallback, 'timeout')
                assert(first.ms < 15000, `timed out after ${ first.ms } ms`)
                const marker = readMarker(imageKey)
                assert.equal(marker.reason, 'timeout')
                assert.equal(marker.frames, 6)
                const health = await needle('get', `http://localhost:${ servicePort }/.well-known/healthcheck.json`)
                assert.equal(health.statusCode, 200)

                fs.unlinkSync(path.join(storePath, imageKey))
                await assertFirstFrame(await proxy(url, 'width=550&format=gif'), 550)
                const attempts = animatedLog(imageKey)
                assert.equal(attempts.length, 2)
                assert.equal(attempts[1].fallback, 'timeout')
                assert(Date.parse(readMarker(imageKey).time) > Date.parse(marker.time), 'marker was not rewritten')
            })
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
