## Configure

> cp ./config/env_example.sh env_prod.sh

See also: `./config/config.js`

## Example upload

#### Start the server

Enable the TEST key in development mode only.  The examples below are signed using this test key.
 
> export STEEMIT_UPLOAD_TEST_KEY=true
> . ./env_prod.sh
> npm start

#### Quota Server

Tarantool database should be available on port 3301 of your local host.

> tarantool ./app.lua

#### Usage

# POST

> curl -v -F "data=@<path_to_file>" http://localhost:3234/<blockchain_username>/<hex(sign(hash256(data), d))>

# GET

> curl -L http://localhost:3234/<ipfsHash(data)>/<[optional_file_name]>

The `optional_file_name` is ignored but should be provided to help users and applications understand the URL.

#### Example Download

> curl -L http://localhost:3234/QmXJShecaM2pvkcax4Lt6h3Q6wBn1ZhESB6dFkfwSPLuN4/blue_red_pill.jpg > $HOME/Pictures/blue_red_pill.jpg

#### Example Upload (user `steem` signed using a test key)

> curl -v -F "data=@$HOME/Pictures/blue_red_pill.jpg" http://localhost:3234/steem/205d8bcafb9e0e0897e2db330aa2bd1ca4f7764ad9b1ba04a2a9651453aee72f4a685bd631ad60111f8018fd65d3fc7e951c0039476c270e859bb6760836dcb40d

## Create a signature

```
import {PrivateKey, Signature} from 'shared/ecc'

const bufSha = new Buffer('a190c0596a37398427e51bcbee7c94f1007075629828d62005735c6c2d2ffeef', 'hex')
const d = PrivateKey.fromSeed('') // blockchain_username's posting_private_key
const sig = Signature.signBufferSha256(bufSha, d)
console.log('Signature', sig.toHex())
```
Outputs: `205d8bcafb9e0e0897e2db330aa2bd1ca4f7764ad9b1ba04a2a9651453aee72f4a685bd631ad60111f8018fd65d3fc7e951c0039476c270e859bb6760836dcb40d`
