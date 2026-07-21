/**
 * Services config — custom command normalization.
 *
 * SCHEMA EVOLUTION:
 *   Original on-disk shape: `customCommands: string[]` (raw command lines).
 *   New shape:              `customCommands: { name, command }[]`
 *
 * The shape changed without a migration, so configs written before the quick
 * commands rework still hold bare strings. A bare string has no `.name`, which
 * used to crash the slash-completion filter in ConsoleInputBar (`c.name
 * .toLowerCase()`) and take down the whole React tree.
 *
 * Reads normalize the legacy shape in place: bare strings are upgraded to
 * `{ name, command }` with a name derived from the command itself, so the
 * user's commands survive instead of being discarded. Entries that are neither
 * a string nor a well-formed object are dropped.
 */

export interface CustomCommand {
  name: string
  command: string
}

/**
 * Derive a usable slash-command name from a raw command line.
 * `open https://x/y`  → `open`
 * `http://localhost:3000` → `localhost3000`
 */
const deriveCommandName = (command: string): string => {
  const firstWord = command.trim().split(/\s+/)[0] ?? ""
  // For a bare URL the first word is the whole URL — use its host instead.
  const url = firstWord.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)
  // Last-resort literal: a command of pure punctuation sanitizes to nothing,
  // and an empty name is unmatchable AND unremovable from the panel.
  return sanitizeName(url ? url[1] : firstWord) || "command"
}

/**
 * Reduce a name to what slash completion can actually match.
 *
 * `ConsoleInputBar` matches on the first whitespace-delimited word after `/`,
 * so a name containing a space (or `/`, quotes, …) can be stored and displayed
 * but never invoked. Applied to user-supplied names too, not just derived ones
 * — otherwise typing `my cmd` in the panel silently creates a dead entry.
 */
const sanitizeName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32)

/**
 * Coerce arbitrary on-disk data into a valid CustomCommand[].
 * Never throws; unusable entries are dropped, names are de-duplicated.
 */
export const normalizeCustomCommands = (raw: unknown): CustomCommand[] => {
  if (!Array.isArray(raw)) return []

  const taken = new Set<string>()
  const uniqueName = (name: string): string => {
    if (!taken.has(name)) {
      taken.add(name)
      return name
    }
    let n = 2
    while (taken.has(`${name}-${n}`)) n++
    taken.add(`${name}-${n}`)
    return `${name}-${n}`
  }

  const out: CustomCommand[] = []
  for (const entry of raw) {
    // Legacy shape: a bare command string.
    if (typeof entry === "string") {
      const command = entry.trim()
      if (!command) continue
      out.push({ name: uniqueName(deriveCommandName(command)), command })
      continue
    }
    // Current shape — both fields must be non-empty strings.
    if (entry && typeof entry === "object") {
      const { name, command } = entry as Partial<CustomCommand>
      if (typeof command !== "string" || !command.trim()) continue
      // A user-supplied name goes through the same sanitizer as a derived one;
      // if nothing usable survives (e.g. "!!!"), fall back to deriving.
      const cleaned = typeof name === "string" ? sanitizeName(name.trim()) : ""
      out.push({
        name: uniqueName(cleaned || deriveCommandName(command)),
        command,
      })
    }
  }
  return out
}
