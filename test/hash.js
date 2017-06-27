const chai = require('chai');
const fs = require('fs');
const path = require('path');
const hash = require('../app/hash');

const expect = chai.expect;
chai.config.includeStack = true;

const test_img_path = path.resolve("./test/kitten.jpg");


describe('app/hash.js', function() {
    describe('imageHash', function() {
        it('should hash kitten.jpg correctly', function() {
            const data = fs.readFileSync(test_img_path, 'binary');
            const fbuffer = new Buffer(data, 'binary');
            const result = hash.imageHash(fbuffer);
            expect(result).to.equal('DQmawyNmvviC6yfeUN188AYbs6WnhxgiT2T5PjAfuzUh19A');
        });
    });
    describe('sha1', function() {
        it('should hash kitten.jpg correctly', function() {
            const data = fs.readFileSync(test_img_path, 'binary');
            const fbuffer = new Buffer(data, 'binary');
            const result = hash.sha1(fbuffer, 'hex');
            expect(result).to.equal('5c0e78859523edfb718126a6d022a2f9930f71ae');
        });
    });
    describe('mhashEncode', function() {
        it('should hash kitten.jpg correctly', function() {
            const data = fs.readFileSync(test_img_path, 'binary');
            const fbuffer = new Buffer(data, 'binary');
            const result = hash.mhashEncode(hash.sha1(fbuffer), 'sha1');
            expect(result).to.equal('5ds4o9XtLBVMdAQRtahWqDp59moATP');
        });
    });
    describe('urlHash', function() {
        it('should hash https://domain.com/0x0/kitten.jpg correctly', function() {
            const result = hash.urlHash('https://domain.com/0x0/kitten.jpg');
            expect(result).to.equal('U5drgJCpy7WDPggbsHgg47jLdyHDsfg');
        });
    });
});