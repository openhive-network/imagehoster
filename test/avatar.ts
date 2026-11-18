import 'mocha'
import assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import needle from 'needle'
import * as path from 'path'

import {app} from './../src/app'
import {rpcClient} from './../src/common'
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
})
