
import AWS from 'aws-sdk'
import config from 'config'
import Apis from 'shared/api_client/ApiInstances'

import fs from 'fs'
import {repLog10} from 'app/server/utils'
import {exif, hasLocation, hasOrientation} from 'app/server/exif-utils'
import {missing, getRemoteIp, limit} from 'app/server/utils-koa'
import {hash, Signature, PublicKey, PrivateKey} from 'shared/ecc'
import fileType from 'file-type'
import multihash from 'multihashes'
import base58 from 'bs58'
import sharp from 'sharp'

const testKey = config.testKey ? PrivateKey.fromSeed('').toPublicKey() : null

const {uploadBucket, protocol, host, port} = config

const s3 = new AWS.S3()

const router = require('koa-router')()

const koaBody = require('koa-body')({
    multipart: true,
    formLimit: 20 * 1000 * 1024,
    // formidable: { uploadDir: '/tmp', }
})

const usernameBlackList = [
    "aplomb"
];

router.post('/:username/:signature', koaBody, function *() {
    const ip = getRemoteIp(this.req)
    if(yield limit(this, 'uploadIp', ip, 'Uploads', 'request')) return

    if(missing(this, this.params, 'username')) return
    if(missing(this, this.params, 'signature')) return

    const {files, fields} = this.request.body

    const fileNames = Object.keys(files)
    const {filename, filebase64} = fields

    if(!fileNames.length && !(filename && filebase64)) {
        missing(this, {}, 'file')
        return
    }

    const {signature} = this.params
    const sig = parseSig(signature)
    if(!sig) {
        this.status = 400
        this.statusText = `Unable to parse signature (expecting HEX data).` 
        this.body = {error: this.statusText}
        return
    }

    const {username} = this.params

    if (usernameBlackList.includes(username)) {
        this.status = 451;
        this.statusText = `Account '${this.params.username}' cannot upload images for legal reasons.`;
        this.body = {error: this.statusText};
        return
    }

    let posting
    try {
        const [account] = yield Apis.db_api('get_accounts', [this.params.username])
        if(!account) {
            this.status = 400
            this.statusText = `Account '${this.params.username}' is not found on the blockchain.` 
            this.body = {error: this.statusText}
            return
        }
        const {posting: {key_auths}, weight_threshold, reputation} = account

        const rep = repLog10(reputation)
        if(rep < config.uploadIpLimit.minRep) {
            this.status = 400
            this.statusText = `Your reputation must be at least ${config.uploadIpLimit.minRep} to upload.` 
            this.body = {error: this.statusText}
            console.log(`Upload by '${username}' blocked: reputation ${rep} < ${config.uploadIpLimit.minRep}`);
            return
        }

        const [[posting_pubkey, weight]] = key_auths
        if(weight < weight_threshold) {
            this.status = 400
            this.statusText = `User ${username} has an unsupported posting key configuration.` 
            this.body = {error: this.statusText}
            return
        }

        posting = PublicKey.fromString(posting_pubkey)
    } catch(error) {
        console.error(error);
    }

    let fbuffer, fname
    if(fileNames.length) {
        const file = files[fileNames[0]]
        fname = file.name
        // How can I keep a multipart form upload in memory (skip the file)?
        // https://github.com/tunnckoCore/koa-better-body/issues/67
        fbuffer = yield new Promise(resolve => {
            fs.readFile(file.path, 'binary', (err, data) => {
                if(err) {
                    console.error(err)
                    this.status = 400
                    this.statusText = `Upload failed.` 
                    this.body = {error: this.statusText}
                    resolve()
                    return
                }
                fs.unlink(file.path)
                resolve(new Buffer(data, 'binary'))
            })
        })
        if(!fbuffer)
            return
    } else {
        fname = filename ? filename : ''
        fbuffer = new Buffer(filebase64, 'base64')
    }

    let mime
    const ftype = fileType(fbuffer)
    if(ftype) {
        mime = ftype.mime
        if(!fname || fname === '' || fname === 'blob') {
            fname = `image.${ftype.ext}`
        }
    }

    if(!/^image\/(gif|jpeg|png)$/.test(mime)) {
        this.status = 400
        this.statusText = `Please upload only images.`
        this.body = {error: this.statusText}
        console.log(`Upload rejected, file: ${fname} mime: ${mime}`);
        return
    }

    // The challenge needs to be prefixed with a constant (both on the server and checked on the client) to make sure the server can't easily make the client sign a transaction doing something else.
    const prefix = new Buffer('ImageSigningChallenge')
    const shaVerify = hash.sha256(Buffer.concat([prefix, fbuffer]))

    let userVerified = false
    if(posting) {
        if(!sig.verifyHash(shaVerify, posting) && !(testKey && sig.verifyHash(shaVerify, testKey))) {
            this.status = 400
            this.statusText = `Signature did not verify.`
            this.body = {error: this.statusText}
            return
        }
        userVerified = true
    } else {
        console.log('WARN: Skipped signature verification (steemd connection problem?)');
    }

    if(userVerified) {
        // don't affect the quote unless the user is verified
        const megs = fbuffer.length / (1024 * 1024)
        if(yield limit(this, 'uploadData', username, 'Upload size', 'megabytes', megs)) {
            return
        }
    }

    // Data hash (D)
    const sha = hash.sha256(fbuffer)
    const key = 'D' + base58.encode(multihash.encode(sha, 'sha2-256'))

    if(mime === 'image/jpeg') {
        try {
            const exifData = yield exif(fbuffer)
            const orientation = hasOrientation(exifData)
            const location = hasLocation(exifData)
            if(location || orientation) {
                const image = sharp(fbuffer)

                // For privacy, remove: GPS Information, Camera Info, etc.. 
                // Sharp will remove EXIF info by default unless withMetadata is called..
                if(!location) image.withMetadata()

                // Auto-orient based on the EXIF Orientation.  Remove orientation (if any)
                if(orientation) image.rotate()

                // Verify signature before altering fbuffer
                fbuffer = yield image.toBuffer()
            }
        } catch(error) {
            console.error('upload-data process image', key, error.message);
        }
    }

    const params = {Bucket: uploadBucket, Key: key, Body: fbuffer, CacheControl: 'public,max-age=31536000,immutable'};
    if(mime) {
        params.ContentType = mime
    }

    yield new Promise(resolve => {
        s3.putObject(params, (err/*, data*/) => {
            if(err) {
                console.log(err)
                this.status = 400
                this.statusText = `Error uploading ${key}.` 
                this.body = {error: this.statusText}
                resolve()
                return
            }
            console.log(`Uploaded '${fname}' to s3://${uploadBucket}/${key}`);
            const fnameUri = encodeURIComponent(fname)
            const url = protocol === 'https' ?
                `https://${host}/${key}/${fnameUri}` :
                `${protocol}://${host}:${port}/${key}/${fnameUri}`

            this.body = {url}
            resolve()
        })
    })
})

export default router.routes()

const parseSig = hexSig => {try {return Signature.fromHex(hexSig)} catch(e) {return null}}
