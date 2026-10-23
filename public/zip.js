// zip.js — a minimal .zip writer (stored, not compressed) for downloading an
// artifact's files from the viewer. Images and media are already compressed,
// and text files are small, so storing keeps this short and fast.

const enc = new TextEncoder();

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** { path: bytes } -> a Blob holding a .zip archive. */
export function zip(files, when = new Date()) {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const [path, bytes] of Object.entries(files)) {
    const name = enc.encode(path);
    const crc = crc32(bytes);
    // Shared by the local header (from offset 4) and the central directory entry (from offset 6).
    const fields = (h, at) => {
      h.setUint16(at, 20, true);            // version needed
      h.setUint16(at + 2, 0x0800, true);    // UTF-8 names
      h.setUint16(at + 4, 0, true);         // stored
      h.setUint16(at + 6, time, true);
      h.setUint16(at + 8, date, true);
      h.setUint32(at + 10, crc, true);
      h.setUint32(at + 14, bytes.length, true);
      h.setUint32(at + 18, bytes.length, true);
      h.setUint16(at + 22, name.length, true);
    };
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    fields(local, 4);
    parts.push(local, name, bytes);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);           // version made by
    fields(entry, 6);
    entry.setUint32(42, offset, true);
    central.push(entry, name);
    offset += 30 + name.length + bytes.length;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length / 2, true);
  end.setUint16(10, central.length / 2, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
