import 'mocha'
import * as assert from 'assert'

import {parseBool, isPrivateIP} from './../src/utils'

describe('utils', function() {

    it('parseBool', function() {
        assert.equal(parseBool('n'), false)
        assert.equal(parseBool(' No'), false)
        assert.equal(parseBool('oFF'), false)
        assert.equal(parseBool(false), false)
        assert.equal(parseBool(0), false)
        assert.equal(parseBool('0'), false)
        assert.equal(parseBool('Y'), true)
        assert.equal(parseBool('yes  '), true)
        assert.equal(parseBool('on'), true)
        assert.equal(parseBool(true), true)
        assert.equal(parseBool(1), true)
        assert.equal(parseBool('1'), true)
        assert.throws(() => {
            parseBool('banana')
        })
    })

    it('isPrivateIP', function() {
        // IPv4 private
        assert.equal(isPrivateIP('127.0.0.1'), true)
        assert.equal(isPrivateIP('10.0.0.1'), true)
        assert.equal(isPrivateIP('172.16.0.1'), true)
        assert.equal(isPrivateIP('172.31.255.255'), true)
        assert.equal(isPrivateIP('192.168.1.1'), true)
        assert.equal(isPrivateIP('169.254.1.1'), true)
        assert.equal(isPrivateIP('0.0.0.0'), true)
        assert.equal(isPrivateIP('224.0.0.1'), true)

        // IPv4 public
        assert.equal(isPrivateIP('8.8.8.8'), false)
        assert.equal(isPrivateIP('1.1.1.1'), false)
        assert.equal(isPrivateIP('172.32.0.1'), false)
        assert.equal(isPrivateIP('192.169.1.1'), false)

        // IPv6 private
        assert.equal(isPrivateIP('::1'), true)
        assert.equal(isPrivateIP('::'), true)
        assert.equal(isPrivateIP('fe80::1'), true)
        assert.equal(isPrivateIP('fc00::1'), true)
        assert.equal(isPrivateIP('fd12::1'), true)
        assert.equal(isPrivateIP('ff02::1'), true)

        // IPv4-mapped IPv6 — dotted form
        assert.equal(isPrivateIP('::ffff:127.0.0.1'), true)
        assert.equal(isPrivateIP('::ffff:10.0.0.1'), true)
        assert.equal(isPrivateIP('::ffff:8.8.8.8'), false)

        // IPv4-mapped IPv6 — hex form (the bypass we fixed)
        assert.equal(isPrivateIP('::ffff:7f00:1'), true)   // 127.0.0.1
        assert.equal(isPrivateIP('::ffff:a00:1'), true)     // 10.0.0.1
        assert.equal(isPrivateIP('::ffff:c0a8:101'), true)  // 192.168.1.1
        assert.equal(isPrivateIP('::ffff:a9fe:101'), true)  // 169.254.1.1
        assert.equal(isPrivateIP('::ffff:808:808'), false)   // 8.8.8.8

        // IPv6 public
        assert.equal(isPrivateIP('2001:db8::1'), false)
        assert.equal(isPrivateIP('2607:f8b0:4004:800::200e'), false)
    })

})
