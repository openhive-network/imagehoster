import 'mocha'
import * as assert from 'assert'
import * as crypto from 'crypto'
import * as http from 'http'
import * as needle from 'needle'

import {app} from './../src/app'
import {testKeys} from './index'

describe('proxy-auth', function() {
    const port = 63205
    const server = http.createServer(app.callback())

    before((done) => { server.listen(port, 'localhost', done) })
    after((done) => { server.close(done) })

    function makeSignature(username: string, timestamp: number) {
        const challenge = `Authorize image proxy preview for ${username} at ${new Date(timestamp).toISOString()}`
        const challengeHash = crypto.createHash('sha256').update(challenge).digest()
        return testKeys.foo.sign(challengeHash).toString()
    }

    it('should reject GET requests (no route)', async function() {
        const res = await needle('get', `http://localhost:${port}/proxy-auth/foo/fakesig`)
        // proxy-auth is POST-only, GET returns 404 (no matching route)
        assert.equal(res.statusCode, 404)
    })

    it('should reject when Redis is not configured', async function() {
        const timestamp = Date.now()
        const sig = makeSignature('foo', timestamp)
        const res = await needle('post', `http://localhost:${port}/proxy-auth/foo/${sig}`,
            JSON.stringify({timestamp}), {
            json: false,
            headers: {'Content-Type': 'application/json'}
        })
        // Without Redis, the handler returns 400 "Redis not configured"
        assert.equal(res.statusCode, 400)
        const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body
        assert(body.error, 'should return error')
    })

    it('should reject missing timestamp', async function() {
        const timestamp = Date.now()
        const sig = makeSignature('foo', timestamp)
        const res = await needle('post', `http://localhost:${port}/proxy-auth/foo/${sig}`, '{}', {
            json: false,
            headers: {'Content-Type': 'application/json'}
        })
        assert.equal(res.statusCode, 400)
    })

    it('should reject expired timestamp', async function() {
        const timestamp = Date.now() - 10 * 60 * 1000 // 10 minutes ago
        const sig = makeSignature('foo', timestamp)
        const res = await needle('post', `http://localhost:${port}/proxy-auth/foo/${sig}`,
            JSON.stringify({timestamp}), {
            json: false,
            headers: {'Content-Type': 'application/json'}
        })
        assert.equal(res.statusCode, 400)
    })

    it('should issue token for valid signature (requires Redis)', async function() {
        this.slow(1000)
        const config = require('config')
        if (!config.has('redis_url')) {
            this.skip()
            return
        }
        const timestamp = Date.now()
        const sig = makeSignature('foo', timestamp)
        const res = await needle('post', `http://localhost:${port}/proxy-auth/foo/${sig}`,
            JSON.stringify({timestamp}), {
            json: false,
            headers: {'Content-Type': 'application/json'}
        })
        assert.equal(res.statusCode, 200)
        const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body
        assert(body.token, 'response should include token')
        assert.equal(body.expires_in, 1800)
        assert.equal(body.token.length, 48) // 24 random bytes as hex
    })

    it('should reject invalid signature (requires Redis)', async function() {
        this.slow(1000)
        const config = require('config')
        if (!config.has('redis_url')) {
            this.skip()
            return
        }
        const timestamp = Date.now()
        // Sign with foo's key but claim to be bar (bar has different posting keys)
        const sig = makeSignature('foo', timestamp)
        const res = await needle('post', `http://localhost:${port}/proxy-auth/bar/${sig}`,
            JSON.stringify({timestamp}), {
            json: false,
            headers: {'Content-Type': 'application/json'}
        })
        assert.equal(res.statusCode, 401)
    })

})
