The **Recent** tab is Explorer's "what was I just looking at?" view. Files are sorted by last access time, newest at the top.

## What counts as "accessed"

Anything you actually open in Cockpit:

- Click a file in the Tree tab.
- Land on a file via `Cmd+P` (quick file open).
- Follow a `Cmd+click` jump-to-definition into a new file.
- Open a file from the commit-detail panel or diff viewer inside the Git **History** tab.

Files you only *see* in a directory listing don't count — they have to be opened.

## More than just the path — cursor and scroll position too

Every time you scroll or move the cursor inside a file, Cockpit records that file's:

- **current scroll line**
- **cursor line**
- **cursor column**

into its entry in Recent. Click the file in Recent later and Cockpit restores the same scroll position and cursor location — no need to re-find your place.

## Cap and eviction

Each project keeps the **15 most recent** files. When you open the 16th, the oldest drops off the bottom. Recent is project-scoped — files from project A don't show up in project B's Recent.

The list persists on disk, so it survives Cockpit restarts.

## What it doesn't do

Worth saying out loud:

- **No "Clear recent" button.** Recent is a rolling access log; once you hit 15, the old ones evict themselves.
- **No per-entry delete.**
- **No "pin to top" / favourites.** If you want a file always within reach, just keep its directory expanded in the Tree tab.

## How it relates to the other tabs

|  | What it does |
|---|---|
| **Tree** | Browse every file in the project — the full structure. |
| **Search** | Find by name or content; whichever file you pick automatically lands in Recent. |
| **Recent** | The subset you've already opened, with cursor positions remembered. |
