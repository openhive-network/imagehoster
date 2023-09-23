import * as config from 'config'
import { logger } from './logger'
import { KoaContext } from './common'

let nodes = []

export function startShare() {
  nodes = config.get("nodes") as Array<string>
  logger.info("P2P starting with", nodes.length, "nodes")
}

export function shareToNetwork(username : string, fetchURL: string){
  // idea: post to all nodes you have in `nodes` to /p2p
  // fields: username: username of image uploader, fetchURL: url to grab image off this node
}

export function shareHandler(ctx: KoaContext) {
  if (nodes.length === 0) {
    ctx.res.writeHead(400, 'P2P not enabled')
    ctx.res.end()
  }
  // required fields: 
  // username: string, username of person the image came from
  // fetchURL: string, url to fetch image from
  // thats it, there's going to be no security or anything for now, we just trust the other node while this is POC

  // idea:
  // other node sends post to /p2p with the required fields mentioned above when 
  // this node decides if it wants to fetch it (check against upload limit to see if they have exceeded it or not) and save it
}