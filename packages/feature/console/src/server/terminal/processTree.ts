/**
 * Process-tree interrupt — the one "stop this command" semantics shared by the
 * bubble's stop button (ws/terminal `interrupt`) and the running-terminals
 * board. SIGTERM the whole tree, SIGKILL whatever is left a second later.
 *
 * Unlike `killCommand` this does NOT tombstone the registry entry: the exit is
 * persisted normally and the bubble stays, showing the command as finished.
 */
import { execSync } from "child_process"
import { isWindows } from "@cockpit/shared-utils"

/**
 * Windows: the whole parent→children table in one query.
 *
 * `wmic` used to serve this, but it is deprecated and no longer installed by
 * default from Windows 11 24H2 — the old call just threw and was swallowed,
 * silently reporting that nothing had children. PowerShell's CIM cmdlet is the
 * supported replacement, but spawning it once per tree level (~300ms each)
 * would make a deep tree unusable, so fetch the table once and walk it here.
 */
function windowsChildPidMap(): Map<number, number[]> {
  const out = execSync(
    'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation"',
    { encoding: "utf-8", timeout: 5000 }
  )
  const byParent = new Map<number, number[]>()
  for (const line of out.split(/\r?\n/).slice(1)) {
    const m = line.match(/^"?(\d+)"?,"?(\d+)"?/)
    if (!m) continue
    const child = Number(m[1])
    const parent = Number(m[2])
    const bucket = byParent.get(parent)
    if (bucket) bucket.push(child)
    else byParent.set(parent, [child])
  }
  return byParent
}

export function getDescendantPids(pid: number): number[] {
  const descendants: number[] = []

  if (isWindows) {
    let byParent: Map<number, number[]>
    try {
      byParent = windowsChildPidMap()
    } catch {
      return descendants
    }
    // `seen` guards against a cycle: a dead parent's pid can be recycled by a
    // process that is itself a descendant, which would otherwise recurse until
    // the stack blows.
    const seen = new Set<number>([pid])
    const walk = (parentPid: number) => {
      for (const child of byParent.get(parentPid) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        walk(child)
        descendants.push(child)
      }
    }
    walk(pid)
    return descendants
  }

  function collect(parentPid: number) {
    try {
      const result = execSync(`pgrep -P ${parentPid}`, {
        encoding: "utf-8",
        timeout: 3000,
      }).trim()
      const childPids = result.split("\n").filter(Boolean).map(Number)
      for (const cp of childPids) {
        collect(cp)
        descendants.push(cp)
      }
    } catch {
      /* no children */
    }
  }
  collect(pid)
  return descendants
}

/** SIGTERM `pid` and all its descendants; SIGKILL the survivors after 1s. */
export function interruptPidTree(pid: number): void {
  if (!pid) return
  const allPids = [...getDescendantPids(pid), pid]
  for (const p of allPids) {
    try {
      process.kill(p, "SIGTERM")
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => {
    for (const p of allPids) {
      try {
        process.kill(p, 0)
        process.kill(p, "SIGKILL")
      } catch {
        /* exited */
      }
    }
  }, 1000)
}
