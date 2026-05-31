# Browser CLI 优化技术方案

> Status: Draft · Scope: `bin/cock-browser.mjs` + `chrome-extension/automation.js` + `src/lib/httpApi.ts`(`/api/browser/*`)
> Audience: 实施工程师 / Code reviewer
> 写作约束：所有进入代码 / help / 错误模板 / 注释的 example **必须使用通用 web app 场景**（见 §7）。

---

## 0. 背景

### 0.1 角色定位

`cockpit browser` CLI 是 **AI 操控浏览器跑 E2E 测试的工具**——不是被测对象，也不是给人类点的 GUI 自动化。AI 通过 bash 调用 CLI，每一次调用 ≈ 一个 E2E 步骤。AI 的反馈渠道只有 stdout/stderr + 自己的对话历史；它看不到屏幕，凭推理决定下一步。

```
[AI]
  ↓ bash 调用（每次一条 cockpit browser 命令）
[cock-browser.mjs CLI]      bin/cock-browser.mjs    (~615 行)
  ↓ HTTP POST /api/browser/<action>
[Cockpit server HTTP API]    src/lib/httpApi.ts:511-598
  ↓ WS 转发 + pendingRequest
[Chrome extension handlers]  chrome-extension/automation.js  (~685 行，28 个 handler)
  ↓ DOM / network
[被测应用]                    任意 web app
```

### 0.2 现状

- **28 个 action**（navigate/url/title/snapshot/screenshot/click/type/fill/hover/focus/scroll/key/dispatch/wait/evaluate/evaluate_chunk/console/network/network_record/network_detail/computed/bounds/attrs/events/theme/cookies/storage/assert/perf）
- **优点**：
  - `cock-browser.mjs:42-126` 已有 React/SPA gotchas + 3 个 evaluate 模板（contenteditable / 受控 input / 文本-or-aria-label 点击）
  - `cock-browser.mjs:379-428` 已实现 `type` 后验证：CDP 报"成功"但目标 input 实际未接受时，给出可执行的 evaluate 修复模板
  - `cock-browser.mjs:444-461` evaluate 返回 undefined 时给出 3 类常见原因 hint
  - 大结果自动 chunking（>6KiB 透明拉回）
- **缺点**：以上"沉默失败 → 可执行报错"的范式 **只在 `type` 和 `evaluate undefined` 两处实现**，其他高频沉默失败场景（ref 失效、Enter 提交、click no-op、timeout、page 卡死）全都裸报。

### 0.3 触发动机

两次真实 AI 会话分析揭示的高频摩擦：

| 会话 | 场景 | browser 调用次数 | 主要踩坑 |
|---|---|---|---|
| S1 | 自选股管理 E2E（添加/删除股票，验证后端 watchlist 状态） | 11+ | snapshot ref 失效、emoji 文本被折叠 grep 不到、`KeyboardEvent.Enter` no-op、`evaluate(fetch)` 重复 4 次 |
| S2 | agent middleware E2E（驱动 LLM 调工具，等中间件日志） | ~15 | LLM 流式期间 evaluate 全 15s timeout、无法区分 extension 死/page 卡/WS 阻塞、AI 手写 `until evaluate "1+1"` 轮询 2.5 分钟、最终放弃 browser 路径改写服务层脚本 |

47 个问题归并到 11 类（详见 §3），其中 22 个高严重。本方案对这 22 个高严重问题实现 1:1 P0 覆盖。

---

## 1. 目标与非目标

### 1.1 目标

1. **每个 E2E 任务的 bash round-trip 数下降 ≥40%**。S1 的 11+ 次基线压到 ≤6 次。
2. **沉默失败必报**：操作"返回成功但实际没生效"的所有已知场景，CLI 层后验证 + 给可执行模板。
3. **错误带 next step**：所有 stderr / 错误返回，至少包含一条可立即跑的修复命令。
4. **action 数控制 ≤33**：新能力优先做成现有 action 的 flag，避免 help 噪音。

### 1.2 非目标

| 非目标 | 理由 |
|---|---|
| ❌ E2E 框架 / mini DSL / yaml schema | E2E 逻辑应由 AI 的 prompt 表达；CLI 只提供原子操作。引入 schema 反成枷锁。 |
| ❌ visual screenshot diff | 实现复杂、误报多、token 贵；DOM/属性比对可替代。 |
| ❌ login 原子 action | 每个 app 登录页 selector 不同，参数化反不如 AI 组合。 |
| ❌ drag / upload / 多 tab 协调 | 暂无高频会话证据，等真实场景出现再做。 |
| ❌ structured errorCode 协议升级 | Phase 1 的错误模板已能解决 80% 问题；errorCode 是长期项。 |
| ❌ CLI 自身的回归测试套件 | CLI 是工具不是被测物，与本方案目标错位。 |

### 1.3 设计原则（红线）

1. **服务于 AI 跑 E2E**，不为人类 GUI 操作优化（人类有真 GUI 可用）。
2. **不增 action 数（28 → ≤33）**，新能力优先做成 flag。
3. **沉默失败必报，错误必带可执行模板**——复用 `cock-browser.mjs:379-428` 的范式。
4. **ref 化操作全部加 selector 备选路径，不删 ref**——向后兼容。
5. **每个用户可见文本中的 example，必须用通用 web app 场景**（§7 example 池）。

---

## 2. 整体路线图

| 阶段 | 范围 | 周期估算 | 完成后预期 |
|---|---|---|---|
| **Phase 1** | 9 项基线修复 + 高频闭环 | 1-2 周 | S1 的 11 次调用压到 ≤6 次；S2 的 page 卡死 timeout 类问题有 1s 诊断手段 |
| **Phase 2** | 6 项 Wait + Assert 原子化 | 1 周 | 大部分 E2E 步骤从 2-3 命令压到 1 命令 |
| **Phase 3** | 4 项 Arrange / Cleanup / 调试体验 | 1 周（可灵活） | 长会话 / 多测试场景的状态隔离体验 |

Phase 之间是**累积**关系，Phase 1 是最低可发布单元（MVP）；Phase 2 在 Phase 1 基础上叠加 wait/assert 闭环；Phase 3 是体验优化，可按真实反馈调整顺序甚至砍项。

---

## 3. 问题清单与优化项映射

### 3.1 11 类共 47 条问题（横切汇总）

| 类 | 数量 | 高 / 中 / 低 | 涉及优化项 |
|---|---|---|---|
| A. 沉默失败 | 7 | 2/3/2 | F1.1 F1.7 |
| B. 错误信息可执行性 | 6 | 2/2/2 | F1.2 |
| C. snapshot 信息质量 | 5 | 3/1/1 | F1.1 F1.3 F1.4 |
| D. 缺 selector 交互路径 | 4 | 3/1/0 | F1.5 F2.3 F2.6 |
| E. Wait 原语不足 | 5 | 2/2/1 | F2.1 F2.2 F2.7 F3.3 |
| F. Assert 闭合度 | 5 | 3/1/1 | F2.3 F2.4 F2.5 |
| G. Backend 探查 | 3 | 1/2/0 | F1.6 F2.5 |
| H. Arrange / Cleanup | 4 | 0/4/0 | F3.1 F3.4 |
| I. 多 tab / 服务定位 | 3 | 0/1/2 | 跨域 / YAGNI |
| J. 系统健康可见性 | 3 | 1/2/0 | F1.8 F3.2 |
| K. 流式页面长任务 | 4 | 2/1/1 | F1.8 F2.7 |
| L. 策略指引 / help 内容 | 3 | 1/2/0 | F1.9 |
| M. 跨工具组合 | 2 | 0/2/0 | 留观察 |
| N. 命名一致性 | 3 | 0/0/3 | 文档说明 |
| O. token 效率 | 3 | 0/2/1 | F1.4 |

> 完整 47 条逐项清单见**附录 A**。

### 3.2 优化项 → 问题项映射

| 优化项 ID | 名称 | Phase | 解决的问题编号 |
|---|---|---|---|
| F1.1 | snapshot ref 加 epoch `eN#vM` | P1 | A1 C3 |
| F1.2 | 错误带 evaluate 修复模板（含 timeout） | P1 | B1 B2 B3 |
| F1.3 | snapshot 输出 banner | P1 | C1（部分） |
| F1.4 | snapshot `--filter` / `--include-hidden-text` | P1 | C1 C2 C5 O1 |
| F1.5 | `click-text` / `click-selector` / `fill-selector` | P1 | D1 D2 D3 |
| F1.6 | `fetch` shortcut | P1 | G1 |
| F1.7 | click / key 后验证 | P1 | A2 A3 |
| F1.8 | `health` / `ping` action | P1 | J1 K1（诊断侧） |
| F1.9 | help 加 "When NOT to use" 段 | P1 | L1 |
| F2.1 | `wait --network-idle` | P2 | E1 |
| F2.2 | `wait --selector` | P2 | E2 |
| F2.3 | `assert --selector` | P2 | F1 F2 |
| F2.4 | `assert --network` | P2 | F3 |
| F2.5 | `assert --fetch --jsonpath` | P2 | F4 G2 |
| F2.6 | `submit [--form-selector]` | P2 | D4 |
| F2.7 | `wait --extension-ready` | P2 | E4 K1 K4 |
| F3.1 | `reset [--cookies --storage --cache --reload]` | P3 | H2 H4 |
| F3.2 | `status` 一站式 summary | P3 | J3 |
| F3.3 | `wait --dom-stable` | P3 | E3 |
| F3.4 | `set-cookie` / `set-storage` | P3 | H3 |

---

## 4. Phase 1 详细规格

### F1.1 — snapshot ref 加 epoch

**问题** A1 / C3：snapshot 之间 ref 全失效，AI 无版本号区分。

**设计**

- `automation.js` 顶部维护 `snapshotEpoch: number`，每次 `handlers.snapshot` 调用前 `+1`、`clearRefs()`。
- `assignRef` 时把 epoch 嵌进 ref 字符串：`e<counter>#v<epoch>` → 示例 `e7#v3`。
- `findByRef(ref)` 解析 epoch，若 `<` 当前 epoch → 抛专属错误（带模板，见 F1.2）；若 `==` 但 element disconnected → 抛 "disconnected" 错误。
- CLI 解析 positional arg 时不需要变动（透明传递）。

**接口契约**

```
ref 格式：  e<num>#v<epoch>     必带 epoch
旧格式 eN  仍接受（视为 "any epoch"），但 stderr 一次性 deprecation 警告。
```

**涉及文件 + 行号**

| 文件 | 位置 | 改动 |
|---|---|---|
| `chrome-extension/automation.js` | L20-22（refCounter / refToElement / elementToRef） | 加 `snapshotEpoch` |
| `chrome-extension/automation.js` | L24-36（clearRefs / assignRef） | epoch 嵌入 |
| `chrome-extension/automation.js` | L38-44（findByRef） | epoch 解析 + 区分两类错误 |
| `chrome-extension/automation.js` | L286（handlers.snapshot） | 调用前 +1 epoch |

**伪代码**

```js
let snapshotEpoch = 0;

function clearRefs() {
  refCounter = 0;
  refToElement.clear();
  elementToRef.clear();
  snapshotEpoch += 1;       // 每次 snapshot 推进
}

function assignRef(el) {
  if (elementToRef.has(el)) return elementToRef.get(el);
  refCounter += 1;
  const ref = `e${refCounter}#v${snapshotEpoch}`;
  refToElement.set(ref, el);
  elementToRef.set(el, ref);
  return ref;
}

function findByRef(ref) {
  const m = ref.match(/^e(\d+)(?:#v(\d+))?$/);
  if (!m) throw new Error(STALE_REF_MSG(ref, snapshotEpoch, 'malformed'));
  const refEpoch = m[2] ? Number(m[2]) : null;
  if (refEpoch !== null && refEpoch !== snapshotEpoch) {
    throw new Error(STALE_REF_MSG(ref, snapshotEpoch, 'old-epoch'));
  }
  const el = refToElement.get(ref) ?? refToElement.get(`e${m[1]}`); // 兼容旧
  if (!el || !el.isConnected) throw new Error(STALE_REF_MSG(ref, snapshotEpoch, 'disconnected'));
  return el;
}
```

**验收**

1. snapshot 后用旧 ref（不同 epoch）→ 错误明确指出版本不匹配，给修复模板。
2. 同一 snapshot 内 click(eN#vM) → 仍正常工作。
3. snapshot 第一行 banner 包含 `v=N`（F1.3 同步）。

---

### F1.2 — 错误带 evaluate 修复模板（含 timeout）

**问题** B1 / B2 / B3：findByRef、HTTP timeout、disconnect、404 全部裸字符串。

**设计**

集中维护错误模板常量，所有错误源（automation.js findByRef、httpApi.ts 4 处、CLI run() catch）从常量读。

**错误模板（用通用 example）**

```
STALE_REF_MSG(ref, currentEpoch, kind) =
  `Element ref "${ref}" is stale (current snapshot v=${currentEpoch}, ref kind: ${kind}).
  Refs are valid only until the next snapshot / re-render / route change.
  Fix one of:
    1. Re-run \`snapshot\` to get fresh refs.
    2. Use a CSS selector / visible text directly:
       cockpit browser <id> click-text "Submit"
       cockpit browser <id> click-selector 'button[type="submit"]'
    3. Drop to evaluate:
       cockpit browser <id> evaluate "(() => document.querySelector('button[aria-label=\\"Save\\"]').click())()"`

TIMEOUT_MSG(timeoutMs) =
  `Timeout: no response within ${timeoutMs}ms.
  Likely cause: page is busy (long render / streaming / network).
  Diagnose:
    cockpit browser <id> health                    # is extension alive?
    cockpit browser <id> wait --extension-ready    # wait until responsive
    cockpit browser <id> wait --network-idle       # wait for page to settle
  If health returns alive but evaluate still hangs, the page itself is blocked.
  Consider pivoting to a service-level test if the page is driven by an async LLM/agent flow.`

DISCONNECT_MSG(id) =
  `Browser "${id}" is disconnected (WS closed).
  Recover:
    1. Refresh the browser tab to re-register the extension.
    2. \`cockpit browser list\` to confirm the bubble's shortId.
    3. If the bubble is gone from the list, re-open it from the cockpit console panel.`

NOT_FOUND_MSG(id, suggestions) =
  `Browser "${id}" not found.
  Available: ${suggestions.join(', ')}
  Run: cockpit browser list`

UNKNOWN_ACTION_MSG(action, suggestions) =
  `Unknown action "${action}".
  Did you mean: ${suggestions.join(', ')}?
  Run: cockpit browser --help-all`
```

**涉及文件 + 行号**

| 文件 | 位置 | 改动 |
|---|---|---|
| `chrome-extension/automation.js` | L41（findByRef throw） | 用 STALE_REF_MSG |
| `src/lib/httpApi.ts` | L573（NOT_FOUND） | 用 NOT_FOUND_MSG + 列 list |
| `src/lib/httpApi.ts` | L577（DISCONNECT） | 用 DISCONNECT_MSG |
| `src/lib/httpApi.ts` | L520-523（regex match action） | 失败时 fuzzy 建议 + UNKNOWN_ACTION_MSG |
| `bin/cock-browser.mjs` | L432-441（CLI catch） | timeout 时输出 TIMEOUT_MSG |
| 新建：`bin/cock-browser.messages.mjs` | — | 集中维护所有模板常量（CLI 端）|
| 新建：`chrome-extension/messages.js` | — | 集中维护 extension 端模板 |

**验收**

每一类错误，AI 看到的 stderr 至少包含 1 条可直接 copy 跑的命令。

---

### F1.3 — snapshot 输出 banner

**问题** C1：snapshot a11y 树折叠 `<summary>` / 无 name 容器，AI 不知所以然。

**设计**

`buildA11yTree` 返回前在第 1 行加 banner，包含 epoch + 折叠说明 + 探索建议。

**Banner 模板**

```
# a11y tree v=3 — refs valid until next snapshot
# Text inside <details>/<summary> and unnamed container <div>/<section> is collapsed.
# Grep on role/aria-label, NOT on user-visible emoji/text.
# Tips:
#   --include-hidden-text   surface collapsed innerText (≤60 chars per node)
#   --filter <regex>        server-side grep, reduce output size
```

**涉及文件**

| 文件 | 位置 | 改动 |
|---|---|---|
| `chrome-extension/automation.js` | L189（return） | prepend banner |
| `chrome-extension/automation.js` | L286（handlers.snapshot） | 接受新 params 透传给 buildA11yTree |

**验收**

snapshot 输出第一行明确告知 epoch + 折叠规则；AI 第一次见就知道为什么 grep emoji 文本是空。

---

### F1.4 — snapshot `--filter` / `--include-hidden-text`

**问题** C1 / C2 / C5 / O1：snapshot 没 server-side filter，AI 必须 dump-Read-grep 三连。

**设计**

- 新增 params：`filter`（正则字符串）、`includeHiddenText`（bool）、`maxDepth`（int, 默认 12）。
- `buildA11yTree` 内：
  - `includeHiddenText`：对 `isContainer` / 无 name 节点，附加 `el.innerText.slice(0, 60)`。
  - `filter`：构建完整 lines 后，保留命中正则的行 + 其前后 2 行上下文（默认）。
- CLI 端在 `parseFlags` 后透传 params。

**接口**

```bash
cockpit browser <id> snapshot --filter '<regex>'
cockpit browser <id> snapshot --include-hidden-text
cockpit browser <id> snapshot --filter '<regex>' --include-hidden-text --max-depth 8
```

**Help 段（用通用 example）**

```
snapshot [--filter <regex>] [--include-hidden-text] [--max-depth N]
   Get a11y tree (refs like e5#v3). Banner explains format.
   e.g. snapshot --filter 'role=button.*Submit'
   e.g. snapshot --include-hidden-text --filter 'Welcome|Sign'
```

**涉及文件**

| 文件 | 位置 | 改动 |
|---|---|---|
| `chrome-extension/automation.js` | L140-189（buildA11yTree） | 加 includeHiddenText 分支 + post-filter |
| `chrome-extension/automation.js` | L286 | handlers.snapshot 接收新 params |
| `bin/cock-browser.mjs` | L188+ | parseFlags 透传 filter/includeHiddenText/maxDepth |

**验收**

`snapshot --filter 'Search'` 返回行数 < 完整 snapshot；`--include-hidden-text` 后能 grep 到 `<summary>` 里的文本。

---

### F1.5 — `click-text` / `click-selector` / `fill-selector`

**问题** D1 / D2 / D3：所有交互必经 ref，selector 化路径不存在。

**设计**

3 个新 action，全在 extension 端实现，CLI 端只做 flag 解析。

```js
// chrome-extension/automation.js
'click-text': async ({ text, exact = false, nth = 0 }) => {
  const all = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"]'));
  const match = all.filter(el => {
    const t = (el.textContent || '').trim();
    const aria = el.getAttribute('aria-label') || '';
    if (exact) return t === text || aria === text;
    return t.includes(text) || aria.includes(text);
  });
  if (!match.length) throw new Error(`No clickable element with text "${text}"`);
  if (nth >= match.length) throw new Error(`Only ${match.length} matches for "${text}", nth=${nth} out of range`);
  match[nth].scrollIntoView({ block: 'nearest' });
  match[nth].click();
  return { clicked: text, nth, totalMatches: match.length };
},

'click-selector': async ({ selector, nth = 0 }) => {
  const els = document.querySelectorAll(selector);
  if (!els.length) throw new Error(`No element matching "${selector}"`);
  if (nth >= els.length) throw new Error(`Only ${els.length} matches for "${selector}", nth=${nth} out of range`);
  els[nth].scrollIntoView({ block: 'nearest' });
  els[nth].click();
  return { clicked: selector, nth };
},

'fill-selector': async ({ selector, value, clear = true }) => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`No element matching "${selector}"`);
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
              || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { filled: selector, length: value.length };
},
```

**CLI 包装（通用 example help）**

```
Interaction by selector (preferred — refs go stale on re-render):

  click-text <substr>             Click button/link by visible text or aria-label
                                    e.g. click-text "Sign in"
                                    e.g. click-text "Next" --nth 1 --exact
  click-selector <css>            Click first element matching CSS
                                    e.g. click-selector 'button[type="submit"]'
  fill-selector <css> <value>     Fill via native setter (works on React-controlled inputs)
                                    e.g. fill-selector 'input[name="email"]' "user@example.com"
```

**涉及文件**

| 文件 | 位置 | 改动 |
|---|---|---|
| `chrome-extension/automation.js` | L329 后 | 加 3 个 handler |
| `bin/cock-browser.mjs` | L80-95（help） | 在 "Interaction" 段顶部插入 selector 段 |
| `bin/cock-browser.mjs` | L191-210（positional） | click-text/click-selector/fill-selector 加 positional 映射 |

**验收**

不调用 snapshot，直接 `click-text "Submit"` 能完成点击；AI 不再需要 `Array.from(querySelectorAll).find(...)` 模板。

---

### F1.6 — `fetch` shortcut

**问题** G1：每次裹 `evaluate "(async()=>{const r=await fetch(...); return ...})()"`。

**设计**

新增 `fetch` action，内部走 evaluate，但提供 method/body/json-extract 等 flag。

```js
// chrome-extension/automation.js
'fetch': async ({ url, method = 'GET', body = null, jsonpath = null }) => {
  const init = { method, credentials: 'same-origin' };
  if (body != null) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(url, init);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (jsonpath) {
    const result = extractJsonPath(data, jsonpath);
    return { status: r.status, jsonpath, value: result };
  }
  return { status: r.status, contentType: ct, data };
},
```

**JSONPath 库**：用轻量 `jsonpath-plus`（~20KB gzipped），或自己实现一个极简 `$.a.b[0].c` 子集（无 filter/wildcard 表达式）。

> ⚠️ **决策点**：jsonpath-plus 全功能 vs 极简自实现。建议先做极简（只支持 `$.x.y` / `$.x[0].y` / `$[*].x`），后续按需扩。

**接口 + Help（通用 example）**

```
fetch <url> [--method M] [--body B] [--json <jsonpath>]
   Fetch a URL using the page's auth session (inherits cookies, headers).
   e.g. fetch /api/users/me
   e.g. fetch /api/items --method POST --body '{"name":"hello"}'
   e.g. fetch /api/items --json '$[0].id'
   e.g. fetch /api/items --json '$[*].id'
```

**涉及文件**

| 文件 | 位置 | 改动 |
|---|---|---|
| `chrome-extension/automation.js` | L461 后 | 加 fetch handler + 极简 jsonpath |
| `bin/cock-browser.mjs` | L191-210 | positional: fetch <url> |
| `bin/cock-browser.mjs` | L100-105（Network 段 help） | 加 fetch 子段 |

**验收**

`fetch /api/users/me --json $.name` 直接返回 `value: "John"`，无需 evaluate。

---

### F1.7 — click / key 后验证

**问题** A2 / A3：click 命中 no-op / key Enter 在 React 上不触发，仍返"成功"。

**设计**

复用 `cock-browser.mjs:379-428` 的 `type` 后验证范式。在 CLI 端：

```js
// bin/cock-browser.mjs run() 内，action === 'click' 或 'key'
if ((action === 'click' || action === 'key' || action === 'click-text' || action === 'click-selector') && !params.skipVerify) {
  const before = await snapshot300msState();   // url + dom-hash + last-network-id
  await sleep(200);
  const after = await snapshot300msState();
  if (deepEqual(before, after)) {
    process.stderr.write(CLICK_NO_OP_WARN(action, params));
    // 不退出，仍输出 data；用户自己看 warn
  }
}
```

`snapshot300msState` 通过一次轻量 evaluate 抓 `{url, domHash, lastNetworkRequestId}`。

**Warn 模板（通用 example）**

```
⚠ ${action} succeeded per CDP but no DOM mutation / URL change / network request in 200ms.
  Likely a no-op (element has no real handler / portal-rendered / framework not listening).
  Try:
    cockpit browser <id> evaluate "(() => { const el = document.querySelector('button[aria-label=\"Save\"]'); el.click(); return el.outerHTML.slice(0,200); })()"
  Or trigger the underlying business path directly:
    cockpit browser <id> fetch /api/items --method POST --body '{}'
  Or use submit for form-Enter:
    cockpit browser <id> submit --form-selector 'form#login'
```

**边界条件**

- 误报风险：合法但无副作用的 click（如打开 popover，但 popover 通过 CSS 显示，不算 DOM mutation）。
- Mitigation：`--skip-verify` flag 让 AI/用户在已知合法 case 手动关掉。
- 性能：每次 click 额外 ~250ms。可接受（E2E 不追求极致 throughput）。

**涉及文件**

| 文件 | 位置 | 改动 |
|---|---|---|
| `bin/cock-browser.mjs` | L379 区域 | 在 type 后验证下方加 click/key 后验证分支 |
| `chrome-extension/automation.js` | 可选加 `_probe_state` 内部 handler | 用于轻量抓 url+domHash+lastReqId |

**验收**

`key Enter` 在不监听 onKeyDown 的 React 输入框上 → stderr 有 warn + submit 模板。

---

### F1.8 — `health` / `ping` action

**问题** J1 / K1：page 卡死时 evaluate 全 timeout，AI 无法区分"extension 死 / page 卡 / WS 阻塞"。

**设计**

一个**极轻量探针**，不经过 page main world、不跑用户 js。

```js
// chrome-extension/automation.js
'health': async () => ({
  extension: 'alive',
  ts: Date.now(),
  pendingCommands: globalPendingCommandCount,   // extension 自己维护
  wsConnectedSince: globalWsConnectedTimestamp,
  pageBusy: document.readyState !== 'complete' || performance.now() < 1000,
}),
```

**关键约束**：必须能**绕过当前 evaluate queue**。

Chrome extension 的 `chrome.runtime.onMessage` 是单一 channel，所有消息按序处理。`evaluate` 因为走 `chrome.scripting.executeScript` 跑到 page main world，是真正可能阻塞的；但 `health` 只在 extension content script 自己的上下文跑，**不进 page main world**——只要 extension content script 没死，health 必然秒回。这是它能区分"page 卡 vs extension 死"的关键。

> ⚠️ **实施前提**：需确认 `chrome.runtime.onMessage` 的处理是 concurrent 还是 serial。若 serial，health 仍会被前面的 evaluate 卡。届时需要 extension 端给 health 走 **独立 port**（`chrome.runtime.connect` 长连接）。

**接口**

```
$ cockpit browser <id> health
extension: alive   ws: open   round-trip: 23ms
pending-commands: 2   ws-connected-since: 12m ago
page: busy (readyState=loading)
```

**Help（通用）**

```
health                          Ultra-light extension ping (does not enter page world).
                                Use to distinguish "extension dead" vs "page busy" when
                                evaluate times out.
                                e.g. health
```

**涉及文件**

| 文件 | 位置 | 改动 |
|---|---|---|
| `chrome-extension/automation.js` | handler 末尾 | 加 health |
| `chrome-extension/background.js` | message routing | 确保 health 不串行排在 evaluate 后 |
| `bin/cock-browser.mjs` | L444+ formatOutput | 加 case 'health' |

**验收**

S2 场景重放：page 流式渲染期间 `evaluate "1+1"` 超时，但 `health` 在 100ms 内返回 `extension: alive, pending: 1`。

---

### F1.9 — help 加 "When NOT to use" 段

**问题** L1：AI 在不适合 browser CLI 的场景（agent-driven 多步 UI E2E）耗 5+ 分钟才 pivot。

**设计**

`printHelp` 末尾增加 "When NOT to use this CLI" 一节，明确指出不适配场景 + 替代方案。

**模板（通用）**

```
── When NOT to use this CLI ───────────────────────────
- Testing LLM-agent driven flows end-to-end: the agent's stochastic tool
  choice and stop_reason make UI assertions flaky. Prefer a thin runtime
  script that calls the same middleware / service directly with controlled
  inputs.

- Pages that stream / re-render for >10s: evaluate calls queue behind page
  work and time out (~15s default). Run \`wait --extension-ready\` between
  acts and asserts; if it stays hung, pivot to a service-level test.

- Multi-tab / popup OAuth flows: each browser bubble tracks one tab. Open
  the secondary tab in its own bubble or stub the OAuth handshake.
```

**涉及文件**

| 文件 | 位置 | 改动 |
|---|---|---|
| `bin/cock-browser.mjs` | L114 后（"Next step" 段前） | 插入新段 |

**验收**

文本检查：`cockpit browser --help` 输出末尾含 "When NOT to use"。

---

## 5. Phase 2 规格

Phase 1 完成后，进入 Wait + Assert 闭环。每项给接口契约 + 涉及文件，细节实现留实施期。

### F2.1 — `wait --network-idle`

```
wait --network-idle [--quiet-ms 500] [--timeout 30000]
   Wait until no in-flight HTTP request for <quiet-ms> consecutive ms.
   Excludes long-poll / SSE (Content-Type: text/event-stream).
   e.g. wait --network-idle --quiet-ms 800
```

**涉及**：`chrome-extension/automation.js` networkBuffer 已有，加 in-flight tracking。

### F2.2 — `wait --selector`

```
wait --selector <css> [--state visible|hidden|attached|detached] [--timeout 10000]
   e.g. wait --selector '[role="status"]' --state visible
```

**涉及**：`chrome-extension/automation.js` handlers.wait 加 selector 分支。

### F2.3 — `assert --selector`

```
assert --selector <css> [--text <substr>] [--visible <bool>] [--attr "k=v"]
   e.g. assert --selector '[role="status"]' --text "Saved"
   e.g. assert --selector 'button[type="submit"]' --visible true
```

**涉及**：`chrome-extension/automation.js` handlers.assert 加 selector 分支，复用现有 visible/text/checked 子断言。

### F2.4 — `assert --network`

```
assert --network --method <M> --url <U> --status <S> [--since <epoch>]
   Assert a matching request occurred in networkBuffer since <epoch> (default: 5s ago).
   e.g. assert --network --method POST --url /api/items --status 200
```

**涉及**：`chrome-extension/automation.js` 复用 networkBuffer 过滤。

### F2.5 — `assert --fetch --jsonpath`

```
assert --fetch <url> [--method] [--body] [--status N] [--jsonpath P --equals V] [--jsonpath P --contains V]
   Make a fetch and assert response.
   e.g. assert --fetch /api/items --jsonpath '$.count' --equals 5
   e.g. assert --fetch /api/items --jsonpath '$[*].id' --contains 42
```

**涉及**：F1.6 fetch + 简易 equals/contains 比对逻辑。

### F2.6 — `submit [--form-selector]`

```
submit [--form-selector <css>]
   Call form.requestSubmit() — works on React-controlled forms where key Enter is ignored.
   e.g. submit                              # nearest form of activeElement
   e.g. submit --form-selector 'form#login'
```

**涉及**：`chrome-extension/automation.js` 新 handler。

### F2.7 — `wait --extension-ready`

```
wait --extension-ready [--quiet-ms 500] [--timeout 60000]
   Poll health until <quiet-ms> consecutive ms of fast responses.
   Replaces manual \`until evaluate "1+1"\` loops.
   e.g. wait --extension-ready --timeout 120000
```

**涉及**：CLI 端循环调用 F1.8 health。

---

## 6. Phase 3 规格

### F3.1 — `reset`

```
reset [--cookies] [--storage] [--cache] [--reload]
   Atomic test-isolation helper.
   e.g. reset --cookies --storage --reload
```

### F3.2 — `status` 一站式

```
status                          Compact summary for "where am I".
   Output: url, title, last-console-error, last-failed-request, top-visible-actions.
```

### F3.3 — `wait --dom-stable`

```
wait --dom-stable [--quiet-ms 300]
   Wait until <quiet-ms> with no MutationObserver events.
```

### F3.4 — `set-cookie` / `set-storage`

```
set-cookie --name K --value V [--domain D] [--path P] [--http-only] [--secure]
set-storage --type local|session --key K --value V
```

---

## 7. 实施纪律

### 7.1 通用 example 池（**所有 help / 错误模板 / 注释的唯一来源**）

| 场景 | selector / 值 | 文案 |
|---|---|---|
| 登录 | `input[name="email"]` · `input[type="password"]` · `button[type="submit"]` | "Sign in" |
| 搜索 | `input[role="searchbox"]` · `input[placeholder="Search"]` | "Search" |
| 表单 | `input[name="firstName"]` · `textarea[name="message"]` · `select[name="country"]` | "Save" / "Submit" / "Cancel" |
| 按钮 | `button[aria-label="Save"]` · `button[type="submit"]` | "Submit" / "Confirm" / "Next" / "Delete" |
| 富文本 | `[contenteditable="true"]` | "hello world" |
| API 路径 | `/api/items` · `/api/items/123` · `/api/users/me` | — |
| 数据 | id=42, status=200, count=5, name="John" | — |
| 状态区域 | `[role="status"]` · `[role="alert"]` | "Saved" / "Error" |

### 7.2 实施前置任务

**实施 Phase 1 第一步**：建 `bin/cock-browser.examples.mjs`（或 `messages.mjs` 内嵌常量），集中维护所有 example + 错误模板。所有 help/error 都从这里 import，单点维护、未来不漂移。

### 7.3 PR Review Checklist

每个 PR 必须通过：

1. `grep -E '自选股|600000|平安|kztn|wjrd|watchlist|nebula|fuifau|TWITTER|imgur|Composio' <PR diff>` 命中即打回。
2. 新增 user-facing 文本必须从 §7.1 example 池取值。
3. 错误信息必须带至少 1 条可执行修复命令。
4. 沉默失败类改动必须附带 dogfood 验证（手工或自动）。

### 7.4 命名约定

- 新 action 单词间用 `-`：`click-text`、`click-selector`、`fill-selector`（与现有 `network_record` 下划线不一致是历史包袱，新加项统一连字符）。
- Flag 全用 kebab-case：`--include-hidden-text`、`--quiet-ms`。
- 内部 params 转 camelCase 由 CLI 端做（已有先例）。

---

## 8. 验证与验收

### 8.1 Phase 1 验收

**量化目标**：

| 指标 | 基线（S1） | Phase 1 目标 |
|---|---|---|
| browser CLI 调用次数 | 11+ | ≤6 |
| stale ref 类错误恢复轮数 | 1-2 | 0 |
| Enter no-op 类错误恢复轮数 | 1-2 | 0 |
| backend 状态探查的命令数 | 1 evaluate + 复杂模板 | 1 fetch |

**Dogfood 流程**：

1. 找 ≥3 个历史会话（含 S1、S2、再加 1 个新的）。
2. 用新 CLI 重写同一任务（不让 AI 看历史，只给原始 task prompt）。
3. 统计：bash 调用次数、错误恢复轮数、stdout token 数。
4. 任一指标未改善的 feature → 砍掉或返工。

### 8.2 Phase 2 验收

- "act + assert" 组合从 2-3 命令压到 1 命令的占比 ≥70%。
- `wait --network-idle` 后 assert 假阳性数 = 0（基于 ≥10 个真实会话）。

### 8.3 Phase 3 验收

- 长会话（>1 小时）中"测试间状态污染"案例数减半。
- 灵活：根据反馈调整顺序或砍项。

---

## 9. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| F1.1 ref epoch 破坏外部脚本 | 中 | 兼容旧 `eN` 格式 + stderr deprecation 警告 1 个版本 |
| F1.7 click 后验证误报（合法但无副作用的 click） | 中 | `--skip-verify` flag opt-out；只 warn 不 fail |
| F1.8 health 仍被 evaluate queue 卡 | 高 | 若 onMessage 是 serial，回退方案：用 `chrome.runtime.connect` 独立 port |
| F1.4 `--filter` 在大 a11y 树性能差 | 低 | 服务端编译一次正则；输出超 5000 行截断并提示 |
| Phase 2 jsonpath 库选型有学习成本 | 低 | 极简自实现先，无外部依赖 |
| Phase 1 完成后 help 长度增长 | 中 | Phase 2 加 `--help-all` 分级 |

### 回退方案

每个 P0 item 独立 PR + feature flag 控制（如 `COCKPIT_BROWSER_REF_EPOCH=1`），若某项出问题可单独关掉。

---

## 10. 待定问题（⚠️ 待补充）

1. **F1.8 health 是否真能旁路 evaluate queue**：需要在 chrome extension 实测 `chrome.runtime.onMessage` 处理顺序。若 serial，需要走 long-lived port。优先级：Phase 1 开工前确认。
2. **F1.7 click no-op 检测的误报阈值**：合法但无副作用的 click 占比未知，需要灰度。建议先 warn 不 fail，观察 1-2 周。
3. **F2.5 jsonpath 选型**：极简自实现 vs jsonpath-plus。极简先行，遇到 wildcard / filter 需求再升级。
4. **F1.1 ref epoch 格式**：`eN#vM` vs `eN@vM` vs `vM/eN`，需 AI 友好（不易和 CSS selector 混）。当前提案 `e7#v3`。
5. **M1/M2 跨工具组合**（terminal + browser 等服务端 log 后做断言）：暂留观察，看是否高频。
6. **A4/A5 navigate-intercepted、fill-SELECT-bad-value**潜在沉默失败：暂未真踩，是否做要等真实会话出现。
7. **跨域问题 I2**（bubble 不显示连的是哪个本地 dev 进程）：属 console plugin / cockpit UI 范畴，不在 browser CLI；建议另起 issue。

---

## 附录 A：47 条问题完整清单

### A 类：沉默失败

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| A1 | snapshot ref 跨命令失效无版本 | 高 | F1.1 |
| A2 | key Enter 在 React 上 no-op | 高 | F1.7 |
| A3 | click 命中 no-op 元素仍报 success | 中 | F1.7 |
| A4 | navigate SPA 拦截后 URL 未变 | 中 | 待观察 |
| A5 | fill SELECT 错值无 warn | 低 | 待观察 |
| A6 | type 写入失败 → ✅ 已实现后验证 | — | — |
| A7 | evaluate undefined → ✅ 已实现 hint | — | — |

### B 类：错误可执行性

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| B1 | findByRef 裸错误 | 高 | F1.2 |
| B2 | Timeout 裸错误 | 高 | F1.2 |
| B3 | Browser disconnected 裸错误 | 中 | F1.2 |
| B4 | 404 unknown action 无 fuzzy | 中 | F1.2 |
| B5 | flag 拼错退化为 ref undefined | 中 | F1.2 |
| B6 | evaluate js 报错 → 已透传 | — | — |

### C 类：snapshot 信息质量

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| C1 | 容器/summary 内文本被折叠 | 高 | F1.3 F1.4 |
| C2 | 无 server-side filter | 中 | F1.4 |
| C3 | 无 epoch 版本号 | 高 | F1.1 |
| C4 | 无 snapshot diff | 低 | P3 / YAGNI |
| C5 | 大页面 100+ 行高 token | 中 | F1.4 |

### D 类：缺 selector 路径

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| D1 | 11 个交互 action 全 ref-only | 高 | F1.5 F2.3 |
| D2 | 无 click-text | 高 | F1.5 |
| D3 | 无 fill-selector | 高 | F1.5 |
| D4 | 无 submit | 中 | F2.6 |

### E 类：Wait 不足

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| E1 | 无 wait --network-idle | 高 | F2.1 |
| E2 | 无 wait --selector | 中 | F2.2 |
| E3 | 无 wait --dom-stable | 中 | F3.3 |
| E4 | 无 wait --extension-ready | 高 | F2.7 |
| E5 | wait --text 在大页面易假阳 | 低 | 待观察 |

### F 类：Assert 闭合

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| F1 | assert 只 ref，stale 时挂 | 高 | F2.3 |
| F2 | 无 assert --selector | 高 | F2.3 |
| F3 | 无 assert --network | 中 | F2.4 |
| F4 | 无 assert --fetch + jsonpath | 高 | F2.5 |
| F5 | 无复合"act + auto-wait + assert" 原子 | 中 | YAGNI |

### G 类：Backend 探查

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| G1 | 无 fetch shortcut | 高 | F1.6 |
| G2 | 无 jsonpath 提取 | 中 | F2.5 |
| G3 | 跨源对比手工 | 中 | 跨域 |

### H 类：Arrange / Cleanup

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| H1 | 无 login 原子 | 中 | 拒做 |
| H2 | 无 reset | 中 | F3.1 |
| H3 | storage 只读 | 中 | F3.4 |
| H4 | 测试间状态污染 | 中 | F3.1 |

### I 类：多 tab / 服务定位

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| I1 | 一 bubble 一 tab，OAuth popup 看不到 | 低 | YAGNI |
| I2 | bubble 不显示连的 dev 进程 | 中 | 跨域 |
| I3 | list 输出 → 已 OK | — | — |

### J 类：系统健康

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| J1 | 无 health 区分 extension/page | 高 | F1.8 |
| J2 | timeout 不显示 pending 队列 | 中 | F1.8（输出含）|
| J3 | 无 status 一站式 | 中 | F3.2 |

### K 类：流式 / 长任务

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| K1 | page 流式期间 evaluate 全挂 | 高 | F1.8 + F2.7 |
| K2 | 无 priority channel | 中 | F1.8 实现前置 |
| K3 | 无 background evaluate | 低 | P3 |
| K4 | AI 不知该等多久 | 中 | F2.7 |

### L 类：策略指引 / help

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| L1 | help 没说"何时不该用" | 高 | F1.9 |
| L2 | help 长度堆积 | 中 | P2 `--help-all` |
| L3 | help 没分级 | 中 | P2 |

### M 类：跨工具

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| M1 | "click + 等服务 log + assert" 须手工编排 | 中 | 待观察 |
| M2 | 无"等任意 cockpit 信号"统一原语 | 中 | 待观察 |

### N 类：命名一致性

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| N1 | network_record 下划线 | 低 | 不动（兼容）|
| N2 | --all-frames → allFrames 自动转 | 低 | 文档说明 |
| N3 | ref `eN` 与 Playwright 不同 | 低 | 不改 |

### O 类：token 效率

| ID | 问题 | 严重 | 路线图 |
|---|---|---|---|
| O1 | snapshot 大页面高 token | 中 | F1.4 |
| O2 | screenshot base64 vision token | 中 | 不可改 |
| O3 | evaluate 大 JSON 美化吃 token | 低 | P3 opt-in `--compact` |

---

## 附录 B：现有 action 与改动影响表

| Action | 改动 | Phase |
|---|---|---|
| snapshot | + epoch banner + filter + include-hidden-text | F1.1 F1.3 F1.4 |
| click | 后验证 + skip-verify flag | F1.7 |
| key | 后验证 | F1.7 |
| assert | + selector / network / fetch 三个新分支 | F2.3 F2.4 F2.5 |
| wait | + network-idle / selector / extension-ready / dom-stable | F2.1 F2.2 F2.7 F3.3 |
| 其他（type/fill/hover/focus/scroll/dispatch/console/network/...） | 无 | — |

新增 action：
- F1.5 `click-text` / `click-selector` / `fill-selector`（3 个）
- F1.6 `fetch`（1 个）
- F1.8 `health`（1 个）
- F2.6 `submit`（1 个）
- F3.1 `reset`（1 个）
- F3.2 `status`（1 个）
- F3.4 `set-cookie` / `set-storage`（2 个）

合计 28 → 38。**超出 §1.1 目标（≤33）2 个**——需在实施期讨论：把 `click-text` / `click-selector` 合并为 `click --by-text` / `--by-selector` flag，或把 `set-cookie` / `set-storage` 合并为 `set --type cookie|local|session`。

---

## 附录 C：参考实现范本

`cock-browser.mjs:379-428` 的 `type` 后验证是本方案"沉默失败 → 可执行错误"范式的范本。所有新加的后验证（F1.7）、错误模板（F1.2）、health diagnostic（F1.8 + F1.9）均应参照其结构：

1. 操作执行（透传 extension 返回）
2. 立即采样副作用（DOM/URL/network/value）
3. 与预期对比，不符 → stderr 写**带至少 1 条可执行命令的 warn**
4. 主输出（stdout）保持不变，AI 可同时看到结果和警告

这是本方案最重要的不变量。
