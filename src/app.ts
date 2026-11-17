import cors from '@koa/cors'
import * as Bunyan from 'bunyan'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cluster = require('cluster')
import config from 'config'
import * as http from 'http'
import Koa from 'koa'
import * as net from 'net'
import * as os from 'os'
import * as util from 'util'

import {KoaContext} from './common'
import {superviseWorkers} from './cluster-master'
import {APIError, errorMiddleware} from './error'
import {logger, loggerMiddleware} from './logger'
import {routes} from './routes'
import {parseBool} from './utils'

export const app = new Koa()
export const version = require('./version')

app.proxy = parseBool(config.get('proxy'))

app.on('error', (error, ctx: KoaContext) => {
    const log: Bunyan = ctx.log || logger
    if (error instanceof APIError) {
        if (error.statusCode >= 500) {
            log.error(error.cause || error, 'unexpected api error: %s', error.message)
        } else {
            log.debug(error.cause || error, 'api error: %s', error.message)
        }
    } else {
        log.error(error, 'application error')
    }
})

app.use(loggerMiddleware as any)
app.use(errorMiddleware as any)
app.use(async (ctx, next) => {
    ctx.set('X-Content-Type-Options', 'nosniff')
    await next()
})
app.use(cors({
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization']
}))
app.use(routes)
app.use((_ctx: Koa.Context) => {
    throw new APIError({code: APIError.Code.NotFound})
})

async function main() {
    if (cluster.isPrimary) {
        logger.info({version}, 'starting service')
    }

    let numWorkers = Number.parseInt(config.get('num_workers'))
    if (numWorkers === 0) {
        numWorkers = os.cpus().length
    }
    const isPrimary = cluster.isPrimary && numWorkers > 1

    if (isPrimary) {
        superviseWorkers({
            numWorkers,
            maxRssMb: Number.parseInt(config.get('worker_max_rss_mb')),
            rssCheckIntervalMs: Number.parseInt(config.get('worker_rss_check_interval_ms')),
            stopTimeoutMs: Number.parseInt(config.get('worker_stop_timeout_ms'))
        })
        return
    }

    const server = http.createServer(app.callback())
    const listen: any = util.promisify(server.listen).bind(server)
    // http.Server#close() destroys idle keep-alive sockets, racing a client that is
    // reusing one (ECONNRESET), and leaves busy ones open for as long as the client
    // keeps sending. Instead only the listener is closed, and every response after
    // that asks the client to close; sockets left idle end at keepAliveTimeout.
    const close = util.promisify(net.Server.prototype.close).bind(server)
    let closing = false
    server.prependListener('request', (_req, res) => {
        if (closing) {
            res.setHeader('Connection', 'close')
        }
    })

    const port = config.get('port')
    await listen(port)
    logger.info('listening on port %d', port)

    process.on('SIGTERM', () => {
        logger.info('got SIGTERM, exiting...')
        closing = true
        close().then(() => {
            process.exit(0)
        }).catch((error) => {
            logger.fatal(error, 'unable to exit gracefully')
            setTimeout(() => process.exit(1), 1000)
        })
    })
}

if (module === require.main) {
    main().catch((error) => {
        logger.fatal(error, 'unable to start')
        setTimeout(() => process.exit(1), 1000)
    })
}
