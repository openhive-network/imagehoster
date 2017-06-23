const _ = require('lodash');
const config = require("./config");
const fileType = require("file-type");


const {processJPEG} = require("./exif-utils");
const {imageHash} = require("./hash");
const {waitFor} = require("./amazon-bucket");
const {filenameFromUpload, fileToBuffer} = require("./images");
const {getAccountInfo, hasMinReputation, parseSig, verifyUser} = require("./blockchain");


const router = require('koa-router')();
const koaBody = require('koa-body')({
    multipart: true,
    formLimit: 20 * 1000 * 1024,
});

router.post('/:username/:signature', koaBody, async function (ctx) {
    const username = _.get(ctx, 'params.username');
    const signature = parseSig(_.get(ctx, 'params.signature'));
    const file = _.get(ctx, 'request.body.files[0]');
    const filename = _.get(ctx, 'request.body.fields.filename');
    const filebase64 = _.get(ctx, 'request.body.fields.filebase64');

    ctx.assert(file || filebase64, 400, 'file required');
    ctx.assert(username, 400, 'username required');
    ctx.assert(signature, 400, 'signature required');

    // get user info from blockchain
    const {reputation, posting} = await getAccountInfo(username);

    // confirm user can post
    ctx.assert(hasMinReputation(reputation), 400, `Your reputation must be at least ${config.minReputationToUpload} to upload.`);
    ctx.logger.info('Upload by %s blocked: reputation %s < %s', username, reputation, config.minReputationToUpload);

    // process upload file
    let {fname, fbuffer} = fileToBuffer(file, filename);
    ctx.assert(fbuffer, 400, 'Bad upload');

    // get uploaded file's mime type
    const ftype = fileType(fbuffer);
    ctx.assert(ftype, 400, 'Bad file type');
    const mime = ftype.mime;
    ctx.assert(config.mime_types_whitelist.has(mime), 400, 'Unsupported image type');

    // name uploaded file
    fname = filenameFromUpload(file, filename, ftype);

    // authenticate user
    const userVerified = verifyUser(signature, posting, fbuffer);
    ctx.assert(userVerified, 400, `Signature did not verify.`);

    // username rate limiting here
    // const megs = fbuffer.length / (1024 * 1024);

    // get key for image
    const key = imageHash(fbuffer);

    // strip exif geo if jpeg
    if (mime === 'image/jpeg') {
        fbuffer = await processJPEG(fbuffer);
    }

    // store image in upload bucket
    const params = {Bucket: config.uploadBucket, Key: key, Body: fbuffer, ContentType: mime};
    await waitFor("putObject", params).promise();

    // return final url for uploaded file
    const final_url = buildUrl(config.protocol, config.host, config.port, key, fname);
    ctx.body = {final_url};
});


function buildUrl(protocol, host, port, key, fname) {
    "use strict";
    const fnameUri = encodeURIComponent(fname);
    return `${protocol}://${host}:${port}/${key}/${fnameUri}`;
}

module.exports = router.routes();





