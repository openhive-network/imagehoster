const winston = require('winston');
const imageBlacklist = require('./blacklists/image-blacklist');
const referrerBlacklist = require('./blacklists/referrer-blacklist');
const usernameUploadBlacklist = require('./blacklists/username-upload-blacklist');

const allowed_upload_mime_types = new Set([
    'image/jpeg',
    'image/png',
    'image/gif'
]);


const config = {
    ws_connection_server: process.env.STEEMIT_UPLOAD_STEEMD_WEBSOCKET || "wss://steemd.steemit.com",
    // When protocol === "https" a default port url is used (ignores STEEMIT_UPLOAD_HTTP_PORT)
    protocol: process.env.STEEMIT_UPLOAD_HTTP_PROTOCOL || "https",
    host: process.env.STEEMIT_UPLOAD_HTTP_HOST || "steemitdevimages.com",
    port: process.env.STEEMIT_UPLOAD_HTTP_PORT || 3234,
    tarantool: {
        host: process.env.STEEMIT_TARANTOOL_HOST || "localhost",
        port: process.env.STEEMIT_TARANTOOL_PORT || 3301,
        username: process.env.STEEMIT_TARANTOOL_USERNAME || "guest",
        password: process.env.STEEMIT_TARANTOOL_PASSWORD || "",
    },
    testKey: process.env.STEEMIT_UPLOAD_TEST_KEY,
    minReputationToUpload: parseFloat(process.env.STEEMIT_UPLOAD_MIN_REP || 10),
    mime_types_whitelist: allowed_upload_mime_types,
    imageBlacklist: imageBlacklist,
    imageReferrerBlacklist: referrerBlacklist,
    usernameUploadBlacklist: usernameUploadBlacklist,
    uploadBucket: process.env.STEEMIT_IMAGEPROXY_BUCKET_UPLOAD || "steemit-dev-imageproxy-upload",
    webBucket: process.env.STEEMIT_IMAGEPROXY_BUCKET_WEB || "steemit-dev-imageproxy-web",
    thumbnailBucket: process.env.STEEMIT_IMAGEPROXY_BUCKET_THUMBNAIL || "steemit-dev-imageproxy-thumbnail",

    cloudfrontWebDomain: process.env.STEEMIT_IMAGEPROXY_WEB_CLOUDFRONT_DOMAIN || 'steemit-dev-imageproxy-cloudfront-web-domain',
    cloudfrontThumbnailDomain: process.env.STEEMIT_IMAGEPROXY_THUMBNAIL_CLOUDFRONT_DOMAIN || 'steemit-dev-imageproxy-cloudfront-thumbnail-domain',
    cloudfrontKeypairId: process.env.STEEMIT_IMAGEPROXY_THUMBNAIL_CLOUDFRONT_KEYPAIR_ID || 'steemit-dev-imageproxy-cloudfront-keypair-id',
    cloudfrontPrivateKey: process.env.STEEMIT_IMAGEPROXY_THUMBNAIL_CLOUDFRONT_PRIVATE_KEY || 'steemit-dev-imageproxy-cloudfront-private-key',
    logger: winston
};

if (config.testKey) {
    if (process.env.NODE_ENV === "production") {
        throw new Error("ERROR test key provided, do not use in production.");
    }
    console.log("WARNING test key provided, do not use in production.");
}

module.exports = config;
