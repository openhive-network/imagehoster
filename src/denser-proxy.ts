/** Legacy proxy API redirects. */

import * as multihash from "multihashes";
import * as querystring from "querystring";
import { URL } from "url";

import { KoaContext } from "./common";
import { APIError } from "./error";

enum OutputFormat {
  /** Matches the input format, default. */
  Match,
  JPEG,
  PNG,
  WEBP,
  AVIF,
}

export async function denserProxyHandler(ctx: KoaContext) {
  ctx.tag({ handler: "legacy-proxy" });

  APIError.assert(ctx.method === "GET", APIError.Code.InvalidMethod);
  APIError.assertParams(ctx.params, [
    "width",
    "height",
    "format",
    "mode",
    "url",
  ]);

  const width = Number.parseInt(ctx.params["width"]);
  const height = Number.parseInt(ctx.params["height"]);
  const format = ctx.params["format"];
  const mode = ctx.params["mode"];

  APIError.assert(Number.isFinite(width), "Invalid width");
  APIError.assert(Number.isFinite(height), "Invalid height");

  let url: URL;
  try {
    let urlStr = ctx.request.originalUrl;
    urlStr = urlStr.slice(urlStr.indexOf("http"));
    urlStr = urlStr.replace("steemit.com/ipfs/", "ipfs.io/ipfs/");
    url = new URL(urlStr);
  } catch (cause) {
    throw new APIError({ cause, code: APIError.Code.InvalidProxyUrl });
  }

  const options: { [key: string]: any } = {
    format: format ? format : "match",
    mode: mode ? mode : "fit",
  };
  if (width > 0) {
    options["width"] = width;
  }
  if (height > 0) {
    options["height"] = height;
  }

  const qs = querystring.stringify(options);
  const b58url = multihash.toB58String(Buffer.from(url.toString()));

  ctx.status = 301;
  ctx.redirect(`/p/${b58url}?${qs}`);
}
