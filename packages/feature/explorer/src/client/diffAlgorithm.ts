// ============================================
// Types
// ============================================

export interface DiffLine {
  type: 'unchanged' | 'removed' | 'added';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

// ============================================
// Line diff: common prefix/suffix trim + Myers O((N+M)·D)
// ============================================
//
// The previous implementation filled a full (m+1)×(n+1) LCS table, which for
// a 7k-line file is ~50M boxed cells — the tab froze or ran out of memory and
// the diff never rendered. Myers costs time proportional to the edit distance
// and, with per-step snapshots of the frontier, O(D²) memory, so it is capped:
// past MAX_EDIT_DISTANCE the changed middle is shown as one remove + add block
// (still a correct diff, just not a minimal one).

const MAX_EDIT_DISTANCE = 2000;

export function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  // Most real diffs touch a small region; trimming makes them nearly free.
  let start = 0;
  while (start < m && start < n && oldLines[start] === newLines[start]) start++;
  let endOld = m;
  let endNew = n;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }

  const result: DiffLine[] = [];
  const unchanged = (i: number, j: number) =>
    result.push({ type: 'unchanged', content: oldLines[i], oldLineNum: i + 1, newLineNum: j + 1 });
  const removed = (i: number) => result.push({ type: 'removed', content: oldLines[i], oldLineNum: i + 1 });
  const added = (j: number) => result.push({ type: 'added', content: newLines[j], newLineNum: j + 1 });

  for (let k = 0; k < start; k++) unchanged(k, k);

  const script = myers(oldLines, start, endOld, newLines, start, endNew);
  if (script) {
    let i = start;
    let j = start;
    for (const op of script) {
      if (op === OP_EQUAL) unchanged(i++, j++);
      else if (op === OP_REMOVE) removed(i++);
      else added(j++);
    }
  } else {
    for (let i = start; i < endOld; i++) removed(i);
    for (let j = start; j < endNew; j++) added(j);
  }

  for (let k = 0; k < m - endOld; k++) unchanged(endOld + k, endNew + k);
  return result;
}

const OP_EQUAL = 0;
const OP_REMOVE = 1;
const OP_ADD = 2;

/**
 * Myers' greedy shortest-edit-script over a[aLo..aHi) and b[bLo..bHi).
 * Returns the ops in forward order (removals before additions inside a
 * hunk), or null when the edit distance exceeds MAX_EDIT_DISTANCE.
 */
function myers(
  a: string[], aLo: number, aHi: number,
  b: string[], bLo: number, bHi: number,
): Uint8Array | null {
  const N = aHi - aLo;
  const M = bHi - bLo;
  if (N === 0 && M === 0) return new Uint8Array(0);
  if (N === 0) return new Uint8Array(M).fill(OP_ADD);
  if (M === 0) return new Uint8Array(N).fill(OP_REMOVE);

  // Intern lines so the snake loop compares ints, not strings.
  const ids = new Map<string, number>();
  const intern = (s: string) => {
    let id = ids.get(s);
    if (id === undefined) { id = ids.size; ids.set(s, id); }
    return id;
  };
  const A = new Int32Array(N);
  const B = new Int32Array(M);
  for (let i = 0; i < N; i++) A[i] = intern(a[aLo + i]);
  for (let j = 0; j < M; j++) B[j] = intern(b[bLo + j]);

  const maxD = Math.min(N + M, MAX_EDIT_DISTANCE);
  const offset = maxD + 1;
  const v = new Int32Array(2 * offset + 1);
  // trace[d] = frontier V[-d..d] as it stood *before* step d.
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // Backtrack, collecting ops in reverse.
  const ops = new Uint8Array(N + M);
  let p = ops.length;
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]; // frontier before step d, indexed by k + d
    const k = x - y;
    const fromAbove = k === -d || (k !== d && prev[k - 1 + d] < prev[k + 1 + d]);
    const prevK = fromAbove ? k + 1 : k - 1;
    const prevX = prev[prevK + d];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops[--p] = OP_EQUAL; x--; y--; }
    if (fromAbove) { ops[--p] = OP_ADD; y--; } else { ops[--p] = OP_REMOVE; x--; }
  }
  while (x > 0 && y > 0) { ops[--p] = OP_EQUAL; x--; y--; }
  return ops.subarray(p);
}
