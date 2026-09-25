import { assert, describe, it } from "@effect/vitest";

import sharp from "sharp";
import { encodePngIco, frameMacOsIcon, readPngDimensions } from "./icon-export.ts";

const pngHeader = (width: number, height: number) => {
  const contents = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(contents);
  contents.write("IHDR", 12, "ascii");
  contents.writeUInt32BE(width, 16);
  contents.writeUInt32BE(height, 20);
  return contents;
};

describe("icon export", () => {
  it("frames macOS icons with transparent margins and an 824px body", async () => {
    const input = await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: "#5ef4d6" },
    })
      .png()
      .toBuffer();
    const output = await frameMacOsIcon(input);
    assert.deepEqual(readPngDimensions(output), { width: 1024, height: 1024 });
    const { data, info } = await sharp(output)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alpha = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    assert.equal(alpha(99, 512), 0);
    assert.equal(alpha(100, 512), 255);
    assert.equal(alpha(923, 512), 255);
    assert.equal(alpha(924, 512), 0);
    assert.equal(alpha(512, 99), 0);
    assert.equal(alpha(512, 100), 255);
    assert.equal(alpha(512, 923), 255);
    assert.equal(alpha(512, 924), 0);
  });

  it("reads dimensions from a PNG IHDR chunk", () => {
    assert.deepEqual(readPngDimensions(pngHeader(1024, 512)), {
      width: 1024,
      height: 512,
    });
  });

  it("encodes PNG renditions into an ICO directory", () => {
    const small = pngHeader(16, 16);
    const large = pngHeader(256, 256);
    const ico = encodePngIco([
      { size: 16, contents: small },
      { size: 256, contents: large },
    ]);

    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
    assert.equal(ico.readUInt8(6), 16);
    assert.equal(ico.readUInt8(22), 0);
    assert.equal(ico.readUInt32LE(18), 38);
    assert.equal(ico.readUInt32LE(34), 38 + small.length);
    assert.deepEqual(ico.subarray(38, 38 + small.length), small);
    assert.deepEqual(ico.subarray(38 + small.length), large);
  });

  it("rejects duplicate ICO rendition sizes", () => {
    assert.throws(
      () =>
        encodePngIco([
          { size: 32, contents: pngHeader(32, 32) },
          { size: 32, contents: pngHeader(32, 32) },
        ]),
      /provided more than once/,
    );
  });
});
