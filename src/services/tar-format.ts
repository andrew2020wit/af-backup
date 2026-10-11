// tar in POSIX pax format (docs/spec.md, "Compression" → "Archive layout"): for each entry a pax extended
// header (path, mtime with fractional seconds, size from 8 GiB) followed by a ustar header; permissions
// 0644/0755, owner 0. Moved from the prototype scripts/tar-gz-compatibility.ts.

export const BLOCK = 512;
/** 8 GiB - 1: anything larger does not fit into the octal size field. */
export const USTAR_MAXIMUM_SIZE = 8 ** 11 - 1;
const USTAR_MAXIMUM_TIME = 8 ** 11 - 1;

export function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** The tar end: two zero blocks. */
export function tarEnd(): Buffer {
  return Buffer.alloc(2 * BLOCK);
}

/** pax time: seconds with a fractional part, "1601234567.123456789"; negative times are allowed. */
export function formatPaxTime(nanoseconds: bigint): string {
  const sign = nanoseconds < 0n ? '-' : '';
  const absoluteNanoseconds = nanoseconds < 0n ? -nanoseconds : nanoseconds;
  const seconds = absoluteNanoseconds / 1_000_000_000n;
  const fraction = absoluteNanoseconds % 1_000_000_000n;

  return fraction === 0n ? `${sign}${seconds}` : `${sign}${seconds}.${fraction.toString().padStart(9, '0').replace(/0+$/, '')}`;
}

function truncateUtf8(bytes: Buffer, maximumLength: number): Buffer {
  if (bytes.length <= maximumLength) {
    return bytes;
  }

  let end = maximumLength;

  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end--; // do not cut in the middle of a character
  }

  return bytes.subarray(0, end);
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');

  if (text.length > length - 1) {
    throw new Error(`value ${value} does not fit into the tar field`);
  }

  header.write(`${text}\0`, offset, length, 'ascii');
}

// The name in the ustar header is a fallback for tools without pax support: the full name is in pax.
function setUstarName(header: Buffer, name: string): void {
  const bytes = Buffer.from(name, 'utf8');

  if (bytes.length <= 100) {
    bytes.copy(header, 0);

    return;
  }

  for (let i = bytes.indexOf(0x2f); i !== -1; i = bytes.indexOf(0x2f, i + 1)) {
    if (i <= 155 && bytes.length - i - 1 <= 100 && bytes.length - i - 1 > 0) {
      bytes.copy(header, 345, 0, i); // prefix
      bytes.copy(header, 0, i + 1); // name

      return;
    }
  }

  truncateUtf8(bytes, 100).copy(header, 0);
}

function ustarHeader(name: string, typeflag: string, size: number, mtimeNs: bigint): Buffer {
  const header = Buffer.alloc(BLOCK);
  setUstarName(header, name);
  writeOctal(header, 100, 8, typeflag === '5' ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid

  if (size <= USTAR_MAXIMUM_SIZE) {
    writeOctal(header, 124, 12, size);
  } else {
    // base-256 (GNU extension, understood by GNU tar, libarchive, 7-Zip); the exact size is in pax too
    let value = BigInt(size);

    for (let i = 135; i > 124; i--) {
      header[i] = Number(value & 0xffn);
      value >>= 8n;
    }

    header[124] = 0x80;
  }

  const seconds = Number(mtimeNs / 1_000_000_000n);
  writeOctal(header, 136, 12, Math.min(Math.max(seconds, 0), USTAR_MAXIMUM_TIME)); // the exact time is in pax
  header.write('        ', 148, 8, 'ascii'); // the checksum is computed with spaces in its own field
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeOctal(header, 329, 8, 0); // devmajor
  writeOctal(header, 337, 8, 0); // devminor
  let sum = 0;

  for (const byte of header) {
    sum += byte;
  }

  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

  return header;
}

function paxData(fields: [string, string][]): Buffer {
  const records = fields.map(([key, value]) => {
    const bodyLength = Buffer.byteLength(` ${key}=${value}\n`, 'utf8');
    let length = bodyLength + String(bodyLength).length;

    while (String(length).length + bodyLength !== length) {
      length = String(length).length + bodyLength;
    }

    return `${length} ${key}=${value}\n`;
  });

  return Buffer.from(records.join(''), 'utf8');
}

/** pax extended header + ustar header of an entry. @param relativePath path inside the archive, "/" separator */
export function entryHeaders(relativePath: string, type: 'file' | 'dir', size: number, mtimeNs: bigint): Buffer {
  const name = type === 'dir' ? `${relativePath}/` : relativePath;

  const fields: [string, string][] = [
    ['path', name],
    ['mtime', formatPaxTime(mtimeNs)],
  ];

  if (size > USTAR_MAXIMUM_SIZE) {
    fields.push(['size', String(size)]);
  }

  const pax = paxData(fields);
  const baseName = Buffer.from(relativePath.slice(relativePath.lastIndexOf('/') + 1), 'utf8');
  const paxName = `PaxHeader/${truncateUtf8(baseName, 80).toString('utf8')}`;

  return Buffer.concat([
    ustarHeader(paxName, 'x', pax.length, mtimeNs),
    pax,
    padding(pax.length),
    ustarHeader(name, type === 'dir' ? '5' : '0', type === 'dir' ? 0 : size, mtimeNs),
  ]);
}

// ---------- reading ----------

export function cString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);

  return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

export function parseNumber(header: Buffer, offset: number, length: number): number {
  if (header[offset]! & 0x80) {
    let value = BigInt(header[offset]! & 0x7f);

    for (let i = offset + 1; i < offset + length; i++) {
      value = (value << 8n) | BigInt(header[i]!);
    }

    return Number(value);
  }

  const text = cString(header, offset, length).trim();

  return text === '' ? 0 : parseInt(text, 8);
}

export function checksumOk(header: Buffer): boolean {
  let sum = 0;

  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  }

  return sum === parseNumber(header, 148, 8);
}

export function parsePax(data: Buffer): Map<string, string> | null {
  const fields = new Map<string, string>();
  let position = 0;

  while (position < data.length) {
    const space = data.indexOf(0x20, position);

    if (space === -1) {
      return null;
    }

    const length = parseInt(data.subarray(position, space).toString('ascii'), 10);

    if (!Number.isInteger(length) || length <= 0 || position + length > data.length) {
      return null;
    }

    const record = data.subarray(space + 1, position + length - 1).toString('utf8');
    const equalsIndex = record.indexOf('=');

    if (equalsIndex === -1) {
      return null;
    }

    fields.set(record.slice(0, equalsIndex), record.slice(equalsIndex + 1));
    position += length;
  }

  return fields;
}
