import { run, type FossilReply, type FossilRequest } from './fossil';
import { SEARCH_LIMITS } from './search';

type SourceBlob = { size:number; parent:number | null; stored:number; prefix:ArrayBuffer | null };
const SOURCE_LIMITS = { nodes:128, depth:32, queries:4096, work:2 * 1024 * 1024 };
const DELTA_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~';

/** Bound every manifest, baseline, tree node and delta basis the engine actually
 * requests, not just the final HTML payload. A refused SQL read stops before its
 * compressed bytes cross into WASM. Async streaming validation then certifies a
 * bounded blob before replaying the read-only operation. */
export class SearchSource {
  private readonly bounded: DurableObjectStorage;
  private readonly blobs = new Map<number,SourceBlob>();
  private readonly certified = new Map<number,number>();
  private pending: number | null = null;
  private refused = false;
  private queries = 0;
  private work = 0;

  constructor(private readonly storage: DurableObjectStorage) {
    const sql = new Proxy(storage.sql, { get:(target,key) => {
      if (key === 'exec') return (query:string,...bindings:SqlStorageValue[]) => {
        this.beforeQuery(query,bindings);
        return target.exec(query,...bindings);
      };
      const value = Reflect.get(target,key,target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    this.bounded = new Proxy(storage,{get:(target,key) => {
      if (key === 'sql') return sql;
      const value = Reflect.get(target,key,target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
  }

  private refuse(): never { this.refused = true; throw new Error('bounded search source refused'); }

  private blob(rid:number): SourceBlob {
    const known = this.blobs.get(rid);
    if (known) return known;
    if (this.blobs.size >= SOURCE_LIMITS.nodes) return this.refuse();
    const row = this.storage.sql.exec<SourceBlob>(`SELECT b.size,d.srcid AS parent,length(b.content) AS stored,substr(b.content,1,4) AS prefix
      FROM blob b LEFT JOIN delta d ON d.rid=b.rid WHERE b.rid=?`,rid).toArray()[0];
    if (!row || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > SEARCH_LIMITS.fileBytes
      || !row.prefix || row.prefix.byteLength !== 4 || row.stored < 5 || row.stored > SEARCH_LIMITS.fileBytes+1024
      || new DataView(row.prefix).getUint32(0) > SEARCH_LIMITS.fileBytes) return this.refuse();
    this.blobs.set(rid,row);
    return row;
  }

  private chain(rid:number): void {
    const seen = new Set<number>();
    let expanded = 0;
    while (true) {
      if (rid <= 0 || seen.has(rid) || seen.size >= SOURCE_LIMITS.depth) return this.refuse();
      seen.add(rid);
      const blob = this.blob(rid);
      expanded += blob.size + new DataView(blob.prefix!).getUint32(0);
      if (expanded > SOURCE_LIMITS.work) return this.refuse();
      if (!this.certified.has(rid)) this.pending ??= rid;
      if (blob.parent === null) break;
      rid = blob.parent;
    }
    if (this.pending !== null) throw new Error('search source needs bounded validation');
  }

  private beforeQuery(query:string,bindings:SqlStorageValue[]): void {
    if (this.refused || ++this.queries > SOURCE_LIMITS.queries) return this.refuse();
    // Pinned go-libfossil v0.17.0: availability, delta walk and blob.Load all
    // address one rid. Unknown content-reading shapes fail closed on upgrades.
    const ridQuery = /\bfrom\s+(?:blob|delta)\b/i.test(query) && /\bwhere\s+(?:b\.)?rid\s*=\s*\?/i.test(query);
    if (ridQuery && typeof bindings[0] === 'number') this.chain(bindings[0]);
    if (/^\s*select\s+content\s*,\s*size\s+from\s+blob\s+where\s+rid\s*=\s*\?\s*$/i.test(query) && typeof bindings[0] === 'number') {
      const blob = this.blob(bindings[0]);
      this.work += blob.size + this.certified.get(bindings[0])!;
      if (this.work > SOURCE_LIMITS.work) return this.refuse();
    } else if (/\bselect\b[\s\S]*(?:\bcontent\b|\*)[\s\S]*\bfrom\s+blob\b/i.test(query)) return this.refuse();
  }

  private async certify(rid:number): Promise<void> {
    const blob = this.blob(rid);
    const row = this.storage.sql.exec<{content:ArrayBuffer}>('SELECT content FROM blob WHERE rid=?',rid).toArray()[0];
    if (!row?.content || row.content.byteLength !== blob.stored) return this.refuse();
    // A dishonest prefix must not produce a huge native output chunk before
    // the JS budget sees it. Feed deflate only 128 compressed bytes at a time.
    let offset = 4;
    const compressed = new ReadableStream<Uint8Array>({pull(controller) {
      if (offset >= row.content.byteLength) { controller.close(); return; }
      const length = Math.min(128,row.content.byteLength-offset);
      controller.enqueue(new Uint8Array(row.content,offset,length)); offset += length;
    }});
    const stream = compressed.pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    let size = 0, header = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > SEARCH_LIMITS.fileBytes || this.work + size > SOURCE_LIMITS.work) return this.refuse();
        if (header.length < 16) header += new TextDecoder().decode(chunk.value.slice(0,16-header.length));
      }
    } finally { await reader.cancel(); }
    if (size !== new DataView(blob.prefix!).getUint32(0)) return this.refuse();
    if (blob.parent === null) {
      if (size !== blob.size) return this.refuse();
    } else {
      const end = header.indexOf('\n');
      if (end < 1 || end > 10) return this.refuse();
      let target = 0;
      for (const character of header.slice(0,end)) {
        const digit = DELTA_DIGITS.indexOf(character);
        if (digit < 0) return this.refuse();
        target = target*64+digit;
        if (target > SEARCH_LIMITS.fileBytes) return this.refuse();
      }
      if (target !== blob.size) return this.refuse();
    }
    this.work += size;
    this.certified.set(rid,size);
  }

  async read<T>(request:FossilRequest): Promise<FossilReply<T>> {
    while (!this.refused) {
      this.pending = null;
      const reply = run<T>(this.bounded,request);
      if (this.pending === null) return reply;
      try { await this.certify(this.pending); } catch { this.refused = true; }
    }
    return {error:'Search source exceeds the bounded expansion budget',code:'search_limit'};
  }
}
