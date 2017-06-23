const _ = require('lodash');
const fileType = require("file-type");
const config = require("./config");
const {mhashEncode, sha1} = require("./hash");

const {getObject, getUrl, headObject, putObject, waitFor, s3} = require("./amazon-bucket");
const URL = require('url').URL;

const router = require("koa-router")();


function imageUrl(ctx) {
    "use strict";
    // NOTE: can"t use req.params.url -- it doesn"t include the query string.
    //   Instead, we take the full request URL and trim everything up to the
    //   start of "http". A few edge cases:
    //
    // * query strings
    // originalUrl: /640x480/https://encrypted-tbn2.gstatic.com/images?q=tbn:ANd9GcTZN5Du9Iai_05bMuJrxJuGTfqxNstuOvTP7Mzx-otuUVveeh8D
    // params.url:  https://encrypted-tbn2.gstatic.com/images
    // expect url:  https://encrypted-tbn2.gstatic.com/images?q=tbn:ANd9GcTZN5Du9Iai_05bMuJrxJuGTfqxNstuOvTP7Mzx-otuUVveeh8D
    //
    // * encoded parts
    // originalUrl: /640x480/https://vignette1.wikia.nocookie.net/villains/images/9/9c/Monstro_%28Disney%29.png
    // params.url:  https://vignette1.wikia.nocookie.net/villains/images/9/9c/Monstro_(Disney).png
    // expect url:  https://vignette1.wikia.nocookie.net/villains/images/9/9c/Monstro_%28Disney%29.png
    let url = ctx.request.originalUrl.substring(ctx.request.originalUrl.indexOf("http"));
    url = url.replace("steemit.com/ipfs/", "ipfs.pics/ipfs/");
    return new URL(url).toString();
}


// http://localhost:3234/640x480/https://cdn.meme.am/cache/instances/folder136/400x400/67577136.jpg
// http://localhost:3234/0x0/https://cdn.meme.am/cache/instances/folder136/400x400/67577136.jpg
router.get("/:width(\\d+)x:height(\\d+)/:url(.*)", async function (ctx) {
    const width = _.get(ctx.params, 'width');
    const height = _.get(ctx.params, 'height');
    const url = imageUrl(ctx);

    ctx.assert(width, 400, 'width required');
    ctx.assert(height, 400, 'height required');
    ctx.assert(url, 400, 'url required');

    let targetWidth = parseInt(width, 10);
    let targetHeight = parseInt(height, 10);

    // Force a thumnail until the web urls are requesting 1680x8400 instead of 0x0..  The thumbnail fixes image rotation.
    if (targetWidth === 0 && targetHeight === 0) {
        targetWidth = 1680;
        targetHeight = 8400
    }
    const fullSize = targetWidth === 1680 && targetHeight === 8400;

    // image blacklist
    ctx.assert(!config.imageBlacklist.has(url), 400, 'Image Forbidden');

    // referer blacklist
    const referrer_hostname = new URL(_.get(ctx, 'request.headers.referer'), 'https://noreferrer');
    ctx.assert(!config.imageReferrerBlacklist.has(url.hostname), 400, 'Host Forbidden');


    // Uploaded images were keyed by the hash of the image data and store these in the upload bucket.
    // The proxy images use the hash of image url and are stored in the web bucket.
    const isUpload = simpleHashRe.test(url); // DQm...
    const Key = isUpload ? url.match(simpleHashRe)[0] : urlHash(url); // UQm...
    const Bucket = isUpload ? config.uploadBucket : config.webBucket;
    const originalKey = {Bucket, Key};
    const webBucketKey = {Bucket: config.webBucket, Key};
    const resizeRequest = targetWidth !== 0 || targetHeight !== 0;
    if (resizeRequest) {
        const resizedKey = Key + `_${targetWidth}x${targetHeight}`;
        const thumbnailKey = {Bucket: config.thumbnailBucket, Key: resizedKey};

        ctx.logger.info('debug',{isUpload, Key, Bucket, originalKey, webBucketKey, thumbnailKey} )
        const hasThumbnail = await s3.headObject(thumbnailKey).promise();

        ctx.logger.debug("image-proxy -> resize has thumbnail", hasThumbnail);

        if (hasThumbnail) {
            const params = {Bucket: config.thumbnailBucket, Key: resizedKey, Expires: 60};
            ctx.logger.debug("image-proxy -> thumbnail redirect");
            const cf_url = getUrl("getObject", params);
            ctx.redirect(cf_url);
            return
        }

        // Sharp can"t resize all frames in the animated gif .. just return the full image
        // http://localhost:3234/1680x8400/http://mashable.com/wp-content/uploads/2013/07/ariel.gif
        if (fullSize) { // fullSize is used to show animations in the full-post size only
            // Case 1 of 2: re-fetching
            const imageHead = await fetchHead(ctx, Bucket, Key, url, webBucketKey);
            if (imageHead && imageHead.ContentType === "image/gif") {
                ctx.logger.debug("image-proxy -> gif redirect (animated gif work-around)", JSON.stringify(imageHead, null, 0));
                const cf_url = getUrl("getObject", imageHead.headKey);
                ctx.redirect(cf_url);
                return
            }
            // See below, one more animated gif work-around ...
        }

        // no thumbnail, fetch and cache
        const imageResult = await fetchImage(ctx, Bucket, Key, url, webBucketKey);
        if (!imageResult) {
            return
        }

        ctx.logger.debug("image-proxy -> original save", url, JSON.stringify(webBucketKey, null, 0));
        await putObject(Object.assign({}, webBucketKey, imageResult)).promise();

        if (fullSize && imageResult.ContentType === "image/gif") {
            // Case 2 of 2: initial fetch
            await  waitFor("objectExists", webBucketKey).promise();
            ctx.logger.debug("image-proxy -> new gif redirect (animated gif work-around)", JSON.stringify(webBucketKey, null, 0));
            const cf_url = getUrl("getObject", webBucketKey);
            ctx.redirect(cf_url);
            return
        }

        try {
            ctx.logger.debug("image-proxy -> prepare thumbnail");
            const thumbnail = await prepareThumbnail(imageResult.Body, targetWidth, targetHeight);

            ctx.logger.debug("image-proxy -> thumbnail save", JSON.stringify(thumbnailKey, null, 0));
            await putObject(Object.assign({}, thumbnailKey, thumbnail)).promise();
            await waitFor("objectExists", thumbnailKey).promise();

            ctx.logger.debug("image-proxy -> thumbnail redirect", JSON.stringify(thumbnailKey, null, 0));
            const cf_url = getUrl("getObject", thumbnailKey);
            ctx.redirect(cf_url)
        } catch (error) {
            ctx.logger.error("image-proxy resize error", {originalUrl: ctx.request.originalUrl, error: error});
            await waitFor("objectExists", webBucketKey).promise();
            ctx.logger.debug("image-proxy -> resize error redirect", url);
            const cf_url = getUrl("getObject", webBucketKey);
            ctx.redirect(cf_url)
        }
        return
    }

    // A full size image

    const hasOriginal = !!(await headObject(originalKey).promise());
    if (hasOriginal) {
        ctx.logger.debug("image-proxy -> original redirect", JSON.stringify(originalKey, null, 0));
        const cf_url = getUrl("getObject", originalKey);
        ctx.redirect(cf_url);
        return
    }

    const imageResult = await fetchImage(ctx, Bucket, Key, url, webBucketKey);
    if (!imageResult) {
        return
    }

    ctx.logger.debug("image-proxy -> original save");
    await putObject(Object.assign({}, webBucketKey, imageResult)).promise();
    await waitFor("objectExists", webBucketKey).promise();

    ctx.logger.debug("image-proxy -> original redirect", JSON.stringify(webBucketKey, null, 0));
    const cf_url = getUrl("getObject", webBucketKey);
    ctx.redirect(cf_url)
});


async function fetchHead(ctx, Bucket, Key, url, webBucketKey) {
    const headKey = {Bucket, Key};
    let head = await headObject(headKey).promise();
    if (!head && Bucket === config.uploadBucket) {
        // The url appeared to be in the Upload bucket but was not,
        // double-check the config.webBucket to be sure.
        head = await headObject(webBucketKey).promise();
        ctx.logger.debug("image-proxy -> fetch image head", !!head, JSON.stringify(webBucketKey, null, 0));
        if (!head)
            return null;
        return {headKey: webBucketKey, ContentType: head.ContentType}
    } else {
        ctx.logger.debug("image-proxy -> fetch image head", !!head, JSON.stringify(headKey, null, 0));
        if (!head)
            return null;
        return {headKey, ContentType: head.ContentType}
    }
}

async function fetchImage(ctx, Bucket, Key, url, webBucketKey) {
    let img = await getObject({Bucket, Key}).promise();
    if (!img && Bucket === config.uploadBucket) {
        // The url appeared to be in the Upload bucket but was not,
        // double-check the config.webBucket to be sure.
        img = await getObject(webBucketKey).promise();
        ctx.logger.debug("image-proxy -> fetch image cache", {img: img, webBucketKey: webBucketKey});
    } else {
        ctx.logger.debug("image-proxy -> fetch image cache", {img: img, bucket: Bucket, key: Key});
    }
    if (img) {
        const {Body, ContentType} = img;
        return {Body, ContentType}
    }
    const opts = {
        url: url,
        timeout: 10000,
        followRedirect: true,
        maxRedirects: 2,
        rejectUnauthorized: false, // WARNING
        encoding: null
    };
    let imgResult;
    /*
    const imgResult =  Promise((resolve) => {
        request(opts, (error, response, imageBuffer) => {
            if (response.statusCode >= 400) {
                ctx.logger.warn("HTTP Error " + response.statusCode.toString() + " when fetching image from " + url);
                statusError(ctx, 400, "Unable to load image from " + url);
                resolve();
                return
            }
            if (imageBuffer && imageBuffer.length > 0) {
                const ftype = fileType(imageBuffer);
                if (!ftype || !/^image\/(gif|jpe?g|png)$/.test(ftype.mime)) {
                    statusError(ctx, 400, "Supported image formats are: gif, jpeg, and png");
                    resolve();
                    return
                }
                const {mime} = ftype;
                resolve({Body: imageBuffer, ContentType: mime});
                return
            }
            ctx.logger.info("404 Not Found", url);
            statusError(ctx, 404, "Not Found");
            resolve()
        })
    });
    */
    if (imgResult) {
        await putObject(Object.assign({}, webBucketKey, imgResult)).promise()
    }
    return imgResult
}


const simpleHashRe = /DQm[a-zA-Z0-9]{38,46}/;
const urlHash = url => "U" + mhashEncode(sha1(url), "sha1");

module.exports = router.routes();