Cockpit gives you four overlapping ways to find code, ordered roughly by speed-of-typing:

| Section | When to reach for it |
|---|---|
| [Quick File Open](#quick-file-open) | You know the file name. `Cmd+P`, type, enter. |
| [LSP](#lsp) | You know the symbol — go to its definition, find references. |
| [Code Map](#code-map) | You want a visual of who calls what, around a given function. |
| [CodeGraph](#codegraph) | You want the AI (or yourself) to query the whole call graph — `/cg` mode. |

## Quick File Open

When you know roughly the name of the file you want — but not exactly where it lives — hit **`Cmd+P`**. A search bar appears at the top of Cockpit; start typing and matching files appear instantly, ordered by relevance and recency.

This works from any panel. You don't have to be in Explorer first.

### How matching works

Type any part of the file's path or name — letters don't have to be consecutive, but order matters. Cockpit scores each result by:

- **Consecutive-letter matches** count more than scattered ones.
- **Matches at the start of the filename** or right after a `/` rank higher than mid-word matches.
- **Recently opened files** float to the top when scores are close.
- **Exact-case matches** edge out wrong-case ones.

So:

| You type | Likely top result |
|---|---|
| `useauth` | `src/hooks/useAuth.ts` |
| `botlist` | `app/components/BotList.tsx` |
| `set/index` | `src/settings/index.ts` |

### What's searched

The file list is produced by **ripgrep**, which **honours your project's `.gitignore`** — so `node_modules/`, build output, and the like are filtered out automatically. Cockpit adds one extra pass on top: `.env*` files stay in the list even if gitignored (handy when you're hunting for your local config).

### Keyboard

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection |
| `Enter` | Open the highlighted file |
| `Esc` | Close without opening |

### Limits

- No `:line:col` jump syntax — `Cmd+P` only opens the file. To jump to a specific line, open the file first, then use Vi `:42` or the in-file search (`Cmd+F`).
- No content search — `Cmd+P` is filename-only. For full-text search across the project, use the **Search** tab in the Explorer panel.


## LSP

When you open a TypeScript, JavaScript, or Python file in Cockpit's Code Viewer, the language server features quietly come along — hover for types, `Cmd+click` to jump to a definition. You don't have to configure anything: Cockpit ships and manages the language servers itself.

### Supported languages

| Language | Files | Status |
|---|---|---|
| **TypeScript / JavaScript** | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | Full LSP support |
| **Python** | `.py`, `.pyi` | Full LSP support |

Go and Rust files don't get LSP, but they do get the [Code Map](/en/docs/explorer/search/#code-map) — call-graph based navigation that doesn't need a language server.

### What works

| Feature | How |
|---|---|
| **Type info** | Hover over a symbol — a tooltip shows the type signature and any docstring. |
| **Go to definition** | `Cmd+click` (or `Ctrl+click` on Linux/Windows) on a symbol → jumps to where it's defined. Works across files. |
| **Find references** | Hover the symbol → click **Find references** in the hover tooltip; returns every place the symbol is used. |
| **Rename** | Not implemented. |

### You don't install anything

Cockpit bundles the language servers itself and starts them on demand:

- **TypeScript** — first hover or click triggers `tsserver` startup (about 2–3 seconds the first time, instant after that).
- **Python** — first hover or click triggers Pyright (about 1–2 seconds the first time).

A small registry inside Cockpit caps the number of running servers (5) and shuts down idle ones after 5 minutes, so you don't accumulate stale processes.

### Common issues

- **"Go to definition" lands in the wrong place** — happens with dynamically-typed JavaScript or Python code where the language server can't reliably resolve. There's no fix from Cockpit's side; same behaviour you'd get in VS Code.
- **Nothing happens on first hover** — wait a second or two for the language server to spin up; subsequent hovers in the same project are instant.
- **No support for my language** — for Go, Rust, and other languages, use [Code Map](/en/docs/explorer/search/#code-map) instead. It works without an LSP.

### Where LSP works

| Surface | LSP active |
|---|---|
| Code Viewer | ✅ |
| Code Map (BlockViewer) | ✅ |
| Diff View | ✅ |
| Markdown preview | ❌ (text only) |


## Code Map

**Code Map** is Cockpit's function-level architecture view of a single file. Open a source file in Code Map mode and you see, for every top-level function in the file: its **callers** on the left, its **code** in the middle, its **callees** on the right — all on the same row, no scrolling between panels.

It's the answer to "I'm reading this function — what calls it, and what does it call?" without leaving the file you opened.

### Open Code Map

Open any source file in Explorer (the Code Viewer takes over the right pane). The viewer's top toolbar has a **view-toggle button**; switch it to Code Map. The file-tree right-click menu has no Code Map entry — you have to open the file first.

### What you see

For each top-level function (or class method, or exported symbol) Cockpit lays out three columns:

```
| Callers (upstream)  |  Function signature + code   | Callees (downstream) |
└─────────────────────┴──────────────────────────────┴──────────────────────┘
```

The "pins" on either side are clickable:

| Pin colour | What it means |
|---|---|
| **Blue** | Calls or callers in a different file — clicking jumps to that function |
| **Brown** | Calls within the same file |
| **Grey** | External npm/pip dependency — visible but not clickable |

Click any blue pin and Cockpit navigates to that function — and Code Map redraws around it. A back/forward history lets you retrace.

### What it works on

Code Map uses tree-sitter to parse source files, which means it works without any language server:

- **TypeScript / JavaScript** ✅
- **Python** ✅
- **Go** ✅
- **Rust** ✅

So if you write Go or Rust — where Cockpit doesn't have full LSP yet — Code Map is the main way to navigate the call graph.

### Code Map vs LSP

|  | LSP | Code Map |
|---|---|---|
| Needs a language server | Yes | No (tree-sitter) |
| Languages | TS / JS / Python | TS / JS / Python / Go / Rust |
| First-use latency | 2–3s (server startup) | 50–200ms (index from cache) |
| Cross-file | Limited | Full project |
| Hover types / docs | ✅ | ❌ |

In practice you use both — LSP for "what's the type of this variable", Code Map for "where does this function fit in the codebase".

### Searching from Code Map

Inside Code Map, `Cmd+K` opens a small search that lets you jump to another file or function in the current project without leaving Code Map mode.


## CodeGraph

**CodeGraph** is the same project-wide index that powers [Code Map](/en/docs/explorer/search/#code-map), but exposed for the AI to query in [`/cg`](/en/docs/agent/skills/) mode. You don't interact with CodeGraph directly — you ask the AI questions about your code, and behind the scenes it walks the graph instead of brute-grepping every file.

### What kinds of questions

The AI in `/cg` mode can answer questions like:

- "Where is `Parser` defined?" — symbol search across the project.
- "Who calls `Parser.parse()`?" — upstream callers.
- "What does `parse()` call?" — downstream callees.
- "If I change `debounce()`, what breaks?" — impact analysis (BFS over the call graph).
- "What's in `src/parser.ts`?" — file overview.
- "What files are usually changed together with `parser.ts`?" — co-edit history from your git log.

The AI picks the right query for the question and returns a focused answer with file paths and line numbers, instead of dumping a wall of grep output.

### Why this is faster

For "where is X called?" type questions, grep-based exploration:

1. Reads every source file in the project.
2. Filters by string matches.
3. The AI then has to guess which matches are real call sites vs string mentions.

CodeGraph builds the answer once at index time (it actually parses the call graph), then any query returns in tens of milliseconds. The AI's reply comes back faster, and it stays focused on real call sites instead of getting confused by comments and string literals.

### Languages supported

CodeGraph parses with tree-sitter, same as Code Map:

- TypeScript / JavaScript
- Python
- Go
- Rust

### Build time and freshness

The index builds the first time something queries it — usually under a second for a typical project, a few seconds for a very large one (around 8000-file ceiling). It then updates incrementally as you edit files: changing one file re-parses just that file, not the whole project.

You don't trigger the build manually. The first `/cg` query on a new project pays the indexing cost; everything after that is instant.

### Co-edit history

The "files changed together" query (`/api/projectGraph/coedit`) reads your `git log` for the past ~100 commits, skipping mass refactors that touched many files. So when the AI tells you "if you change `parser.ts`, you'll probably also need to look at `lexer.ts`", that's based on your team's actual history of touching those files together.

### Direct viewing for users

CodeGraph itself is AI-only — the data structures aren't browsable in the UI. For your own exploration of the same information, use:

- [Code Map](/en/docs/explorer/search/#code-map) — visual call graph one function at a time.
- [LSP](/en/docs/explorer/search/#lsp) — hover and go-to-definition in the Code Viewer.

