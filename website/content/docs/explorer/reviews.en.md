**Tech Plan Review** turns a Markdown file in your Cockpit project into a LAN-shared discussion page: anyone on your network opens the URL, reads it in their browser, and leaves line-anchored comments — no login, no install. Designed for **plan-level review** (does the approach make sense?), not line-by-line code review.

| Section | What's in it |
|---|---|
| [Create & Share](#create-share) | Toggle a doc into a Review, get its LAN URL, manage Reviews |
| [Threads](#threads) | Line-anchored comments, replies, resolving |
| [Identity & Anonymity](#identity-anonymity) | Nicknames, MAC-scoped identity, what "private" means here |

## Create & Share

**Tech Plan Review** lets you put a technical proposal — a design doc, an RFC, a half-baked idea — in front of teammates on your LAN for them to read and comment on, without anyone installing anything. They open a URL in their browser, that's it.

### Create one

Open the Markdown file you want to share in Cockpit (a design doc, an RFC, anything in `.md`). In the file's toolbar there's a **Share Review** toggle — flip it on.

Cockpit:

1. Creates a Review entry from the file's contents.
2. Generates a LAN URL.
3. **Copies the URL to your clipboard automatically.**

The URL looks like `http://192.168.1.42:4457/review/rv-a1b2c3d4e5f6` — your LAN IP, a port that's the Cockpit port + 1000, and a Review ID derived from the file path. Paste it into Slack / your chat / a sticky note.

### What gets shared

The Review captures the Markdown file's contents at the moment you **flip the Share Review toggle on**. **Later edits to the file in Cockpit don't auto-sync to the Review** — to push a new version, flip the toggle off and on again, and Cockpit rebuilds the Review from the current file contents (the Review ID stays the same, so the old URL keeps working).

The Review's title in the Reviews list is the **filename** (last path segment), not the first line of the file.

### Who can access

Anyone on your LAN with the URL. No login. The first time someone opens the URL they're prompted to enter a nickname so the people commenting are distinguishable (see [Identity](#identity-anonymity)).

If your machine isn't reachable from the LAN (you're tethered, behind a hostile firewall, on a coffee-shop Wi-Fi), the URL won't work for anyone else. The feature assumes the same kind of LAN where you'd share `localhost:3000` with a colleague.

### Stop sharing

Flip the **Share Review** toggle off in the file's toolbar. The URL stops responding immediately. You can re-share the same file later — Cockpit remembers the Review ID, so people who had the old URL will see the new version when you re-enable.

### Manage your Reviews

There's a Reviews panel that lists every Review you've created. From there:

- Open the URL for an existing Review.
- Close (un-share) a Review.
- Delete it permanently.
- Drag to reorder.

### What it isn't

Tech Plan Review is for **plan and design discussion**, not code review. The line-anchored comments point into your Markdown text, not into a git diff. For code-level review of an actual change, use your existing PR workflow on GitHub/GitLab — Cockpit doesn't replace that.

## Threads

Inside a Tech Plan Review, anyone with the URL can attach a comment to any piece of text in the document. Comments thread — others can reply, you can keep going. This is the discussion engine of the feature.

### How to comment

In a Review, select any chunk of text with your mouse. A small popup appears asking what you want to say. Type your comment, hit submit.

The selection can be:

- A few words inside a sentence.
- A whole paragraph.
- Multiple lines crossing paragraphs.
- A single line of a code block in the Markdown.

Comments anchor by **character position** (`startOffset` / `endOffset`) in the text, not by line, so a comment on "the last paragraph of section 3" stays anchored to those exact words even if you insert content above.

> Multiple overlapping comments on the same text are allowed — Cockpit doesn't block them. You can stack several discussions on the same paragraph.

### Replies

Every comment has a **Reply** button. Replies thread under the original. Replies are plain text just like top-level comments.

There's no nested threading beyond one level — replies always go to the top-level comment, not to other replies.

### Resolving / closing

Comment threads have a **Close** button. Closed threads stay visible but collapsed; click to expand them, and use the **Reopen** button to restore an open thread.

> Closing isn't restricted to the comment author — anyone who can interact with a comment can close it. If someone closes prematurely, hit Reopen.

There's no concept of "resolved by code change" because Reviews don't track code at all.

### What you can write

Comments are **plain text only** — no Markdown, no code blocks, no images. If you need to share code, paste it inline (it'll show as a single block of text without highlighting), or refer to it by location in the doc.

This is a deliberate choice: keeping the comments lightweight prevents Reviews from drifting into "design doc that also contains its own discussion thread that contains its own embedded code review" maze.

### Real-time-ish updates

Cockpit polls the Review every 10 seconds for new comments and replies. So when your colleague posts a thought, you'll see it within 10 seconds without refreshing. This isn't a real-time WebSocket — fast collaboration may feel slightly laggy, but it's reliable across any network.

### Who can do what

> Roles are decided by **incoming IP**: requests from `localhost` / `127.0.0.1` are treated as admin (that's the machine running Cockpit); every other IP is a visitor. There's no "doc-author" login or auth — it's purely IP-based.

| Role | Can do |
|---|---|
| **Admin** (on the host machine, via localhost) | Edit the Markdown source file, add comments, reply, delete any comment, delete the Review. |
| **Visitor** (any other IP on the LAN) | Read the doc, add comments, reply. Can close (and reopen) any comment thread, not just their own. Cannot delete other people's comments or edit the Markdown source. |

## Identity & Anonymity

Tech Plan Review has no login screen — anyone on your LAN with the URL can read and comment. To still tell participants apart, Cockpit identifies each visitor by their **device's MAC address on the LAN**, plus a self-chosen nickname.

This page covers what that means in practice for who sees what under whose name.

### First time entering a Review

When a visitor opens a Review URL for the first time, Cockpit pops up a **Nickname** dialog. It's pre-filled with a randomly-generated friendly name in **AdjectiveNoun form** (e.g. `HappyPanda`, `BraveDolphin`, `QuietCrane`). They can either keep it, edit it to their real name, or click **Random** for another roll.

The chosen nickname sticks for that device — every Review they open from the same device shows the same name, no need to re-enter.

### How devices are identified

Cockpit reads the visitor's IP from the incoming request, then runs `arp -n` / `arp -a` (depending on the OS) on your local network to map that IP to a MAC address. The MAC is hashed with SHA-256 over the string `cockpit:<MAC>` and the first 16 chars become a stable but anonymous **author ID**.

The nickname is stored against that author ID. Two consequences:

- **Same device, same identity.** A teammate's laptop will be recognised across sessions, across days, across different Reviews you create.
- **Different device, different identity.** The same person on their phone shows up as a separate participant. They can pick the same nickname both places, but their author IDs underneath are different.

This is **anonymous-but-stable**, not authenticated. You're not proving who someone is, you're just consistently calling them the same thing.

### Display

Each comment shows:

- The commenter's nickname.
- A small avatar — a circle with the first letter of the nickname.

> Note: avatars currently share **a single brand colour** in the UI — they're not coloured per identity. Distinguishing participants relies on the nickname and the first letter, not on colour.

### Changing your nickname

There's a small profile icon in the Review header. Click it to open the **Identity** dialog. You can edit your nickname there at any time.

When you change it:

- Your *future* comments show the new name.
- Your *past* comments also display the new name — names render from the current map, not what was saved at comment time.

### Limits

- The MAC-via-ARP identification works on the same broadcast LAN. If you put a Review behind a reverse proxy or VPN where every visitor looks like the same IP from Cockpit's perspective, identification breaks down — everyone gets bucketed together. That's not the intended use case.
- There's no way to ban or block a specific participant other than stopping the share entirely.
- Cockpit doesn't show IP addresses or MAC addresses in the UI to other participants — only nicknames and avatars.
