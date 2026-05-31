A Jupyter bubble opens a `.ipynb` notebook inside Cockpit, lets you edit cells, run them, and see outputs — including images and rich HTML — without firing up Jupyter Lab in a separate window. **Cockpit ships its own kernel manager**: you don't run `jupyter lab` separately — the bubble spawns a Python bridge process behind the scenes to execute your cells.

Open one by typing any path that ends in `.ipynb` (case-sensitive — the suffix has to be lowercase):

```text
analysis.ipynb
~/notebooks/explore.ipynb
./reports/2026-Q1.ipynb
```

Relative paths resolve against the current Cockpit project's working directory.

## What you see

The notebook renders top-to-bottom as a list of cells:

- **Code cells** — editable source area + an output area underneath. Run them and the output (text, images, HTML, error tracebacks) appears below. **Python only** — syntax highlighting is Python-specific too.
- **Markdown cells** — rendered as Markdown.
- **Raw cells** — shown verbatim.

Each code cell has an execution number next to it (`[1]`); a running cell shows `[*]`.

## Per-cell actions

Double-click a cell to edit. Each cell's toolbar gives you:

- **▶ Run** — execute this cell. `Shift+Enter` also works.
- **Type switcher** — convert between code / markdown / raw.
- **↑ / ↓ move** — move the cell up or down.
- **✕ delete** — remove the cell.

## Bubble-level actions

Header buttons:

- **▶ Run All** — execute all code cells in order.
- **■ Stop** — interrupt the cell that's currently running. Doesn't kill the kernel, just stops the cell.
- **↻ Restart** — restart the kernel. Use when it's dead or you want a clean slate.
- **Cmd+S to save** — write the notebook back to disk (execution numbers, cell order, and outputs all preserved).
- **Kernel status badge** — `idle` / `busy` / `starting` / `error` / `dead` / `disconnected`. If the kernel dies, you'll see it here.

## Behind the scenes: how Cockpit runs the kernel

The bubble doesn't depend on `jupyter lab` — Cockpit **runs the kernel itself**. Concretely:

- The first time you run a cell, Cockpit `spawn`s a Python bridge process (`jupyter_bridge.py`) using your system `python3` (falls back to `python`).
- The bridge talks to an IPython kernel via `jupyter_client`, so you need `ipykernel` installed in your Python environment (which pulls `jupyter_client` along for the ride):

```bash
pip install ipykernel
```

- You do **not** need to manually run `jupyter lab` or `jupyter notebook`.
- Kernels **auto-shut down after 10 minutes of idle**; the next cell execution starts a fresh one.

If you want to use a project venv, just `source venv/bin/activate` before launching Cockpit — the `python3` Cockpit finds will be the venv's.

## What this is *not*

The Jupyter bubble is a **lightweight notebook viewer-and-runner**, not a full Jupyter Lab replacement. **You get**:

- Cell editing, execution, add / delete / move, type switching
- Output rendering (text, images, HTML)
- Run All / Stop / Restart / Save

**You don't get**:

- Multiple kernel types (Python only)
- Variable inspector / debugger panel
- Drag-and-drop reorder (use the ↑ / ↓ buttons instead)
- Jupyter extensions / themes

If you need those, run Jupyter Lab as you normally would. The bubble is for the common case: "open this notebook, run a few cells, see what comes out."

## Common issues

- **Kernel status "error" or "dead"** — usually a missing package in your Python environment (most often `ipykernel`). Run `pip install ipykernel` above.
- **No Python found** — neither `python3` nor `python` on your `PATH`. Install Python 3.
- **Cell stays `[*]` forever** — click **■ Stop** to interrupt; if that doesn't work, **↻ Restart**.
- **Code uses packages from a custom venv** — activate the venv before launching Cockpit so the Python it finds is the venv's.
- **Kernel disappears after closing the bubble** — by design: the kernel auto-shuts after 10 minutes idle. Re-opening the bubble and running a cell starts a fresh kernel.

## Next

- [Command Input](/en/docs/console/input-bar/) — what else triggers what
- [Terminal Bubble](/en/docs/console/terminal/) — run `python` interactively without a notebook
