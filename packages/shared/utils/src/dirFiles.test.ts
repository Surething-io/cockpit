import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listDirFiles, readFileWithin } from './dirFiles'

let root: string
let skill: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dir-files-'))
  skill = join(root, 'my-skill')
  mkdirSync(join(skill, 'reference'), { recursive: true })
  mkdirSync(join(skill, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '# skill')
  writeFileSync(join(skill, 'reference', 'a.md'), 'ref a')
  writeFileSync(join(skill, '.hidden'), 'secret')
  writeFileSync(join(skill, 'node_modules', 'x', 'i.js'), 'dep')
  writeFileSync(join(skill, 'blob.bin'), Buffer.from([1, 0, 2]))
  writeFileSync(join(root, 'outside.txt'), 'outside')
  symlinkSync(join(root, 'outside.txt'), join(skill, 'escape.txt'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('listDirFiles', () => {
  it('lists regular files, skipping dot entries, dependency dirs and symlinks', async () => {
    const { files } = await listDirFiles(skill)
    expect(files.map((f) => f.path)).toEqual(['blob.bin', 'reference/a.md', 'SKILL.md'])
  })
})

describe('readFileWithin', () => {
  it('reads a text file inside the skill', async () => {
    expect(await readFileWithin(skill, 'reference/a.md')).toMatchObject({ kind: 'text', content: 'ref a' })
  })

  it('refuses paths that leave the skill directory', async () => {
    expect(await readFileWithin(skill, '../outside.txt')).toEqual({ kind: 'outside' })
    expect(await readFileWithin(skill, join(root, 'outside.txt'))).toEqual({ kind: 'outside' })
  })

  it('refuses a symlink that points out of the skill directory', async () => {
    expect(await readFileWithin(skill, 'escape.txt')).toEqual({ kind: 'outside' })
  })

  it('reports binaries without serving them', async () => {
    expect(await readFileWithin(skill, 'blob.bin')).toMatchObject({ kind: 'binary' })
  })
})
