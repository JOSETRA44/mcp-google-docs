/**
 * Minimal image header parsing.
 *
 * Google enforces three limits on inserted images — PNG/JPEG/GIF only, at most 50 MB, at most 25
 * megapixels — and reports a violation as a generic 400 from `batchUpdate`, after the upload and
 * sharing have already happened. Reading the dimensions from the file's own header costs a few
 * dozen bytes and turns that into a clear refusal before any of the work is done.
 *
 * Only the header fields that carry dimensions are parsed; this is not a general image decoder.
 */

export type ImageFormat = "png" | "jpeg" | "gif";

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
  mimeType: string;
}

/** Google's documented ceilings for `insertInlineImage`. */
export const MAX_BYTES = 50 * 1024 * 1024;
export const MAX_PIXELS = 25_000_000;

function parsePng(buffer: Buffer): ImageInfo | null {
  // 8-byte signature, then an IHDR chunk whose width and height are big-endian 32-bit values at
  // fixed offsets 16 and 20.
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return {
    format: "png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    mimeType: "image/png",
  };
}

function parseGif(buffer: Buffer): ImageInfo | null {
  // "GIF87a" or "GIF89a", then little-endian 16-bit logical screen width and height.
  if (buffer.length < 10) return null;
  if (buffer.toString("ascii", 0, 3) !== "GIF") return null;
  return {
    format: "gif",
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
    mimeType: "image/gif",
  };
}

function parseJpeg(buffer: Buffer): ImageInfo | null {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;

  // JPEG is a chain of variable-length segments. Dimensions live in a Start Of Frame marker,
  // which can sit arbitrarily deep, so the chain has to be walked rather than indexed into.
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1]!;

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start Of Scan means the entropy-coded image data begins; no SOF will follow.
    if (marker === 0xda) break;

    const length = buffer.readUInt16BE(offset + 2);

    // Any SOFn except the four that are not frame headers (0xc4, 0xc8, 0xcc).
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isFrameHeader) {
      return {
        format: "jpeg",
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
        mimeType: "image/jpeg",
      };
    }

    offset += 2 + length;
  }

  return null;
}

/** Identify an image and read its dimensions, or return null if it is not a supported format. */
export function readImageInfo(buffer: Buffer): ImageInfo | null {
  return parsePng(buffer) ?? parseJpeg(buffer) ?? parseGif(buffer);
}

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageValidationError";
  }
}

/** Validate an image against Google's limits, throwing a message a user can act on. */
export function validateImage(buffer: Buffer, label: string): ImageInfo {
  if (buffer.byteLength > MAX_BYTES) {
    throw new ImageValidationError(
      `${label} is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB. Google Docs accepts ` +
        `images up to 50 MB.`,
    );
  }

  const info = readImageInfo(buffer);
  if (!info) {
    throw new ImageValidationError(
      `${label} is not a PNG, JPEG or GIF. Google Docs accepts only those three formats — ` +
        `convert the image and try again.`,
    );
  }

  const pixels = info.width * info.height;
  if (pixels > MAX_PIXELS) {
    throw new ImageValidationError(
      `${label} is ${info.width}x${info.height} (${(pixels / 1e6).toFixed(1)} megapixels). ` +
        `Google Docs accepts up to 25 megapixels — resize it and try again.`,
    );
  }

  return info;
}
