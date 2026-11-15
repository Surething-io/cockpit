import { createHash } from 'node:crypto';
import type { CodeIndex, IndexedFile, ParsedFile } from './codeIndex';

const RELATIONS = ['resolvedImports', 'importedFiles', 'importedBy', 'intraCalls', 'outgoingCalls', 'incomingCalls', 'externalCalls', 'methodCalls'] as const;
type Lookups = Pick<IndexedFile, 'symbolsByName' | 'symbolsByQname' | 'bindingsByLocalName' | 'reexportsByLocalName'>;
type Relations = Pick<IndexedFile, typeof RELATIONS[number]>;
export interface SharedParse { facts: ParsedFile; lookups: Lookups }
interface Entry<A> { key: string; value: A; references: number; bytes: number }
interface Repository {
  roots: number;
  parses: Map<string, Entry<SharedParse>>;
  relations: Map<string, Entry<Relations>[]>;
}
interface Lease {
  repository: string;
  parses: Entry<SharedParse>[];
  relations: Entry<Relations>[];
  bytes: number;
}

// Process-local schema: extraction changes must never reuse an older payload.
const PARSE_SCHEMA = 2;
const HEAP_ESTIMATE_HEADROOM = 1.25;
function parseKey(filePath: string, language: string, hash: string): string {
  return JSON.stringify([PARSE_SCHEMA, filePath, language, hash]);
}

function relationText(value: Relations): string {
  return JSON.stringify(RELATIONS.map(field => {
    const data = value[field];
    return data instanceof Map || data instanceof Set ? [...data] : data;
  }));
}

function parseBytes(facts: ParsedFile): number {
  // Heap estimates, not serialized sizes. Count shared blocks once.
  const structural = 768 + facts.flatSymbols.length * 1024 + facts.rawCalls.length * 96
    + facts.importBindings.length * 192 + facts.importSpecifiers.length * 64
    + facts.literals.length * 128;
  // Retain the former 4000 bytes/symbol safety floor (with headroom) for
  // symbol-heavy languages; the TypeScript measurements alone understate them.
  return Math.max(structural, facts.flatSymbols.length * 4000 / HEAP_ESTIMATE_HEADROOM);
}

/** Published roots own the pool. Unpublished builds may read it but never retain
 * entries. All payloads are read-only after publication; a revision builds fresh
 * relation collections before interning, including its incoming-edge inversion. */
export class IndexSharing {
  private readonly repositories = new Map<string, Repository>();
  private readonly leases = new Map<string, Lease>();
  private bytes = 0;

  findParse(repository: string, filePath: string, language: string, hash: string): SharedParse | undefined {
    return this.repositories.get(repository)?.parses.get(parseKey(filePath, language, hash))?.value;
  }

  /** Synchronous commit, called only after the owner's generation/HEAD checks.
   * Retain the new root before releasing the old one so equal blocks survive. */
  publish(index: CodeIndex, repository: string, hashes: ReadonlyMap<string, string>, facts: Map<string, ParsedFile | null>): void {
    let repo = this.repositories.get(repository);
    if (!repo) {
      repo = { roots: 0, parses: new Map(), relations: new Map() };
      this.repositories.set(repository, repo);
    }
    repo.roots++;
    const lease: Lease = { repository, parses: [], relations: [], bytes: 1024 + hashes.size * 512 };
    for (const [filePath, file] of index.files) {
      const parsed = facts.get(filePath)!;
      const key = parseKey(filePath, file.language, hashes.get(filePath)!);
      let parse = repo.parses.get(key);
      if (!parse) {
        parse = { key, value: { facts: parsed, lookups: {
          symbolsByName: file.symbolsByName, symbolsByQname: file.symbolsByQname,
          bindingsByLocalName: file.bindingsByLocalName, reexportsByLocalName: file.reexportsByLocalName,
        } }, references: 0, bytes: parseBytes(parsed) };
        repo.parses.set(key, parse);
        this.bytes += parse.bytes;
      }
      facts.set(filePath, parse.value.facts);
      const shared = parse.value.facts;
      file.symbolsTree = shared.symbolsTree;
      file.flatSymbols = shared.flatSymbols;
      file.literals = shared.literals;
      file.importBindings = shared.importBindings;
      Object.assign(file, parse.value.lookups);
      parse.references++;
      lease.parses.push(parse);

      const text = relationText(file);
      const relationKey = JSON.stringify([filePath, createHash('sha256').update(text).digest('hex')]);
      const bucket = repo.relations.get(relationKey) ?? [];
      // The digest locates candidates; equality establishes safe sharing.
      let relation = bucket.find(entry => relationText(entry.value) === text);
      if (!relation) {
        const value: Relations = {
          resolvedImports: file.resolvedImports, importedFiles: file.importedFiles, importedBy: file.importedBy,
          intraCalls: file.intraCalls, outgoingCalls: file.outgoingCalls, incomingCalls: file.incomingCalls,
          externalCalls: file.externalCalls, methodCalls: file.methodCalls,
        };
        relation = { key: relationKey, value, references: 0, bytes: 768 + Buffer.byteLength(text) * 2 };
        bucket.push(relation);
        repo.relations.set(relationKey, bucket);
        this.bytes += relation.bytes;
      }
      Object.assign(file, relation.value);
      relation.references++;
      lease.relations.push(relation);
    }
    this.release(index.cwd);
    this.leases.set(index.cwd, lease);
    this.bytes += lease.bytes;
  }

  release(cwd: string): void {
    const lease = this.leases.get(cwd);
    if (!lease) return;
    this.leases.delete(cwd);
    this.bytes -= lease.bytes;
    const repo = this.repositories.get(lease.repository)!;
    repo.roots--;
    for (const entry of lease.parses) if (--entry.references === 0) {
      repo.parses.delete(entry.key);
      this.bytes -= entry.bytes;
    }
    for (const entry of lease.relations) if (--entry.references === 0) {
      const bucket = repo.relations.get(entry.key)!;
      bucket.splice(bucket.indexOf(entry), 1);
      if (!bucket.length) repo.relations.delete(entry.key);
      this.bytes -= entry.bytes;
    }
    if (!repo.roots) this.repositories.delete(lease.repository);
  }

  has(cwd: string): boolean { return this.leases.has(cwd); }
  // Allow for string backing stores, map capacity and metadata not represented
  // by the structural estimates. This remains a best-effort eviction budget.
  estimatedBytes(): number { return Math.ceil(this.bytes * HEAP_ESTIMATE_HEADROOM); }

  stats(): { roots: number; repositories: number; parses: number; relations: number; estimatedBytes: number } {
    let parses = 0, relations = 0;
    for (const repo of this.repositories.values()) {
      parses += repo.parses.size;
      for (const bucket of repo.relations.values()) relations += bucket.length;
    }
    return { roots: this.leases.size, repositories: this.repositories.size, parses, relations, estimatedBytes: this.estimatedBytes() };
  }
}
