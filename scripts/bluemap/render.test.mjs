import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { readMinecraftVersion, validateMinecraftVersion } from "./render.mjs";

function nbtString(value) {
  const text = Buffer.from(value);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(text.length);
  return Buffer.concat([length, text]);
}

function tag(type, name, value) {
  return Buffer.concat([Buffer.from([type]), nbtString(name), value]);
}

function compound(name, children) {
  return tag(10, name, Buffer.concat([...children, Buffer.from([0])]));
}

function levelDat(version) {
  const arrayLength = Buffer.from([0, 0, 0, 2]);
  return gzipSync(compound("", [compound("Data", [
    tag(7, "UnknownBytes", Buffer.concat([arrayLength, Buffer.from([10, 8])])),
    tag(11, "UnknownInts", Buffer.concat([arrayLength, Buffer.alloc(8)])),
    tag(12, "UnknownLongs", Buffer.concat([arrayLength, Buffer.alloc(16)])),
    tag(9, "UnknownList", Buffer.from([3, 0, 0, 0, 1, 0, 0, 0, 42])),
    compound("Version", [tag(8, "Name", nbtString(version))]),
  ])]));
}

test("reads the world's Minecraft version while skipping unrelated NBT data", () => {
  assert.equal(readMinecraftVersion(levelDat("1.21.4")), "1.21.4");
  assert.equal(readMinecraftVersion(levelDat("26.2")), "26.2");
});

test("missing version metadata cannot silently select the CLI's newest version", () => {
  assert.equal(readMinecraftVersion(gzipSync(compound("", []))), undefined);
  assert.throws(() => validateMinecraftVersion(undefined), /supported stable/);
});

test("rejects truncated or corrupt world metadata", () => {
  assert.throws(() => readMinecraftVersion(Buffer.from("not a gzip world")));
  assert.throws(() => readMinecraftVersion(gzipSync(Buffer.from([10, 0, 0, 8, 0]))));
  assert.throws(() => readMinecraftVersion(gzipSync(compound("", [tag(7, "bad", Buffer.from([255, 255, 255, 255]))]))), /Invalid/);
});

test("accepts releases covered by the pinned CLI and rejects snapshots or newer formats", () => {
  for (const version of ["1.13.2", "1.20", "1.20.6", "1.21.4", "1.21.11", "26.1", "26.2", "26.3"]) {
    assert.equal(validateMinecraftVersion(version), version);
  }
  for (const version of ["1.12.2", "1.13.1", "1.21.12", "1.22", "26.4", "26w01a", "latest", "../1.21.4"]) {
    assert.throws(() => validateMinecraftVersion(version));
  }
});
