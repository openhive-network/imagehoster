const Router = require('koa-router');
const router = new Router();

router.get('/', async function (ctx) {
    ctx.status = 200;
    ctx.statusText = "OK";
    ctx.body = {status: 200, statusText: 'OK'}
});

router.get('/healthcheck', async function (ctx) {
    ctx.status = 200;
    ctx.statusText = "OK";
    ctx.body = {status: 200, statusText: 'OK'}
});

module.exports = router.routes();
