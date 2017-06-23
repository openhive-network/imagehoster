const AWS = require("aws-sdk");
const URL  = require('url').URL;

const config = require("./config");

AWS.config.setPromisesDependency(require('bluebird'));
const s3 = new AWS.S3({region: 'us-east-1', accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY});

const getObject = s3.getObject ;
const putObject = s3.putObject ;
const headObject = s3.headObject;
const waitFor = s3.waitFor;


function s3UrlToCloudfront(s3Url) {
    const url = URL(s3Url);
    url.query = "";
    url.hash = "";
    if (url.hostname.startsWith(config.webBucket)) {
        url.hostname = config.cloudfrontWebDomain;
        return url.toString();
    }
    if (url.hostname.startsWith(config.thumbnailBucket)) {
        url.hostname = config.cloudfrontThumbnailDomain;
        return url.toString();
    }
    config.logger.error('s3 hostname has no cloudfront mapping %s', s3Url);

}

function getUrl(s3Operation, s3Params) {
    const signed_url = s3.getSignedUrl(s3Operation, s3Params);
    return s3UrlToCloudfront(signed_url);
}

module.exports =  {s3, getObject, putObject, headObject, getUrl, waitFor};