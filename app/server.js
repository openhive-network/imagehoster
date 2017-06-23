const Koa = require("koa");
const cors = require("koa-cors");
const koaLogger = require('koa-logger-winston');
const healthCheck = require("./health-check");
const uploadData = require("./upload-data");
const imageProxy = require("./image-proxy");
const dataServer = require("./data-server");
const config = require("./config");

const app = new Koa();

// logger available on ctx and config objects
app.context.logger = config.logger;

// log requests
app.use(koaLogger(config.logger));


// add error handling
app.use(async (ctx, next) => {
    try {
        await next();
    } catch (err) {
        // will only respond with JSON
        ctx.status = err.statusCode || err.status || 500;
        ctx.body = {
            message: err.message
        };
        ctx.logger.error("%s", err, {error: err.stack});
    }
});


app.use(cors());

// routes `GET /` and `GET /healthcheck`
app.use(healthCheck);

// routes `GET /:hash/:filename?`
app.use(dataServer);

// routes `POST /:username/:signature`
app.use(uploadData);

// routes `GET /:width(\\d+)x:height(\\d+)/:url(.*)`
app.use(imageProxy);

app.listen(config.port);

config.logger.info(`Application started on port ${config.port}`);
//config.logger.info('Config:', config);

