const _ = require('lodash');
const config = require("./config");
const {getUrl} = require("./amazon-bucket");

const {uploadBucket} = config;

const router = require('koa-router')();

router.get('/:hash/:filename?', async function (ctx) {
    const hash = _.get(ctx, 'params.hash');
    const filename = _.get(ctx, 'params.filename');
    ctx.assert(hash, 400, 'Missing hash url parameter');

    const params = {Bucket: uploadBucket, Key: hash, Expires: 60};
    const url = getUrl("getObject", params);
    ctx.logger.debug("/%s/%s -> %s", hash, filename, url);
    ctx.redirect(url)

});

module.exports = router.routes();
