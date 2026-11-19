import 'mocha'
import assert from 'assert'
import * as http from 'http'
import needle from 'needle'
import config from 'config'

import {accountBlacklist} from './../src/blacklist'
import {logger} from './../src/logger'
import {checkUrl} from './../src/whitelist'

// We test checkUrl by running a mock HTTP server and pointing to it via env var.
// The whitelist module reads config at call time, so we set env vars before importing.

describe('whitelist', function() {

    let mockResponse: string = '"whitelisted"'
    let lastRequestBody: any = null
    const apiPort = 63207

    const apiServer = http.createServer((req, res) => {
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', () => {
            lastRequestBody = JSON.parse(body)
            res.writeHead(200, {'Content-Type': 'application/json'})
            res.end(mockResponse)
        })
    })

    before((done) => { apiServer.listen(apiPort, '127.0.0.1', done) })
    after((done) => { apiServer.close(done) })

    // checkUrl reads config on each call, so we can manipulate via the config object
    // Since config properties are immutable after load, we mock checkUrl's behavior
    // by testing the API server interaction directly via fetch.
    // For the actual checkUrl function, we test with whitelist disabled (default).

    it('should return whitelisted when disabled (default)', async function() {
        // In test config, whitelist.enabled defaults to false
        const {checkUrl} = require('./../src/whitelist')
        const status = await checkUrl('https://example.com/image.jpg')
        assert.equal(status, 'whitelisted')
    })

    it('mock API should respond to whitelist check requests', async function() {
        mockResponse = '"whitelisted"'
        const res = await needle('post', `http://localhost:${apiPort}/whitelist/check`,
            JSON.stringify({url: 'https://example.com/test.jpg'}), {
            json: false,
            headers: {'Content-Type': 'application/json'}
        })
        assert.equal(res.body, 'whitelisted')
        assert.equal(lastRequestBody.url, 'https://example.com/test.jpg')
    })

    it('mock API should return blacklisted', async function() {
        mockResponse = '"blacklisted"'
        const res = await needle('post', `http://localhost:${apiPort}/whitelist/check`,
            JSON.stringify({url: 'https://evil.com/bad.jpg'}), {
            json: false,
            headers: {'Content-Type': 'application/json'}
        })
        assert.equal(res.body, 'blacklisted')
    })

    it('mock API should return unknown', async function() {
        mockResponse = '"unknown"'
        const res = await needle('post', `http://localhost:${apiPort}/whitelist/check`,
            JSON.stringify({url: 'https://new-site.com/image.jpg'}), {
            json: false,
            headers: {'Content-Type': 'application/json'}
        })
        assert.equal(res.body, 'unknown')
    })

    describe('checkUrl with the whitelist enabled', function() {
        const cfg = config as any
        const originalFetch = globalThis.fetch
        const originalEntries = accountBlacklist.entries
        let blacklistEntries: string[] = []

        before(() => {
            const get = config.get.bind(config)
            const has = config.has.bind(config)
            cfg.get = (key: string) => {
                if (key === 'whitelist.enabled') { return true }
                if (key === 'whitelist.apiUrl') { return `http://127.0.0.1:${apiPort}` }
                return get(key)
            }
            cfg.has = (key: string) => key === 'whitelist.apiUrl' || has(key)
            accountBlacklist.entries = () => blacklistEntries
        })

        after(() => {
            delete cfg.get
            delete cfg.has
            accountBlacklist.entries = originalEntries
            globalThis.fetch = originalFetch
        })

        beforeEach(() => {
            mockResponse = '"whitelisted"'
            lastRequestBody = null
        })

        it('sends the account blacklist with the url', async function() {
            blacklistEntries = ['alice', 'bob']
            mockResponse = '"unknown"'
            const status = await checkUrl('https://example.com/a.jpg')
            assert.equal(status, 'unknown')
            assert.deepEqual(lastRequestBody, {
                url: 'https://example.com/a.jpg',
                blacklisted_accounts: ['alice', 'bob'],
            })
        })

        it('omits blacklisted_accounts when the blacklist is empty', async function() {
            blacklistEntries = []
            mockResponse = '"blacklisted"'
            const status = await checkUrl('https://example.com/b.jpg')
            assert.equal(status, 'blacklisted')
            assert.deepEqual(lastRequestBody, {url: 'https://example.com/b.jpg'})
        })

        it('sends the blacklist as it is at the time of each check', async function() {
            blacklistEntries = ['alice']
            await checkUrl('https://example.com/c.jpg')
            assert.deepEqual(lastRequestBody.blacklisted_accounts, ['alice'])
            blacklistEntries = ['alice', 'carol']
            const status = await checkUrl('https://example.com/c.jpg')
            assert.equal(status, 'whitelisted')
            assert.deepEqual(lastRequestBody.blacklisted_accounts, ['alice', 'carol'])
        })

        it('fails open with a warning when the request fails', async function() {
            blacklistEntries = ['alice']
            const originalWarn = logger.warn
            const warnings: any[][] = []
            logger.warn = ((...args: any[]) => { warnings.push(args) }) as any
            globalThis.fetch = async () => { throw new Error('connection refused') }
            try {
                const status = await checkUrl('https://example.com/d.jpg')
                assert.equal(status, 'whitelisted')
            } finally {
                globalThis.fetch = originalFetch
                logger.warn = originalWarn
            }
            assert.equal(warnings.length, 1)
            assert.equal(warnings[0][0].message, 'connection refused')
            assert.equal(lastRequestBody, null)
        })
    })

})
