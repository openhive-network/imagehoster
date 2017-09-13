import config from 'config'
import {s3, getObjectUrl} from 'app/server/amazon-bucket'
import {missing, getRemoteIp, limit} from 'app/server/utils-koa'

const {uploadBucket} = config

const router = require('koa-router')()

router.get('/:hash/:filename?', function *() {
    try {
        const ip = getRemoteIp(this.req)
        if(yield limit(this, 'downloadIp', ip, 'Downloads', 'request')) return

        if(missing(this, this.params, 'hash')) return

        const {hash} = this.params
        const key = `${hash}`

        // This lets us remove images even if the s3 bucket cache is public,immutable
        // Clients will have to re-evaulate the 302 redirect every day
        this.status = 302
        this.set('Cache-Control', 'public,max-age=86400')

        this.redirect(getObjectUrl({Bucket: uploadBucket, Key: key}))

        // yield new Promise(resolve => {
        //     const params = {Bucket: uploadBucket, Key: key};
        //     s3.getObject(params, (err, data) => {
        //         if(err) {
        //             console.log(err)
        //             this.status = 400
        //             this.statusText = `Error fetching ${key}.` 
        //             resolve()
        //             return
        //         }
        //         this.set('Last-Modified', data.LastModified)
        //         this.body = new Buffer(data.Body.toString('binary'), 'binary')
        //         resolve()
        //     })
        // })
    } catch(error) {console.error(error)} 
})

export default router.routes()
