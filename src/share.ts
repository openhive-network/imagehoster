import * as config from 'config'
import { logger } from './logger'
import { KoaContext } from './common'

let nodes = []

export function startShare() {
  nodes = config.get("nodes") as Array<string>
  logger.info("P2P starting with", nodes.length, "nodes")
}


export function shareHandler(ctx: KoaContext) {
  if (nodes.length === 0) {
    ctx.res.writeHead(400, 'P2P not enabled')
    ctx.res.end()
  }
}