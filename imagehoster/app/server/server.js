import Koa from 'koa';
import cors from 'koa-cors'
import koaLogger2 from 'koa-logger2'
import healthCheck from './health-check'
import uploadData from './upload-data'
import imageProxy from './image-proxy'
import dataServer from './data-server'
import config from 'config'
import Apis from 'shared/api_client/ApiInstances'

Apis.instance().init()

const app = new Koa()

if (process.env.LOGCLF) {
	//let log_middleware = koaLogger2('ip [day/month/year:time zone] "method url protocol/httpVer" status size "referer" "userAgent" duration ms custom[unpacked]')
	//app.use(log_middleware.gen)
	app.use(koaLogger2().gen)
}

app.use(cors())
app.use(healthCheck)
app.use(dataServer)
app.use(uploadData)
app.use(imageProxy)

app.listen(config.port)
console.log(`Application started on port ${config.port}`)
