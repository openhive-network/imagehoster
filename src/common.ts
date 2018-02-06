/** Misc shared instances. */

import * as config from 'config'
import {Client} from 'dsteem'

/** Steemd (jussi) RPC client. */
export const rpcClient = new Client(config.get('rpc_node'))
