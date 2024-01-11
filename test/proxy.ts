import "mocha";
import * as assert from "assert";
import * as http from "http";
import * as needle from "needle";
import * as multihash from "multihashes";
import * as path from "path";
import * as fs from "fs";
import * as sharp from "sharp";

import { app } from "./../src/app";
import { proxyStore, uploadStore } from "./../src/common";
import { storeExists, base58Enc } from "./../src/utils";

import { uploadImage } from "./upload";

describe("proxy", function () {
  const port = 63205;
  const server = http.createServer(app.callback());

  before((done) => {
    server.listen(port, "localhost", done);
  });
  after((done) => {
    server.close(done);
  });

  needle.defaults({ follow_max: 1 });

  let serveImage = true;
  const imageServer = http.createServer((req, res) => {
    if (serveImage) {
      fs.createReadStream(path.resolve(__dirname, "test.jpg")).pipe(res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  before((done) => {
    imageServer.listen(port + 1, "localhost", done);
  });
  after((done) => {
    imageServer.close(done);
  });

  it("should proxy", async function () {
    this.slow(1000);
    const res = await needle(
      "get",
      `http://localhost:${port}/0x0/http://localhost:${port + 1}/test.jpg`
    );
    const image = sharp(res.body);
    const meta = await image.metadata();
    assert.equal(meta.width, 1280);
    assert.equal(meta.height, 853);
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.space, "srgb");
  });

  it("should proxy and resize", async function () {
    this.slow(1000);
    const res = await needle(
      "get",
      `http://localhost:${port}/100x0/http://localhost:${port + 1}/test.jpg`
    );
    const image = sharp(res.body);
    const meta = await image.metadata();
    assert.equal(meta.width, 100);
    assert.equal(meta.height, 67);
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.space, "srgb");
  });

  it("should proxy stored image when source is gone", async function () {
    serveImage = false;
    const res = await needle(
      "get",
      `http://localhost:${port}/100x0/http://localhost:${port + 1}/test.jpg`
    );
    const image = sharp(res.body);
    const meta = await image.metadata();
    assert.equal(meta.width, 100);
    assert.equal(meta.height, 67);
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.space, "srgb");
  });

  it("should proxy directly from upload store", async function () {
    this.slow(1000);
    serveImage = false;
    const uploaded = await uploadImage(
      fs.readFileSync(path.resolve(__dirname, "test.jpg")),
      port
    );
    const [key, fname] = uploaded.body.url.split("/").slice(-2);
    const res = await needle(
      "get",
      `http://localhost:${port}/0x0/${uploaded.body.url}`
    );
    const image = sharp(res.body);
    const meta = await image.metadata();
    assert(
      (await storeExists(proxyStore, key)) === false,
      "proxy store has original"
    );
  });

  it("should proxy using new api", async function () {
    this.slow(1000);
    serveImage = false;
    const imageUrl = base58Enc(`http://localhost:${port + 1}/test.jpg`);
    const res = await needle(
      "get",
      `http://localhost:${port}/p/${imageUrl}?width=100&height=100&format=webp`
    );
    const image = sharp(res.body);
    const meta = await image.metadata();
    assert.equal(meta.width, 100);
    assert.equal(meta.height, 100);
    assert.equal(meta.format, "webp");
    assert.equal(meta.space, "srgb");
  });

  it("should resolve double proxied images", async function () {
    this.slow(1000);
    serveImage = false;
    const imageUrl = base58Enc(`http://localhost:${port + 1}/test.jpg`);
    const url1 = `http://localhost:${port}/p/${imageUrl}?width=100&height=100`;
    const url2 = `http://localhost:${port}/p/${base58Enc(url1)}?width=200`;
    const res = await needle("get", url2);
    console.log(res.body);
    const image = sharp(res.body);
    const meta = await image.metadata();
    assert.equal(meta.width, 200);
    // this would be 200 if the first url wasn't stripped
    assert.equal(meta.height, 133);
  });

  it("should proxy using endpoint for denser", async function () {
    this.slow(1000);
    const res = await needle(
      "get",
      `http://localhost:${port}/d/0x0/avif/fit/http://localhost:${
        port + 1
      }/test.jpg`
    );
    const image = sharp(res.body);
    const meta = await image.metadata();
    assert.equal(meta.width, 1280);
    assert.equal(meta.height, 853);
    assert.equal(meta.format, "heif");
    assert.equal(meta.space, "srgb");
  });
});
