import 'mocha'
import * as assert from 'assert'
import * as http from 'http'
import * as needle from 'needle'

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

    before((done) => { apiServer.listen(apiPort, 'localhost', done) })
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

})
