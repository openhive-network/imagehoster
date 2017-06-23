const sharp = require("sharp");
const Promise = require('bluebird');
const ExifImage = require('exif').ExifImage;

async function exif(buffer) {
    const exifImage = new ExifImage();
    const loadImage = Promise.promisify(exifImage.loadImage);
    return await loadImage(buffer);
}

const hasOrientation = (d = {}) => d && d.image && d.image.Orientation !== null;
const hasLocation = (d = {}) => d && d.gps && Object.keys(d.gps).find(key => /Latitude|Longitude|Altitude/i.test(key)) !== null;

async function processJPEG(fbuffer) {
    const exifData = await exif(fbuffer);
    const orientation = hasOrientation(exifData);
    const location = hasLocation(exifData);
    if (location || orientation) {
        const image = sharp(fbuffer);

        // For privacy, remove: GPS Information, Camera Info, etc..
        // Sharp will remove EXIF info by default unless withMetadata is called..
        if (!location) image.withMetadata();

        // Auto-orient based on the EXIF Orientation.  Remove orientation (if any)
        if (orientation) image.rotate();

        // Verify signature before altering fbuffer
        fbuffer = image.toBuffer();
        return fbuffer;
    }
}

module.exports =  {processJPEG};