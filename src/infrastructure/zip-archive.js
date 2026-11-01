import { deflateRawSync, inflateRawSync } from "node:zlib";

// Minimal ZIP reader and writer for small dashboard packages. Archives come
// from the browser, so entry counts and inflated sizes are bounded before any
// data is kept. Nothing here touches the filesystem, so entry paths are only
// ever names to the caller.

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const END_RECORD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const UTF8_NAME_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const STORED = 0;
const DEFLATED = 8;

const crcTable = Int32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});

function crc32(data) {
  let crc = -1;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

export function createZipArchive(files, { at = new Date() } = {}) {
  const stamp = dosDateTime(at);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(String(file.name), "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? DEFLATED : STORED;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAME_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAME_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(END_RECORD_BYTES);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function isZipArchive(data) {
  return Buffer.isBuffer(data) && data.length >= 4 && data.readUInt32LE(0) === LOCAL_HEADER;
}

// Sizes come from the central directory, so archives written with streaming
// data descriptors (macOS Finder, for one) read the same way.
export function readZipArchive(data, { maxEntries = 2000, maxEntryBytes = 16 * 1024 * 1024, maxTotalBytes = 64 * 1024 * 1024 } = {}) {
  const end = findEndRecord(data);
  const count = data.readUInt16LE(end + 10);
  if (count > maxEntries) throw new RangeError(`ZIP archive has more than ${maxEntries} entries`);
  let position = data.readUInt32LE(end + 16);
  const entries = [];
  let totalBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > data.length || data.readUInt32LE(position) !== CENTRAL_HEADER) {
      throw new TypeError("ZIP archive directory is damaged");
    }
    const flags = data.readUInt16LE(position + 8);
    const method = data.readUInt16LE(position + 10);
    const expectedCrc = data.readUInt32LE(position + 16);
    const compressedSize = data.readUInt32LE(position + 20);
    const size = data.readUInt32LE(position + 24);
    const nameLength = data.readUInt16LE(position + 28);
    const extraLength = data.readUInt16LE(position + 30);
    const commentLength = data.readUInt16LE(position + 32);
    const localOffset = data.readUInt32LE(position + 42);
    const name = decodeName(data.subarray(position + 46, position + 46 + nameLength), flags);
    position += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (flags & ENCRYPTED_FLAG) throw new TypeError("encrypted ZIP archives are not supported");
    if (method !== STORED && method !== DEFLATED) throw new TypeError("ZIP archive uses an unsupported compression method");
    if (size > maxEntryBytes) throw new RangeError(`ZIP entry is too large: ${name}`);
    totalBytes += size;
    if (totalBytes > maxTotalBytes) throw new RangeError("ZIP archive is too large once extracted");
    entries.push({ name, data: readEntry(data, { localOffset, compressedSize, size, method, expectedCrc, name }) });
  }
  return entries;
}

function findEndRecord(data) {
  if (!Buffer.isBuffer(data) || data.length < END_RECORD_BYTES) throw new TypeError("file is not a ZIP archive");
  const lowest = Math.max(0, data.length - END_RECORD_BYTES - MAX_COMMENT_BYTES);
  for (let position = data.length - END_RECORD_BYTES; position >= lowest; position -= 1) {
    if (data.readUInt32LE(position) === END_OF_CENTRAL_DIRECTORY) return position;
  }
  throw new TypeError("file is not a ZIP archive");
}

function decodeName(bytes, flags) {
  const name = flags & UTF8_NAME_FLAG ? bytes.toString("utf8") : decodeLegacyText(bytes);
  return name.replaceAll("\\", "/");
}

// Windows tools usually store names in the local code page without saying so.
function decodeLegacyText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

function readEntry(data, { localOffset, compressedSize, size, method, expectedCrc, name }) {
  if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== LOCAL_HEADER) {
    throw new TypeError(`ZIP entry is damaged: ${name}`);
  }
  const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
  if (start + compressedSize > data.length) throw new TypeError(`ZIP entry is damaged: ${name}`);
  const body = data.subarray(start, start + compressedSize);
  let content;
  try {
    // The output cap stops a directory that understates its inflated size.
    content = method === DEFLATED ? inflateRawSync(body, { maxOutputLength: size + 1 }) : body;
  } catch {
    throw new TypeError(`ZIP entry is damaged: ${name}`);
  }
  if (content.length !== size || crc32(content) !== expectedCrc) throw new TypeError(`ZIP entry is damaged: ${name}`);
  return content;
}
