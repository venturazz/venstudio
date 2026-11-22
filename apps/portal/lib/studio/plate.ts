/**
 * The plain-colour plate of a workflow without pictures (scene-spec, recipes.ts), pure. The render-video contract
 * carries one picture per shot, so a scene-spec run gives the worker one plate the portal draws itself: a solid
 * colour, no model and no third-party content. The page draws the spec over it (or ignores it). Server use only
 * (node:zlib); nothing in the browser imports it.
 */
import { deflateSync } from "node:zlib";

export const PLATE_EXECUTOR = "portal-plate";
export const PLATE_TITLE = "Plain plate (made by the portal, no picture generated)";
export const PLATE_LICENCE = "A plain colour drawn by the VenStudio portal for a scene-spec run: no model, no third-party content, no licence needed.";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const body = Buffer.concat([head.subarray(4), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

/** A width x height PNG of one colour (8-bit RGB). The same input gives the same bytes. */
export function solidPng(width: number, height: number, rgb: readonly [number, number, number] = [0, 0, 0]): Uint8Array {
  const w = Math.max(1, Math.min(4096, Math.round(width)));
  const h = Math.max(1, Math.min(4096, Math.round(height)));
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([rgb[0] & 255, rgb[1] & 255, rgb[2] & 255], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))]));
}
