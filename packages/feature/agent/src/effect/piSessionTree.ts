import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/** Locate a complete human turn even when the selected bubble is an assistant. */
export function piTurn(entries: SessionEntry[], target: string): { start: number; end: number } | undefined {
  const index = entries.findIndex((entry) => entry.id === target);
  if (index < 0) return undefined;
  const isUser = (entry: SessionEntry) => entry.type === 'message' && entry.message.role === 'user';
  let start = index;
  while (start >= 0 && !isUser(entries[start])) start--;
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < entries.length && !isUser(entries[end])) end++;
  return { start, end };
}

const references = (entry: SessionEntry): string[] => {
  const refs: Array<string | null> = [entry.parentId];
  if (entry.type === 'label' || entry.type === 'context_edit') refs.push(entry.targetId);
  if (entry.type === 'compaction') refs.push(entry.firstKeptEntryId);
  if (entry.type === 'branch_summary') refs.push(entry.fromId);
  return refs.filter((id): id is string => typeof id === 'string');
};

type LabelEntry = Extract<SessionEntry, { type: 'label' }>;
const labelsOf = (entries: SessionEntry[]): Map<string, LabelEntry> => {
  const labels = new Map<string, LabelEntry>();
  for (const entry of entries) if (entry.type === 'label') labels.set(entry.targetId, entry);
  return labels;
};

/** Edit one path while preserving every node required by the other native branches. */
export function deletePiBranchTurn(all: SessionEntry[], active: SessionEntry[], target: string,
  options: { newId: () => string; timestamp: string },
): { entries: SessionEntry[]; deletedLineCount: number } | undefined {
  const turn = piTurn(active, target);
  if (!turn) return undefined;
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  const activeIds = new Set(active.map((entry) => entry.id));
  const removed = new Set(active.slice(turn.start, turn.end).map((entry) => entry.id));
  const protectedIds = new Set<string>();
  const pending = all.filter((entry) => !activeIds.has(entry.id)).map((entry) => entry.id);
  while (pending.length) {
    const id = pending.pop()!;
    if (protectedIds.has(id)) continue;
    const entry = byId.get(id);
    if (!entry) throw new Error('Pi branch has a missing reference');
    protectedIds.add(id);
    pending.push(...references(entry));
  }

  // Edits and labels follow their target, even if appended during the removed turn.
  let keptActive = active.filter((entry) => entry.type === 'context_edit' || entry.type === 'label'
    ? !removed.has(entry.targetId)
    : !removed.has(entry.id) && entry.type !== 'compaction' && entry.type !== 'branch_summary');
  // Summary invalidation removes nodes beyond the selected turn. Prune
  // dependent metadata against the final candidates, including label chains.
  const available = new Set([...protectedIds, ...keptActive.map((entry) => entry.id)]);
  const dependents = new Map<string, string[]>();
  const invalid: string[] = [];
  for (const entry of keptActive) if (entry.type === 'label' || entry.type === 'context_edit') {
    const ids = dependents.get(entry.targetId) ?? [];
    ids.push(entry.id);
    dependents.set(entry.targetId, ids);
    if (!available.has(entry.targetId)) invalid.push(entry.id);
  }
  for (let i = 0; i < invalid.length; i++) {
    const id = invalid[i];
    if (protectedIds.has(id) || !available.delete(id)) continue;
    invalid.push(...(dependents.get(id) ?? []));
  }
  keptActive = keptActive.filter((entry) => available.has(entry.id));
  const used = new Set(byId.keys());
  const allocate = () => {
    const id = options.newId();
    if (used.has(id)) throw new Error('Duplicate Pi entry id');
    used.add(id);
    return id;
  };
  const remap = new Map<string, string>();
  const changed: SessionEntry[] = [];
  let parentId: string | null = null;
  for (const entry of keptActive) {
    let updated: SessionEntry = { ...entry, parentId };
    if (updated.type === 'label' || updated.type === 'context_edit') updated = { ...updated, targetId: remap.get(updated.targetId) ?? updated.targetId };
    const referenceChanged = (updated.type === 'label' || updated.type === 'context_edit')
      && (entry.type === 'label' || entry.type === 'context_edit') && updated.targetId !== entry.targetId;
    if (protectedIds.has(entry.id)) {
      if (entry.parentId !== parentId || referenceChanged) updated = { ...updated, id: allocate() };
      else { remap.set(entry.id, entry.id); parentId = entry.id; continue; }
    }
    remap.set(entry.id, updated.id);
    changed.push(updated);
    parentId = updated.id;
  }

  const entries = [...all.filter((entry) => protectedIds.has(entry.id)), ...changed];
  // Labels also have global last-record semantics. Preserve the effective
  // state (including clears and timestamps) on surviving originals and copies.
  const surviving = new Set(entries.map((entry) => entry.id));
  const desiredLabels = new Map<string, LabelEntry>();
  for (const [id, label] of labelsOf(all)) {
    if (surviving.has(id)) desiredLabels.set(id, label);
    const copy = remap.get(id);
    if (copy && copy !== id && surviving.has(copy)) desiredLabels.set(copy, label);
  }
  const currentLabels = labelsOf(entries);
  for (const [targetId, label] of desiredLabels) {
    const current = currentLabels.get(targetId);
    if ((current?.label || undefined) === (label.label || undefined)
      && (current?.label ? current.timestamp : undefined) === (label.label ? label.timestamp : undefined)) continue;
    const restored: LabelEntry = { ...label, id: allocate(), targetId, parentId };
    entries.push(restored);
    parentId = restored.id;
  }
  // Session names are global: native Pi reads the last physical session_info,
  // independently of the active branch. Preserve explicit clears as well as names.
  const originalName = all.findLast((entry) => entry.type === 'session_info');
  const currentName = entries.findLast((entry) => entry.type === 'session_info');
  if (originalName && (!currentName || (originalName.name?.trim() || '') !== (currentName.name?.trim() || ''))) {
    const restored: SessionEntry = { ...originalName, id: allocate(), parentId, timestamp: options.timestamp };
    entries.push(restored);
    parentId = restored.id;
  }
  // Native Pi chooses the last physical entry as its active leaf on reload.
  // A metadata-only marker selects the edited path without adding model context.
  entries.push({ type: 'custom', customType: 'cockpit.branch-after-delete', id: allocate(), parentId, timestamp: options.timestamp });
  const ids = new Set(entries.map((entry) => entry.id));
  if (ids.size !== entries.length) throw new Error('Duplicate Pi entry id');
  const parents = new Map(entries.map((entry) => [entry.id, entry.parentId]));
  const validated = new Set<string>();
  for (const entry of entries) {
    if (references(entry).some((id) => !ids.has(id))) throw new Error('Pi edit would leave a missing reference');
    const path = new Set<string>();
    let id: string | null = entry.id;
    while (id !== null && !validated.has(id)) {
      if (path.has(id)) throw new Error('Pi edit would leave a parent cycle');
      path.add(id);
      id = parents.get(id) ?? null;
    }
    for (const id of path) validated.add(id);
  }
  return { entries, deletedLineCount: active.length - keptActive.length };
}
