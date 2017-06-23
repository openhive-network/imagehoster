const _ = require('lodash');
const config = require("./config");

const sharp = require("sharp");
const Promise = require("bluebird");
const fs = Promise.promisifyAll(require("fs"));

const filenameFromUpload = function (file, form_filename, ftype) {
    "use strict";
    const filename = _.get(file, 'name');

    // take filename from name properties of form's file object
    if (filename) {
        return filename;
    }

    // take filename from form's filename field
    if (form_filename) {
        return form_filename;
    }

    // make up filename from mime type
    return `image.${ftype.ext}`;

};
//

const fileToBuffer = async function (file, filebase64) {
    let fbuffer;
    if (file) {
        const fdata = await fs.readFileAsync(file.path, 'binary');
        fbuffer = new Buffer(fdata, 'binary');
        await fs.unlinkAsync(file.path);
    } else {
        fbuffer = new Buffer(filebase64, 'base64')
    }
    return fbuffer
};

async function prepareThumbnail(imageBuffer, targetWidth, targetHeight) {
    const image = sharp(imageBuffer).withMetadata().rotate();
    const md = await image.metadata();
    const geo = calculateDimensions(md.width, md.height, targetWidth, targetHeight);

    let i = image.resize(geo.width, geo.height);
    let type = md.format;
    if (md.format === "gif") {
        // convert animated gifs into a flat png
        i = i.toFormat("png");
        type = "png"
    }
    const Body = await i.toBuffer();
    return {Body, ContentType: `image/${type}`}
}

function calculateDimensions(origWidth, origHeight, targetWidth, targetHeight) {
    // Default ratio. Default crop.
    const origRatio = (origHeight !== 0 ? (origWidth / origHeight) : 1);

    // Fill in missing target dims.
    if (targetWidth === 0 && targetHeight === 0) {
        targetWidth = origWidth;
        targetHeight = origHeight;
    } else if (targetWidth === 0) {
        targetWidth = Math.round(targetHeight * origRatio);
    } else if (targetHeight === 0) {
        targetHeight = Math.round(targetWidth / origRatio);
    }

    // Constrain target dims.
    if (targetWidth > origWidth) targetWidth = origWidth;
    if (targetHeight > origHeight) targetHeight = origHeight;

    const targetRatio = targetWidth / targetHeight;
    if (targetRatio > origRatio) {
        // max out height, and calc a smaller width
        targetWidth = Math.round(targetHeight * origRatio);
    } else if (targetRatio < origRatio) {
        // max out width, calc a smaller height
        targetHeight = Math.round(targetWidth / origRatio);
    }

    config.logger.debug(`Original: ${origWidth}x${origHeight} -> Target: ${targetWidth}x${targetHeight}`);

    return {
        width: targetWidth,
        height: targetHeight,
    };
}


module.exports = {fileToBuffer, prepareThumbnail, filenameFromUpload};





