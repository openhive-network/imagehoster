const crypto = require("crypto");
const multihash = require("multihashes");
const base58 = require("bs58");
const {hash} = require("steem/lib/auth/ecc");
const sha1 = (data, encoding) => crypto.createHash('sha1').update(data).digest(encoding);

/**
 @arg {Buffer} hash
 @arg {string} mhashType = sha1, sha2-256, ...
 */
const mhashEncode = (_hash, mhashType) => base58.encode(multihash.encode(_hash, mhashType));


const imageHash = function(fbuffer) {
// Data hash (D)
    const sha = hash.sha256(fbuffer);
    return 'D' + base58.encode(multihash.encode(sha, 'sha2-256'));
};

const urlHash = url => "U" + mhashEncode(sha1(url), "sha1");


const simpleHashRe = /DQm[a-zA-Z0-9]{38,46}/;

const isUploadHash = function(url) {
    "use strict";
    return simpleHashRe.test(url)
};
const getKeyFromUrl = function(url) {
    "use strict";
    const isUpload = isUploadHash(url);
    return isUpload ? url.match(simpleHashRe)[0] : urlHash(url); // UQm...
}

module.exports = {urlHash, imageHash, sha1, isUploadHash, getKeyFromUrl};