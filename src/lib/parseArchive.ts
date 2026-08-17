import JSZip from 'jszip';
import type { InputsMap } from '../types';

// ── Self-contained TAR parser ─────────────────────────────────────────────────

function parseTar(buffer: ArrayBuffer): { name: string; buffer: ArrayBuffer }[] {
  const files: { name: string; buffer: ArrayBuffer }[] = [];
  const view = new DataView(buffer);
  const decoder = new TextDecoder('utf-8');
  let offset = 0;

  const readStr = (off: number, len: number): string => {
    let end = off;
    while (end < off + len && view.getUint8(end) !== 0) end++;
    return decoder.decode(new Uint8Array(buffer, off, end - off));
  };

  while (offset + 512 <= buffer.byteLength) {
    const name = readStr(offset, 100);
    if (!name) { offset += 512; continue; }
    const prefix = readStr(offset + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(readStr(offset + 124, 12).trim(), 8) || 0;
    const typeFlag = readStr(offset + 156, 1);
    offset += 512;
    if (typeFlag !== '5' && size > 0) {
      files.push({ name: fullName, buffer: buffer.slice(offset, offset + size) });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

// ── Zip extraction ────────────────────────────────────────────────────────────

export async function extractInputsFromZip(file: File): Promise<InputsMap> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const inputsMap: InputsMap = {};
  const promises: Promise<void>[] = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    const normalized = relativePath.replace(/^[^/]+\//, '');
    const m = normalized.match(/^(?:.*\/)?([^/]+)\/(default|local)\/inputs\.conf$/i);
    if (!m) return;
    const [, appName, tierRaw] = m;
    const tier = tierRaw.toLowerCase() as 'default' | 'local';
    promises.push(
      entry.async('string').then(content => {
        if (!inputsMap[appName]) inputsMap[appName] = { default: null, local: null };
        inputsMap[appName][tier] = content;
      })
    );
  });
  await Promise.all(promises);
  return inputsMap;
}

// ── Tar/tgz extraction ────────────────────────────────────────────────────────

export async function extractInputsFromTar(file: File): Promise<InputsMap> {
  let buf = await file.arrayBuffer();

  // Decompress gzip if magic bytes match (1f 8b)
  const magic = new Uint8Array(buf, 0, 2);
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(buf));
    writer.close();
    const chunks: Uint8Array[] = [];
    const reader = ds.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    buf = merged.buffer;
  }

  const decoder = new TextDecoder('utf-8');
  const inputsMap: InputsMap = {};
  for (const f of parseTar(buf)) {
    const norm = f.name.replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/^[^/]+\//, '');
    const m = norm.match(/(?:^|.*\/)([^/]+)\/(default|local)\/inputs\.conf$/i);
    if (!m) continue;
    const [, appName, tierRaw] = m;
    const tier = tierRaw.toLowerCase() as 'default' | 'local';
    if (!inputsMap[appName]) inputsMap[appName] = { default: null, local: null };
    inputsMap[appName][tier] = decoder.decode(f.buffer);
  }
  return inputsMap;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function extractInputs(file: File): Promise<InputsMap> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.zip')) return extractInputsFromZip(file);
  return extractInputsFromTar(file);
}
