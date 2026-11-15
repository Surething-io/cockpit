/** Direct code relationships, derived on demand from the base index. */
import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import {
  callersFromIndex,
  calleesFromIndex,
  findTargetFiles,
  type CodeIndex,
} from '../projectGraph/codeIndex';
import { coEditAuto, type CoEditHistoryEntry } from '../projectGraph/coedit';
import type { FunctionNode } from '../projectGraph/types';

export type Relation =
  | { type: 'caller'; callLines: number[] }
  | { type: 'callee'; callLines: number[] }
  | { type: 'frequent-coedit'; cooccurrence: number; totalCommits: number };

export interface RelatedHit extends FunctionNode {
  score: number;
  relations: Relation[];
}

export interface CoeditEntry extends CoEditHistoryEntry {
  totalCommits: number;
}

export interface RelatedResponse {
  target: { filePath: string; qualifiedName: string } | null;
  ambiguousIn?: string[];
  results: RelatedHit[];
  coedit: CoeditEntry[];
  degraded: boolean;
  degradedReason?: 'coedit-unavailable' | 'truncated';
}

export interface RelatedInput {
  qname: string;
  filePath?: string;
  topK?: number;
  include?: 'structural' | 'coedit' | 'all';
}

export function buildRelated(index: CodeIndex, input: RelatedInput) {
  return Effect.gen(function* () {
    const topK = Math.min(Math.max(input.topK ?? 10, 1), 30);
    const include = input.include ?? 'all';
    const targets = findTargetFiles(index, input.qname, input.filePath);
    if (targets.length > 1) {
      return { target: null, ambiguousIn: targets.map(file => file.path).sort(), results: [], coedit: [],
        degraded: index.truncated, degradedReason: index.truncated ? 'truncated' : undefined } satisfies RelatedResponse;
    }
    const primary = targets[0];
    if (!primary) {
      return { target: null, results: [], coedit: [], degraded: index.truncated,
        degradedReason: index.truncated ? 'truncated' : undefined } satisfies RelatedResponse;
    }

    const hits = new Map<string, RelatedHit>();
    const add = (symbol: FunctionNode, relation: Relation, score: number) => {
      if (symbol.kind === 'unknown') return;
      if (symbol.filePath === primary.path && symbol.qualifiedName === input.qname) return;
      const key = `${symbol.filePath}::${symbol.qualifiedName}`;
      let hit = hits.get(key);
      if (!hit) {
        hit = { ...symbol, score: 0, relations: [] };
        hits.set(key, hit);
      }
      hit.score += score;
      hit.relations.push(relation);
    };

    if (include !== 'coedit') {
      for (const { caller, callLines } of callersFromIndex(index, input.qname, primary.path).callers) {
        add(caller, { type: 'caller', callLines }, 0.4);
      }
      for (const { callee, callLines } of calleesFromIndex(index, input.qname, primary.path).callees) {
        add(callee, { type: 'callee', callLines }, 0.4);
      }
    }

    const coedit: CoeditEntry[] = [];
    let coeditUnavailable = false;
    if (include !== 'structural') {
      const result = yield* Effect.either(Effect.tryPromise({
        try: () => coEditAuto(index.cwd, primary.path, 100),
        catch: (cause) => new AppError({ message: 'Coedit lookup failed', cause }),
      }));
      if (result._tag === 'Left') {
        coeditUnavailable = true;
      } else {
        const { history, totalCommits } = result.right;
        for (const row of history.slice(0, 30)) coedit.push({ ...row, totalCommits });
        if (totalCommits > 0) {
          for (const row of history.slice(0, 8)) {
            const probability = row.cooccurrence / totalCommits;
            if (probability < 0.2) continue;
            // Coedit is file-level evidence. Use its first real symbol as
            // a navigation anchor; the raw history also retains non-code paths.
            const file = index.files.get(row.filePath);
            const symbol = file?.flatSymbols.find((s) => s.kind !== 'unknown');
            if (!symbol) continue;
            add(symbol, { type: 'frequent-coedit', cooccurrence: row.cooccurrence, totalCommits }, 0.3 * probability);
          }
        }
      }
    }

    const results = [...hits.values()].sort((a, b) =>
      b.score - a.score || a.filePath.localeCompare(b.filePath)
      || a.qualifiedName.localeCompare(b.qualifiedName) || a.startLine - b.startLine,
    ).slice(0, topK);
    const degradedReason = index.truncated ? 'truncated'
      : coeditUnavailable ? 'coedit-unavailable' : undefined;
    return {
      target: { filePath: primary.path, qualifiedName: input.qname },
      results,
      coedit,
      degraded: degradedReason !== undefined,
      degradedReason,
    } satisfies RelatedResponse;
  });
}
