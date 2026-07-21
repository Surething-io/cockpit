/**
 * Regression tests for resolveRelativeImages (app.jsx). The function is
 * extracted from the app source and executed, so the test exercises the REAL
 * shipped code rather than a copy.
 *
 * Contract: relative image references are rewritten to their /apps/local URL,
 * NOT to data: URLs — react-markdown's defaultUrlTransform drops any protocol
 * outside http/https/mailto/xmpp, so a data: image reaches the DOM with no src
 * at all (verified in a browser against both the `![](…)` and raw-<img> forms).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import vm from 'vm'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, 'app.jsx'), 'utf8')

// Pull the regexes + helpers + the function straight out of the app source.
const slice = src.slice(
  src.indexOf('const MD_IMAGE_RE'),
  src.indexOf('function MarkdownView')
)
const ctx = { Map, console, encodeURIComponent, decodeURIComponent }
vm.createContext(ctx)
vm.runInContext(slice + '\nglobalThis.__fn = resolveRelativeImages;', ctx)
const resolveRelativeImages = ctx.__fn

describe('resolveRelativeImages', () => {
  it('rewrites a relative reference to its /apps/local URL', () => {
    expect(resolveRelativeImages('![a](img.png)', '/d')).toBe(
      '![a](/apps/local/d/img.png)'
    )
  })

  it('does not corrupt a path that contains another path as a substring', () => {
    const out = resolveRelativeImages('![a](img.png) ![b](sub/img.png)', '/d')
    expect(out).toBe('![a](/apps/local/d/img.png) ![b](/apps/local/d/sub/img.png)')
    expect(out).not.toContain('sub/apps/local') // the old split/join bug
  })

  it('leaves prose that merely mentions the filename alone', () => {
    const out = resolveRelativeImages('see img.png below\n\n![a](img.png)', '/d')
    expect(out.startsWith('see img.png below')).toBe(true)
  })

  it('leaves remote, data: and absolute references untouched', () => {
    const md =
      '![r](https://x/y.png) ![d](data:image/png;base64,AAA) ![abs](/tmp/a.png)'
    expect(resolveRelativeImages(md, '/d')).toBe(md)
  })

  it('handles the raw html <img> form', () => {
    const out = resolveRelativeImages('<img src="logo.png" alt="x">', '/d')
    expect(out).toContain('src="/apps/local/d/logo.png"')
  })

  it('strips a leading ./ before resolving', () => {
    expect(resolveRelativeImages('![a](./x.png)', '/d/sub')).toBe(
      '![a](/apps/local/d/sub/x.png)'
    )
  })

  it('percent-encodes each segment so spaces and unicode survive', () => {
    expect(resolveRelativeImages('![a](my%20pic.png)', '/d')).toContain(
      '/apps/local/d/my%20pic.png'
    )
    expect(resolveRelativeImages('![a](图.png)', '/d')).toContain(
      '/apps/local/d/' + encodeURIComponent('图.png')
    )
  })

  it('is a no-op when there are no relative images', () => {
    expect(resolveRelativeImages('# just text', '/d')).toBe('# just text')
  })
})
