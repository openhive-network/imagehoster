const assert = require('assert');
const chai = require('chai');
const should = chai.should();
const expect = chai.expect;
const fs = require('fs');
const path = require('path');
const os = require('os');

const images = require('../app/images');

chai.config.includeStack = true;

const test_img_path = path.resolve("./test/kitten.jpg");
const test_img_base64_path = path.resolve("./test/kitten_base64");
//#const fdata = fs.readFile(file.path, 'binary');
const tmp_dir = os.tmpdir();
const tmp_kitten = path.join(tmp_dir,'test_kitten.jpg');
const tmp_kitten_base64 = path.join(tmp_dir,'test_kitten_base64');


describe('app/images.js', function() {
    describe('filetoBuffer(file, filebase64)', function() {
        beforeEach(function() {
            const data = fs.readFileSync(test_img_path, 'binary');
            fs.writeFileSync(tmp_kitten, 'binary');
            const data_b64 = fs.readFileSync(test_img_base64_path, 'base64');
            fs.writeFileSync(tmp_kitten_base64, 'base64');

        });
        it('should load test image when given path', async function() {
            const data = fs.readFileSync(tmp_kitten, 'binary');
            const correct = new Buffer(data, 'binary');
            const file = {path: tmp_kitten};
            const result = await images.fileToBuffer(file, null);
            expect(result).to.be.an.instanceof(Buffer);
            expect(result.length).to.equal(correct.length);

        });
        it('should load base64data when given base64data', async function() {
            const data = fs.readFileSync(tmp_kitten_base64, 'base64');
            const correct = new Buffer(data, 'base64');
            const file = null;
            const result = await images.fileToBuffer(file, data);
            expect(result).to.be.an.instanceof(Buffer);
            expect(result.length).to.equal(correct.length);

        });
    });

});