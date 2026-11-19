import 'mocha'
import assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import needle from 'needle'
import * as path from 'path'
import config from 'config'

import {app} from './../src/app'
import {rpcClient} from './../src/common'
import {APIError} from './../src/error'
import {logger} from './../src/logger'
import {base58Enc} from './../src/utils'

const RedirectCacheControl = 'public, s-maxage=86400, max-age=600'

describe('avatar and cover', function() {
    const port = 63215
    const server = http.createServer(app.callback())
    const imageServer = http.createServer((req, res) => {
        fs.createReadStream(path.resolve(__dirname, 'test.jpg')).pipe(res)
    })

    const avatarUrl = `http://localhost:${ port + 1 }/avatar.jpg`
    const coverUrl = `http://localhost:${ port + 1 }/cover.jpg`
    const accounts: {[name: string]: any} = {
        alice: {
            name: 'alice',
            json_metadata: '',
            posting_json_metadata: JSON.stringify({
                profile: {version: 2, profile_image: avatarUrl, cover_image: coverUrl}
            }),
        },
        'good-karma': {name: 'good-karma', json_metadata: '{}'},
        'abc.def-g': {name: 'abc.def-g', json_metadata: '{}'},
    }

    const database = rpcClient.database as any
    let originalGetAccounts: any
    let lookups: string[][]

    before((done) => { server.listen(port, '127.0.0.1', done) })
    after((done) => { server.close(done) })
    before((done) => { imageServer.listen(port + 1, '127.0.0.1', done) })
    after((done) => { imageServer.close(done) })

    before(() => {
        originalGetAccounts = database.getAccounts
        database.getAccounts = async (names: string[]) => {
            lookups.push(names)
            return names.map((name) => accounts[name]).filter(Boolean)
        }
    })
    after(() => { database.getAccounts = originalGetAccounts })
    beforeEach(() => { lookups = [] })

    const get = (urlPath: string) =>
        needle('get', `http://localhost:${ port }${ urlPath }`, {follow_max: 0} as any)

    const avatarCases: Array<[string, number]> = [
        ['/u/alice/avatar', 128],
        ['/u/alice/avatar/small', 64],
        ['/u/alice/avatar/medium', 128],
        ['/u/alice/avatar/large', 512],
    ]
    for (const [urlPath, size] of avatarCases) {
        it(`should redirect ${ urlPath } with split edge/browser lifetimes`, async function() {
            const res = await get(urlPath)
            assert.equal(res.statusCode, 302)
            assert.equal(res.headers['location'], `/p/${ base58Enc(avatarUrl) }?width=${ size }&height=${ size }`)
            assert.equal(res.headers['cache-control'], RedirectCacheControl)
            assert.deepEqual(lookups, [['alice']])
        })
    }

    it('should redirect cover with split edge/browser lifetimes', async function() {
        const res = await get('/u/alice/cover')
        assert.equal(res.statusCode, 302)
        assert.equal(res.headers['location'], `/p/${ base58Enc(coverUrl) }?width=1344&height=240`)
        assert.equal(res.headers['cache-control'], RedirectCacheControl)
        assert.deepEqual(lookups, [['alice']])
    })

    it('should keep immutable caching on the redirect target', async function() {
        this.slow(1000)
        const redirect = await get('/u/alice/avatar/small')
        const res = await get(redirect.headers['location'] as string)
        assert.equal(res.statusCode, 200)
        assert.equal(res.headers['cache-control'], 'public,max-age=29030400,immutable')
    })

    for (const urlPath of ['/u/nobody/avatar', '/u/nobody/cover']) {
        it(`should answer ${ urlPath } with no_such_account and no cache header`, async function() {
            const res = await get(urlPath)
            assert.equal(res.statusCode, 404)
            assert.equal(res.body.error.name, 'no_such_account')
            assert.equal(res.headers['cache-control'], undefined)
            assert.equal(res.headers['location'], undefined)
            assert.deepEqual(lookups, [['nobody']])
        })
    }

    for (const name of ['good-karma', 'abc.def-g']) {
        it(`should look up the valid name ${ name } and redirect`, async function() {
            const res = await get(`/u/${ name }/avatar`)
            assert.equal(res.statusCode, 302)
            assert.deepEqual(lookups, [[name]])
        })
    }

    const invalidPaths = [
        '/u/waivio.marketplace/avatar',
        '/u/Gandalf/avatar',
        '/u/-bad/avatar',
        '/u/dmitry-the-builder/avatar/small',
        '/u/waivio.marketplace/cover',
    ]
    for (const urlPath of invalidPaths) {
        it(`should answer ${ urlPath } like a missing account without an RPC`, async function() {
            const emitted: any[] = []
            const onError = (error: any) => { emitted.push(error) }
            app.on('error', onError)
            let res: any
            try {
                res = await get(urlPath)
            } finally {
                app.removeListener('error', onError)
            }
            const missing = await get(urlPath.replace(/^\/u\/[^/]+/, '/u/nobody'))
            assert.equal(res.statusCode, 404)
            assert.equal(res.body.error.name, 'no_such_account')
            assert.equal(res.headers['cache-control'], missing.headers['cache-control'])
            assert.equal(res.headers['location'], missing.headers['location'])
            assert.deepEqual(lookups, [['nobody']])
            assert.equal(emitted.length, 1)
            assert.ok(emitted[0] instanceof APIError)
            assert.equal(emitted[0].code, APIError.Code.NoSuchAccount)
            assert.ok(emitted[0].statusCode < 500)
        })
    }

    describe('with the whitelist API', function() {
        const cfg = config as any
        const apiUrl = 'http://whitelist.test'
        const profileTimeoutMs = 50
        const originalFetch = globalThis.fetch
        const originalWarn = logger.warn
        const originalDateNow = Date.now
        const originalStreams = (logger as any).streams.slice()
        const originalLevel = logger.level()
        let enabled = true
        let apiUrlSet = true
        let respond: (url: string, signal: AbortSignal) => Promise<Response>
        let fetches: string[]
        let warnings: any[][]
        let records: any[]
        let clockOffset = 0

        const json = (value: any, status = 200) => async () =>
            new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}})

        before(() => {
            const getConfig = config.get.bind(config)
            const hasConfig = config.has.bind(config)
            cfg.get = (key: string) => {
                if (key === 'whitelist.enabled') { return enabled }
                if (key === 'whitelist.apiUrl') { return apiUrlSet ? apiUrl : getConfig(key) }
                if (key === 'whitelist.profileTimeoutMs') { return profileTimeoutMs }
                return getConfig(key)
            }
            cfg.has = (key: string) => (key === 'whitelist.apiUrl' && apiUrlSet) || hasConfig(key)
            globalThis.fetch = (async (input: any, init?: RequestInit) => {
                fetches.push(String(input))
                return respond(String(input), init!.signal as AbortSignal)
            }) as typeof fetch
            logger.warn = ((...args: any[]) => { warnings.push(args) }) as any
            // the warning throttle is per minute and shared by all tests; give each test a fresh minute
            Date.now = () => originalDateNow() + clockOffset
            logger.addStream({type: 'raw', level: 'info', stream: {write: (rec: any) => { records.push(rec) }} as any})
        })

        after(() => {
            delete cfg.get
            delete cfg.has
            globalThis.fetch = originalFetch
            logger.warn = originalWarn
            Date.now = originalDateNow
            ;(logger as any).streams = originalStreams
            logger.level(originalLevel)
        })

        beforeEach(() => {
            enabled = true
            apiUrlSet = true
            fetches = []
            warnings = []
            records = []
            clockOffset += 2 * 60 * 1000
        })

        const responseLog = async () => {
            for (let i = 0; i < 50 && !records.some((rec) => rec.msg === 'response'); i++) {
                await new Promise((resolve) => setTimeout(resolve, 10))
            }
            const rec = records.find((r) => r.msg === 'response')
            assert.ok(rec, 'no response log record')
            return rec
        }

        const kinds = [
            {
                kind: 'avatar',
                urlPath: (name: string) => `/u/${ name }/avatar`,
                target: (url: string) => `/p/${ base58Enc(url) }?width=128&height=128`,
                defaultUrl: config.get('default_avatar') as string,
                rpcUrl: avatarUrl,
            },
            {
                kind: 'cover',
                urlPath: (name: string) => `/u/${ name }/cover`,
                target: (url: string) => `/p/${ base58Enc(url) }?width=1344&height=240`,
                defaultUrl: config.get('default_cover') as string,
                rpcUrl: coverUrl,
            },
        ]

        for (const {kind, urlPath, target, defaultUrl, rpcUrl} of kinds) {
            const sourceKey = `${ kind }_source`

            it(`should redirect ${ kind } to the URL the API answers without an RPC`, async function() {
                respond = json('https://x/a.png')
                const res = await get(urlPath('gandalf'))
                assert.equal(res.statusCode, 302)
                assert.equal(res.headers['location'], target('https://x/a.png'))
                assert.equal(res.headers['cache-control'], RedirectCacheControl)
                assert.deepEqual(fetches, [`${ apiUrl }/${ kind }/gandalf`])
                assert.deepEqual(lookups, [])
                assert.match(res.headers['server-timing'] as string, new RegExp(`^wl;dur=[0-9.]+;desc="whitelist /${ kind }"$`))
                assert.equal((await responseLog())[sourceKey], 'api')
            })

            it(`should redirect ${ kind } to the default when the API answers null`, async function() {
                respond = json(null)
                const res = await get(urlPath('gandalf'))
                assert.equal(res.statusCode, 302)
                assert.equal(res.headers['location'], target(defaultUrl))
                assert.deepEqual(lookups, [])
                assert.equal((await responseLog())[sourceKey], 'default')
            })

            it(`should treat a non-http ${ kind } from the API like null`, async function() {
                respond = json('javascript:alert(1)')
                const res = await get(urlPath('gandalf'))
                assert.equal(res.headers['location'], target(defaultUrl))
                assert.deepEqual(lookups, [])
            })

            it(`should fall back to the RPC for ${ kind } on a 404 without a warning`, async function() {
                respond = json({message: 'not found'}, 404)
                const res = await get(urlPath('alice'))
                assert.equal(res.statusCode, 302)
                assert.equal(res.headers['location'], target(rpcUrl))
                assert.equal(res.headers['cache-control'], RedirectCacheControl)
                assert.deepEqual(lookups, [['alice']])
                assert.equal(warnings.length, 0)
                assert.match(res.headers['server-timing'] as string, /wl;dur=[0-9.]+;desc="whitelist \//)
                if (kind === 'avatar') {
                    assert.match(res.headers['server-timing'] as string, /api;dur=[0-9.]+;desc="get_accounts API call"/)
                }
                assert.equal((await responseLog())[sourceKey], 'rpc')
            })

            it(`should keep no_such_account for ${ kind } when neither the API nor the RPC knows the account`, async function() {
                respond = json(null, 404)
                const res = await get(urlPath('nobody'))
                assert.equal(res.statusCode, 404)
                assert.equal(res.body.error.name, 'no_such_account')
                assert.equal(res.headers['cache-control'], undefined)
                assert.deepEqual(lookups, [['nobody']])
            })

            const failures: Array<[string, (url: string, signal: AbortSignal) => Promise<Response>]> = [
                ['a timeout', (url, signal) => new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => { reject(signal.reason) })
                })],
                ['a 500', json({message: 'boom'}, 500)],
                ['a non-JSON body', async () => new Response('<html>bad gateway</html>', {status: 200})],
                ['a connection error', async () => { throw new TypeError('fetch failed') }],
            ]
            for (const [failure, failingRespond] of failures) {
                it(`should fall back to the RPC for ${ kind } on ${ failure }, warning once per minute`, async function() {
                    respond = failingRespond
                    for (let i = 0; i < 3; i++) {
                        const res = await get(urlPath('alice'))
                        assert.equal(res.statusCode, 302)
                        assert.equal(res.headers['location'], target(rpcUrl))
                        assert.equal(res.headers['cache-control'], RedirectCacheControl)
                    }
                    assert.deepEqual(lookups, [['alice'], ['alice'], ['alice']])
                    assert.equal(fetches.length, 3)
                    assert.equal(warnings.length, 1)
                    assert.equal(warnings[0][0].profile_kind, kind)
                    clockOffset += 61 * 1000
                    await get(urlPath('alice'))
                    assert.equal(warnings.length, 2)
                    assert.equal(warnings[1][0].suppressed, 2)
                })
            }

            it(`should not call the API for ${ kind } when the whitelist is disabled`, async function() {
                enabled = false
                respond = json('https://x/a.png')
                const res = await get(urlPath('alice'))
                assert.equal(res.headers['location'], target(rpcUrl))
                assert.deepEqual(fetches, [])
                assert.deepEqual(lookups, [['alice']])
                assert.ok(!/wl;/.test(String(res.headers['server-timing'] || '')))
                assert.equal((await responseLog())[sourceKey], 'rpc')
            })

            it(`should not call the API for ${ kind } without an apiUrl`, async function() {
                apiUrlSet = false
                respond = json('https://x/a.png')
                const res = await get(urlPath('alice'))
                assert.equal(res.headers['location'], target(rpcUrl))
                assert.deepEqual(fetches, [])
                assert.deepEqual(lookups, [['alice']])
            })

            it(`should answer an invalid name on ${ kind } with 404 before any network call`, async function() {
                respond = json('https://x/a.png')
                const res = await get(urlPath('waivio.marketplace'))
                assert.equal(res.statusCode, 404)
                assert.equal(res.body.error.name, 'no_such_account')
                assert.deepEqual(fetches, [])
                assert.deepEqual(lookups, [])
            })
        }
    })
})
