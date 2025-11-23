import * as assert from 'assert'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import 'mocha'
import * as needle from 'needle'
import * as path from 'path'

import {app} from './../src/app'

import {testKeys} from './index'

export async function uploadImage(filename: string, data: Buffer, type: string, port: number) {
    return new Promise<any>((resolve, reject) => {
        const hash = crypto.createHash('sha256')
            .update('ImageSigningChallenge')
            .update(data)
            .digest()
        const payload = {
            foo: 'bar',
            image_file: {
                filename,
                buffer: data,
                content_type: type,
            },
        }
        const signature = testKeys.foo.sign(hash).toString()
        const url = `http://localhost:${ port }/foo/${ signature }`
        needle.post(
            url,
            payload,
    {multipart: true},
            (error, response, body) => {
                if (error) {
                    reject(error)
                } else {
                    resolve({response, body})
                }
            },
        )
    })
}

describe('upload', () => {
    const port = 63205
    const server = http.createServer(app.callback())

    before((done) => { server.listen(port, 'localhost', done) })
    after((done) => { server.close(done) })

    it('should upload image', async function() {
        this.slow(500)
        const file = path.resolve(__dirname, 'test.jpg')
        const data = fs.readFileSync(file)
        const {response, body} = await uploadImage("test.jpg", data, 'image/jpeg', port)
        assert.equal(response.statusCode, 200)
        const {url} = body
        const [key, fname] = url.split('/').slice(-2)
        assert.equal(key, 'DQmZi174Xz96UrRVBMNRHb6A2FfU3z1HRPwPPQCgSMgdiUT')
        assert.equal(fname, 'test.jpg')
        const res = await needle('get', `:${ port }/${ key }/bla.bla`)
        assert.equal(res.statusCode, 200)
        assert(crypto.timingSafeEqual(res.body, data), 'file same')
    })

    it('should upload heic image', async function() {
        this.slow(500)
        const file = path.resolve(__dirname, 'test.heic')
        const data = fs.readFileSync(file)
        const {response, body} = await uploadImage("test.heic", data, 'image/heic', port)
        assert.equal(response.statusCode, 200)
        const {url} = body
        const [key, fname] = url.split('/').slice(-2)
        assert.equal(key, 'DQmbqpcPFY7pzh5RzNKCswJXf2jkxw44SQ3m6fauGovgm7A')
        assert.equal(fname, 'test.heic')
        const res = await needle('get', `:${ port }/${ key }/bla.bla`)
        assert.equal(res.statusCode, 200)
        assert.equal(res.headers['content-type'], 'image/webp')
        assert(crypto.timingSafeEqual(res.body, data), 'file same')
    })

})
