/**
 * /ap slash command — "apply" mode prompt.
 *
 * Split out for symmetry with qaPrompt / cgPrompt / exPrompt / goPrompt / fxPrompt
 * so every builtin command lives in its own file and slashCommands.ts is a thin
 * index.
 *
 * Positioning vs siblings:
 *   /qa  — lightweight requirement clarification, ASKS the user back
 *   /go  — landing mode (writes code, self-verifies per stage)
 *   /ap  — apply mode: implement <SPEC> while keeping a running apply-notes.html
 *          (in the temp dir) of out-of-spec decisions, changes, and tradeoffs
 */

export const AP_PROMPT_ZH = `---
name: ap
description: "apply：实现 <SPEC>，并在实现过程中持续维护一份 apply-notes HTML 文件（放在临时目录），记录规格未覆盖的决策、改动与权衡。"
argument-hint: "[SPEC 路径 / 留空 = 本次对话中已达成一致的 spec]"
---

实现 <SPEC>；在实现过程中，持续维护一个 apply-notes.html 文件，记录那些
规格里没有、但你不得不做的决策，不得不改的东西，不得不做的权衡，以及任何
我应该知道的事情。它不是工作日志——测试通过、构建变绿这类常规进展不该写进去。

文件放在 \`\${TMPDIR%/}/apply-notes-<feature-name>.html\`，绝不放进仓库里，
每个需求一个文件：当某一轮是在延续同一个任务时，在已有文件里新起一个 round
小节追加，而不是新建一个；只有新需求才新建文件。始终用 Edit 工具更新它
（仅首次创建时用 Write），绝不通过 shell 重定向写入。`;

export const AP_PROMPT_EN = `---
name: ap
description: "apply: implement <SPEC> while keeping a running apply-notes HTML file (in temp dir) of decisions not covered by the spec, changes, and tradeoffs."
argument-hint: "[SPEC path / empty = spec agreed in this conversation]"
---

Implement <SPEC>; and while you do, keep a running apply-notes.html file
with decisions you had to make that weren't in the spec, things you had
to change, tradeoffs you had to make, or anything else I should know.
It is not a work log — routine progress like tests passing or builds
going green doesn't belong in it.

Keep the file at \`\${TMPDIR%/}/apply-notes-<feature-name>.html\`, never
inside the repo, one file per requirement: when a round continues the
same task, append to the existing file under a new round heading rather
than starting a fresh one; only a new requirement gets a new file.
Always update it with the Edit tool (Write only when first creating it),
never through shell redirection.`;
