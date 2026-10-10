import 'mocha'
import * as assert from 'assert'
import * as sharp from 'sharp'

import {AcceptedContentTypes} from './../src/image-policy'

function solid() {
    return sharp({create: {width: 8, height: 8, channels: 3, background: {r: 128, g: 128, b: 128}}})
}

describe('image policy', function() {

    it('should not accept svg', function() {
        assert(!AcceptedContentTypes.includes('image/svg+xml'))
    })

    it('should decode accepted formats', async function() {
        this.slow(2000)
        for (const format of ['gif', 'jpeg', 'png', 'webp', 'avif'] as const) {
            const data = await solid().toFormat(format).toBuffer()
            const meta = await sharp(data).metadata()
            assert.equal(meta.width, 8, format)
        }
    })

    it('should refuse to decode other formats', async function() {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>')
        const tiff = await solid().tiff().toBuffer()
        for (const data of [svg, tiff]) {
            await assert.rejects(sharp(data).metadata())
        }
    })

})
