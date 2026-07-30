import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ImageValidationError,
  readImageInfo,
  validateImage,
} from "../src/core/assets/image-info.js";
import {
  getCached,
  indicatesMissingPreview,
  record,
  resetCapabilityCache,
} from "../src/google/capabilities.js";
import { GoogleApiError } from "../src/google/errors.js";

/** Build a PNG header with the given dimensions. Only the fields the parser reads are real. */
function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function gifHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(13);
  buffer.write("GIF89a", 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

/** Build a JPEG with a comment segment before the frame header, so the parser must walk. */
function jpegHeader(width: number, height: number): Buffer {
  const comment = Buffer.alloc(20);
  comment.writeUInt16BE(0xfffe, 0); // COM marker
  comment.writeUInt16BE(18, 2); // segment length

  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0); // SOF0
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);

  const soi = Buffer.alloc(2);
  soi.writeUInt16BE(0xffd8, 0);

  return Buffer.concat([soi, comment, sof, Buffer.alloc(8)]);
}

describe("image header parsing", () => {
  it("reads PNG dimensions", () => {
    expect(readImageInfo(pngHeader(800, 600))).toMatchObject({
      format: "png",
      width: 800,
      height: 600,
      mimeType: "image/png",
    });
  });

  it("reads GIF dimensions", () => {
    expect(readImageInfo(gifHeader(320, 240))).toMatchObject({ format: "gif", width: 320, height: 240 });
  });

  it("walks JPEG segments to find the frame header", () => {
    // The dimensions sit behind a comment segment, so a parser that indexes at a fixed offset
    // would read garbage here.
    expect(readImageInfo(jpegHeader(1024, 768))).toMatchObject({
      format: "jpeg",
      width: 1024,
      height: 768,
    });
  });

  it("returns null for an unsupported format", () => {
    expect(readImageInfo(Buffer.from("%PDF-1.7\n", "ascii"))).toBeNull();
  });
});

describe("image validation", () => {
  it("accepts an image within Google's limits", () => {
    expect(validateImage(pngHeader(1920, 1080), "test.png").width).toBe(1920);
  });

  it("rejects an unsupported format with a usable message", () => {
    expect(() => validateImage(Buffer.from("not an image"), "test.bmp")).toThrow(ImageValidationError);
    expect(() => validateImage(Buffer.from("not an image"), "test.bmp")).toThrow(/PNG, JPEG or GIF/);
  });

  it("rejects an image over 25 megapixels before any upload happens", () => {
    // 6000x5000 = 30 megapixels. Catching this locally avoids uploading and sharing a file only
    // for Google to reject the insert afterwards.
    expect(() => validateImage(pngHeader(6000, 5000), "huge.png")).toThrow(/25 megapixels/);
  });

  it("rejects a file over 50 MB", () => {
    const big = Buffer.concat([pngHeader(10, 10), Buffer.alloc(51 * 1024 * 1024)]);
    expect(() => validateImage(big, "big.png")).toThrow(/50 MB/);
  });
});

describe("capability cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "gdocs-cap-"));
  const original = process.env.GDOCS_NATIVE_HOME;

  beforeEach(() => {
    process.env.GDOCS_NATIVE_HOME = mkdtempSync(join(tmpdir(), "gdocs-cap-"));
    resetCapabilityCache();
  });
  afterAll(() => {
    if (original === undefined) delete process.env.GDOCS_NATIVE_HOME;
    else process.env.GDOCS_NATIVE_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for a capability never checked", async () => {
    expect(await getCached("suggestMode")).toBeUndefined();
  });

  it("remembers a positive result", async () => {
    await record("suggestMode", true);
    expect(await getCached("suggestMode")).toBe(true);
  });

  it("expires a negative result so enrollment gained later is noticed", async () => {
    await record("suggestMode", false);
    expect(await getCached("suggestMode")).toBe(false);

    // A permanently cached "no" would hide the feature from a user who joined the preview
    // program between two runs, with no way to discover it short of deleting the cache file.
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(await getCached("suggestMode")).toBeUndefined();
    vi.useRealTimers();
  });
});

describe("preview capability detection", () => {
  it("recognises an explicit preview refusal", () => {
    const error = new GoogleApiError({ kind: "preview_required", message: "nope" });
    expect(indicatesMissingPreview(error)).toBe(true);
  });

  it("recognises the unknown-field rejection a non-enrolled account receives", () => {
    // A preview-only request type is not in the schema for accounts without access, so Google
    // rejects it as a malformed payload rather than as a missing feature.
    const error = new GoogleApiError({
      kind: "invalid_request",
      message: 'Invalid JSON payload received. Unknown name "insertComment"',
    });
    expect(indicatesMissingPreview(error)).toBe(true);
  });

  it("does not mistake a genuine bad request for missing enrollment", () => {
    const error = new GoogleApiError({
      kind: "invalid_request",
      message: "Index 500 must be less than the end index of the referenced segment",
    });
    expect(indicatesMissingPreview(error)).toBe(false);
  });

  it("ignores unrelated errors", () => {
    expect(indicatesMissingPreview(new Error("network down"))).toBe(false);
    expect(indicatesMissingPreview(undefined)).toBe(false);
  });
});
