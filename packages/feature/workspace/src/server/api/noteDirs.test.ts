import { describe, expect, it } from 'vitest'
import { matchNoteDir, resolveEncodedPath, type ListDir } from './noteDirs'

/** A fake filesystem: absolute dir → child dir names. */
const fsTree = (tree: Record<string, string[]>): ListDir => async (dir) => tree[dir] ?? []

describe('resolveEncodedPath', () => {
  const listDir = fsTree({
    '/': ['Users'],
    '/Users': ['ka'],
    '/Users/ka': ['Work'],
    '/Users/ka/Work': ['ommol-lab', 'ommol'],
    '/Users/ka/Work/ommol-lab': ['open-connector'],
    '/Users/ka/Work/ommol': ['other'],
  })

  it('rebuilds a path whose names contain hyphens', async () => {
    expect(await resolveEncodedPath('-Users-ka-Work-ommol-lab-open-connector', listDir))
      .toBe('/Users/ka/Work/ommol-lab/open-connector')
  })

  it('backtracks when the first matching prefix is a dead end', async () => {
    // `ommol` is listed and matches the prefix, but only `ommol-lab` leads on.
    const reordered = fsTree({
      '/': ['Users'], '/Users': ['ka'], '/Users/ka': ['Work'],
      '/Users/ka/Work': ['ommol', 'ommol-lab'],
      '/Users/ka/Work/ommol': ['other'],
      '/Users/ka/Work/ommol-lab': ['open-connector'],
    })
    expect(await resolveEncodedPath('-Users-ka-Work-ommol-lab-open-connector', reordered))
      .toBe('/Users/ka/Work/ommol-lab/open-connector')
  })

  it('returns undefined when nothing on disk matches', async () => {
    expect(await resolveEncodedPath('-Users-ka-Work-gone', listDir)).toBeUndefined()
  })
})

describe('matchNoteDir', () => {
  const empty = fsTree({})

  it('prefers a known path', async () => {
    expect(await matchNoteDir('-Users-ka-Work-glasser', ['/Users/ka/Work/glasser'], empty))
      .toEqual({ cwd: '/Users/ka/Work/glasser', exact: true })
  })

  it('falls back to a naive decode that still maps to the same directory', async () => {
    const m = await matchNoteDir('-Users-ka-Work-continic-CORTEX', [], empty)
    expect(m).toEqual({ cwd: '/Users/ka/Work/continic/CORTEX', exact: false })
  })
})
