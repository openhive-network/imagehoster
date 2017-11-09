import config from 'config'
import {s3, getObjectUrl} from 'app/server/amazon-bucket'
import {missing, getRemoteIp, limit} from 'app/server/utils-koa'
import Apis from 'shared/api_client/ApiInstances'
import path from 'path'
import send from 'koa-send'

const CACHE_MAX_ENTRIES = 10000000;
const HTTP_CODE_REDIRECT = 302
const AVATAR_SIZES = {
    small: 64,
    medium: 128,
    large: 512,
}

const {uploadBucket} = config

const router = require('koa-router')()

const assetRoot = path.resolve(__dirname, '../..');
router.get('/u/__default_new/avatar', function* () {
    yield send(this, 'assets/user.png', {root: assetRoot, immutable: true})
})

let cache = {};
let cacheCounter = 0;

const defaultAvatar = `https://${ config.host }/u/__default_new/avatar`
router.get('/u/:username/avatar/:size?', function* () {
    let avatarUrl = defaultAvatar
    const size = AVATAR_SIZES[this.params.size || 'medium']
    const username = this.params.username;
    const cachedValue = cache[username];
    if (cachedValue && (Date.now() - cachedValue.ts < 120000)) {
        avatarUrl = cachedValue.url;
    } else {
        try {
            const [account] = yield Apis.db_api('get_accounts', [this.params.username])
            if (account) {
                const jsonMetadata = account.json_metadata ? JSON.parse(account.json_metadata) : {}
                if (jsonMetadata.profile && jsonMetadata.profile.profile_image && jsonMetadata.profile.profile_image.match(/^https?:\/\//)) {
                    avatarUrl = jsonMetadata.profile.profile_image
                }
            }
            cacheCounter += 1;
            if (cacheCounter > CACHE_MAX_ENTRIES) {
                // reset cache to prevent it to grow too large
                cache = {};
                cacheCounter = 0;
            }
            cache[username] = {
                ts: Date.now(),
                url: avatarUrl
            };
        } catch(e) {
            avatarUrl = defaultAvatar
        }
    }
    this.status = HTTP_CODE_REDIRECT
    this.redirect(`/${ size }x${ size }/${ avatarUrl }`)
    return
})

router.get('/:hash/:filename?', function *() {
    try {
        const ip = getRemoteIp(this.req)
        if(yield limit(this, 'downloadIp', ip, 'Downloads', 'request')) return

        if(missing(this, this.params, 'hash')) return

        const {hash} = this.params
        const key = `${hash}`

        // This lets us remove images even if the s3 bucket cache is public,immutable
        // Clients will have to re-evaulate the 302 redirect every day
        this.status = HTTP_CODE_REDIRECT
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
