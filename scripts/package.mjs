import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const manifestPath = path.join(ROOT, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const version = manifest.version;
if (!version) {
  throw new Error("manifest.json is missing a version field");
}

const distDir = path.join(ROOT, "dist");
fs.mkdirSync(distDir, { recursive: true });
const outZipPath = path.join(distDir, `mathsclip-v${version}.zip`);

/**
 * Compute standard IEEE 802.3 CRC-32 for a Buffer.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

function collectFiles(relDir) {
  const absDir = path.join(ROOT, relDir);
  if (!fs.existsSync(absDir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const relPath = path.posix.join(relDir.replace(/\\/g, "/"), entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(relPath));
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }
  return results;
}

const filesToPackage = [
  "manifest.json",
  ...collectFiles("icons").sort(),
  ...collectFiles("src").sort(),
];

const localChunks = [];
const centralChunks = [];
let offset = 0;

for (const relPath of filesToPackage) {
  const absPath = path.join(ROOT, relPath);
  const data = fs.readFileSync(absPath);
  const stat = fs.statSync(absPath);
  const { dosTime, dosDate } = toDosTimeDate(stat.mtime);

  const crc = crc32(data);
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = compressed.length < data.length;
  const payload = useDeflate ? compressed : data;
  const method = useDeflate ? 8 : 0;

  const nameBuf = Buffer.from(relPath, "utf8");

  // Local file header (30 bytes + filename)
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // signature
  localHeader.writeUInt16LE(20, 4); // version needed (2.0)
  localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
  localHeader.writeUInt16LE(method, 8);
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(payload.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra length

  localChunks.push(localHeader, nameBuf, payload);

  // Central directory header (46 bytes + filename)
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0); // signature
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
  centralHeader.writeUInt16LE(method, 10);
  centralHeader.writeUInt16LE(dosTime, 12);
  centralHeader.writeUInt16LE(dosDate, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(payload.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30); // extra length
  centralHeader.writeUInt16LE(0, 32); // comment length
  centralHeader.writeUInt16LE(0, 34); // disk number start
  centralHeader.writeUInt16LE(0, 36); // internal attrs
  centralHeader.writeUInt32LE(0, 38); // external attrs
  centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

  centralChunks.push(centralHeader, nameBuf);
  offset += localHeader.length + nameBuf.length + payload.length;
}

const centralDirOffset = offset;
const centralDirBuf = Buffer.concat(centralChunks);

// End of central directory record (22 bytes)
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4); // disk number
eocd.writeUInt16LE(0, 6); // central dir start disk
eocd.writeUInt16LE(filesToPackage.length, 8);
eocd.writeUInt16LE(filesToPackage.length, 10);
eocd.writeUInt32LE(centralDirBuf.length, 12);
eocd.writeUInt32LE(centralDirOffset, 16);
eocd.writeUInt16LE(0, 20); // comment length

const zipBuffer = Buffer.concat([...localChunks, centralDirBuf, eocd]);
fs.writeFileSync(outZipPath, zipBuffer);

console.log(`Packaged ${filesToPackage.length} files into ${path.relative(ROOT, outZipPath)} (${zipBuffer.length} bytes):`);
for (const f of filesToPackage) {
  console.log(`  - ${f}`);
}
