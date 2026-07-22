/**
 * /cr slash command — full code-review (static + dynamic) methodology prompt.
 *
 * Verbatim snapshot of the user's `cr` skill — INCLUDING its YAML frontmatter.
 * Each export is a complete SKILL.md, matching the cgPrompt / exPrompt / goPrompt shape, so
 * dispatch can write it to disk verbatim. Hardcoded here — rather than read at
 * runtime — because builtin commands ship in the npm package and must work on
 * machines that don't have that user-specific path. If the source skill changes,
 * re-snapshot this file by hand.
 *
 * Like the other builtins, dispatch writes this to
 * ~/.cockpit/skills/cr/SKILL.md and hands the model a "请读取这个 skill 文件"
 * pointer. That on-disk copy also satisfies the methodology's own instruction
 * for subagents to "读本 skill (cr/SKILL.md)".
 *
 * Positioning vs siblings:
 *   /qa  — lightweight requirement clarification, ASKS the user back
 *   /fx  — bug evidence-chain analysis (analysis only)
 *   /ex  — heavy structured discussion (analysis only, no asking back)
 *   /go  — landing mode (writes code, self-verifies per stage)
 *   /cg  — CodeGraph exploration
 *   /cc  — Cockpit CLI operation (drive bubbles / codegraph via the CLI)
 *   /cr  — full code review (static triangulation + dynamic modelling)
 */

export const CR_PROMPT_ZH = `---
name: cr
description: "完整代码审查:静态 + 动态一遍做完。静态三角校验(拿改动和 意图 / 输入域 / 周遭 三个参照交叉定位)广扫全部改动;碰状态 / 时序 / 并发的切片再走动态推演管线(状态图 + 时间线 → 6 类动态风险)。自包含。"
---

# cr — 完整代码审查

一次做完一个 PR 的完整审查:**静态广扫 + 动态深挖**。本 skill **自包含**两套方法。

多数 PR 的审查是静态的——读快照就能判对错,**容易但不该漏**。难的、逐行抓不住的是**从静态代码推演出动态行为**:时序 / 状态演化 / 并发。cr 两路都做。

## 执行模式(开跑前先选)

**铁律:实际审查一律在【干净 subagent】里跑,主会话只做派发 + 机械合并,绝不亲自 review。** 刚在主会话写完代码、带着"我知道为什么这么做"的辩护性上下文,是最差的 reviewer。subagent 经 Agent 工具 spawn 时**不继承主会话历史**,只看 diff + 本 skill → 这正是 fresh-eyes 的来源。开发会话的残留历史**不得污染** triage / 建模 / 降级判断。

两条副作用红线:① 主会话**不替 subagent 做实质判断**;② 静态拆出去还顺带消掉"静态广度摊薄动态建模"的主稀释。

按规模三档(**都至少进一个干净 subagent**):
- **单 subagent**:无动态面 / 极小 → 1 个干净 subagent 跑 Part A。主会话只转交 diff + 收报告。
- **默认(2 subagent)**:有动态面 → 1 静态 + 1 动态,**两个都干净、并行**,各自在干净 diff 上自行 triage(静态扫全部改动 / 动态用切片原型清单列全切片)。
- **hard(1 + N subagent)**:高风险 / 大型 → 先 1 个干净 triage subagent 出切片清单,据此 fan out 1 静态 + 每切片 1 个 subagent。最深、最慢。

subagent prompt 模板:\`读本 skill (cr/SKILL.md),只对 <你那块(Part A 全部 / 某个动态切片)> 应用对应 Part,自行 triage,按统一格式输出 findings\`。

**Synthesis(主会话,只整理不重判)**:汇总各 subagent 的 findings → 去重(同根因标"共犯")→ 影响 × 概率排序 → 一份报告 + 梯度图。**禁止用主会话的开发上下文给任何 finding 洗白 / 降级**——subagent 怎么判就怎么收。要质疑某条,**重新 spawn 一个干净 subagent 复核**,而不是主会话自己拍。

> 取舍:默认 2-subagent 既隔离开发污染、又消掉静态摊薄动态;hard 的 per-slice fan-out 是额外深度(实测把 image/video 挖到 🔴 + 多 subagent 独立收敛提置信度),贵且慢,只在高风险上。

## Step 1 — 分诊(triage;两种模式都先做这步)
读 diff,切两面(可重叠):
- **静态面** = 全部改动 → 走 **Part A**。
- **动态面** = 碰 **状态 / 时序 / 并发 / 跨进程时序** 的切片 → 额外走 **Part B**。

切分原则:**A 判 as-written**(写没写对)、**B 判 over-time**(会不会被时序击穿);同一处两面都查。无动态面 → 跳过 Part B。

---

## Part A — 静态三角校验:拿改动和三个参照交叉定位

correctness 这个"未知点",靠 **意图 / 输入域 / 周遭** 三个独立参照三角定位——任何一个单独都会漏(只看意图漏边界、只看输入漏意图、只看周遭漏两者),三点合围才钉死。

只挑**工具判不了的语义层**问题(风格 / 格式 / 未用变量 / 类型不匹配交给 linter & type-checker)。静态 bug 几乎都是**快照与某个参照物对不上**:

### A1. vs 意图(做到声称的事了吗)
- name / 签名 / 类型 / PR 描述 / 注释**承诺**的,和代码**实际做的**一致吗?(\`isValid\` 出错却返回 true;PR 说改 X 实际动了 Y)
- 错误 / 边界分支返回的是**对的**东西吗,还是顺手返回了 happy-path 的值?
- 注释 / 文档和新代码同步了吗,还是还在描述旧行为?

### A2. vs 输入域(覆盖输入全集了吗)— 头号 bug 源
- 全集都处理了吗:null / undefined / 空 / 单元素 / 重复 / 边界值 / 溢出 / 负数 / unicode / 超长?
- **错误路径**和 happy path 一样正确吗?早返回 / 异常路径上,资源关了吗、状态一致吗?
- 外部输入(用户文本、参数、反序列化、webhook)当**不可信**处理了吗?(注入、越权、未校验、secrets 入 log)
- 典型病:happy path 对、输入域没覆盖全。

### A3. vs 周遭(和已有契约 / 约定一致吗)
- **契约漂移**:改了签名 / 类型 / 枚举 / 返回结构,**所有 consumer** 都跟着改了吗?(grep 可见,lint 不报)
- **约定背离**:该用项目既定模式 / helper 却用了裸原语 / 重新发明?
- **分层 / 边界**:绕过了该走的层、引入了不该有的依赖方向?
- **类型即事实源**:还是被 \`any\` / 断言 / 强转绕过?
- **安全对齐**:siblings 都有的检查(鉴权、租户隔离),这里漏了吗?

### 收尾(轻;工具能兜的别重做)
- 重复逻辑——尤其重复的**决策 / 策略**——该收敛成单一来源?死代码、过度复杂?
- **局部**性能:N+1、循环内 IO、明显劣化的算法、无界增长?(随状态演化的交 Part B)
- 测试:新增逻辑的**边界 / 错误路径**有断言吗?红测修前 fail、修后 pass?

---

## Part B — 动态:把静态代码推演成模型再审(仅动态面切片)

读快照看不出时序 bug——它活在「跑起来随时间怎么变」里。把它推演成动态模型再审,而不是逐行扫。

**逐切片建模(硬规则)**:建模前先列出**所有**独立动态切片,逐个打勾跑 B1–B3——**别只对最显眼的那个建模就收工,漏建一个切片 = 它里面的动态风险全漏**。为防清单遗漏,按这几类**切片原型**扫一遍:
- **共享状态的 init + 多写**(累加器 / key / 缓存:谁先建、谁多写)
- **跨进程 / 重入复用的状态**(重试 / 恢复 / 多 worker / 队列)
- **check-then-act 跨异步 gap**(预检 → 耗时操作 → 副作用晚落地;并发发起会集体越过预检 —— TOCTOU)
- **fire-and-forget 写 + 后续读**(写未落地就被读覆盖)
- **隐式上下文跨 hop**(ALS / log context 跨进程 / 跨队列后是否还在)

⚠ **一块代码可以同时是静态发现点 + 动态切片**——别因为它在 Part A 已被静态扫过(文案、重复、可选参数)就不再把它当动态切片建模。静态"认领"≠ 动态已覆盖。

### B1. 静态读入(输入)
读出:**有哪些状态** · **谁读谁写**(跨 feature、跨上游调用方,别停在本文件)· **契约 / 类型** · **控制流与入口**。

### B2. 建动态模型(主产物,写进报告当证据)
- **状态图** — 有哪些状态 + 迁移;每条迁移标注**谁在什么条件下改它**。
- **时间线** — 所有 writer/reader 上时间轴,标谁先谁后;**跨组件、跨进程拉通**,追到状态**真正诞生**的那一刻(不是它被本地重新引用的地方)。
- **变更轨迹** — 关键状态值沿时间线怎么流转:被谁建 / 改 / 读,有没有中途被覆盖 / no-op / 丢失。

这两张图就是证据——很多 bug(一条 6 秒的 gap、一个被先建出来的 key)只有画出来才现形。

### B3. 在模型上评估 6 类动态风险

| 风险 | 在模型上看什么 |
|---|---|
| **顺序竞态** | 有 writer 跑在 initializer 之前吗?"init 在本函数被 await" ≠ 它是该状态第一次被碰。追到跨 feature 的最早 writer。 |
| **重叠 / 漏算** | 多 writer 写同一累加器:同一笔事件被 >1 路记入(双算)?某类事件没人记(漏算)?别信注释的"这条只记 X"分工。 |
| **丢失更新** | fire-and-forget 写 + 随后的读:读到旧值并**覆盖**了本地正确值? |
| **fail-open 错值** | 降级路径放行的是*错值*还是*缺失*?对污染值返回自信错值 = 只安全了一半。**判 fail-open/fail-closed 要读守卫的实际比较式(\`x < 阈值\` vs \`x >= 阈值\`),别凭注释或直觉——\`NaN\`/\`Infinity\` 哨兵会让所有 \`x < 阈值 → 安全返回\` 式守卫落 false,放行与拦截两条会同时被击穿。** |
| **跨进程 / 重入** | 重试 / 恢复 / 多 worker 复用同一状态会串扰吗?隐式上下文(ALS / log context)跨进程 hop 后还在吗? |
| **provenance 断裂** | 关键值从源头到落点,中途被 no-op / 覆盖 / 类型擦除了吗?(看到 dedup / skip / 幂等守卫 → 问它防什么失败 → 去**没有它**的路径或旧版本查那个失败。) |

**升级档:把难判的顺序 / 算术,框成 satisfiability**(可选——只对 **顺序竞态** 和 **极端值 / 抵消** 两类、且非形式推理拿不准时用):
1. **自由变量** — 什么能变?顺序(writer 的 interleaving)、取值(关键数值变量 / 输入 / 计数)。
2. **只写真约束** — 哪些 happens-before 是真成立的(await / 锁 / 队列序)?哪些只是你**假设**的?+ 要守的不变量。
3. **∃ 反例?** — **SAT**(找到一个顺序/取值破坏不变量)= bug,反例即触发场景;**UNSAT** = 在此模型下证明安全(仅当模型忠实于代码)。

**三条纪律(决定 findings 质量)**
1. **普查没验证完 order + overlap 两种关系前,不算做完。** 列出 writer ≠ 普查完成。
2. **不准凭局部观察降级。** ordering / race 类 finding,降档前必须把时间线追到状态诞生点。SMT 话术:你是不是把一条并不存在的 happens-before 当成了约束?(「某步在本函数里被 await」≠ 它在全局上先于其它组件对同一状态的写。)没追到 → 标 \`需动态验证\`,保持原档,不降 ⚪。
3. **绿测 ≠ 验证。** 问:有没有**对抗序**测试(乱序 / 重试 / write-before-init)?bug 所在那层是不是被 mock 没了?有真实 trace 就拿时间线对账。

---

## 产出 findings(直观优先)

严重度 = **影响 × 概率**,直接给乘积结论,别让读者自己换算。两路 findings 合并去重,统一格式:

\`\`\`
🔴|🟡|⚪ <位置(file:line)> — 不修会发生什么(一句大白话后果,不带术语)
  影响: 坏到什么程度 + 坏给谁(具体:哪类用户 / 租户 / 调用方,而非泛指"用户")
  概率: 多大概率发生 + 取决于什么
  证据: 静态 → 三角校验里哪个参照对不上(意图 / 输入域 / 周遭);动态 → 模型证据(指回状态图 / 时间线哪一处)
  正解: 应该是什么 / 被破坏的不变量(术语放这里)
\`\`\`

- 🔴 高概率 × 大影响(卡发布) | 🟡 该修但不流血 | ⚪ 顺手。降序输出。
- 一句话结论说**后果**,不说技术原因(原因放 \`正解\`)。
- 概率取决于待验证因子就显式写,并写明如何升降档;别把"待验证"伪装成"已确认"。
- 多条同根因 → 标 **"共犯"** 合并成一条,别同一问题报两遍(尤其静态/动态对同一行各看一面时)。
- 收尾给一张 **影响 × 概率** 梯度图:

\`\`\`
影响 ↑
 大  │ 🔴 #1
 中  │            🟡 #2
 小  │ 🟡 #3                  ⚪ #4
     └─────────────────────────────→ 概率
        低         中         高
\`\`\`

## 别走过场
- **别漏升级**:Step 1 标了动态面,就必须真的对它跑 Part B(建模 + 6 类风险);只静态扫一遍就收工 = 漏。
- **不和工具抢活**(静态):风格 / 格式交给 linter & type-checker,cr 只挑语义层。
- **碰动态别硬推**:看到状态 / 时序 / 并发,要**建模**(Part B),别凭读代码下结论。
- **trivial 改动**:无动态面 → 跳过 Part B,只交一份静态报告。`;

export const CR_PROMPT_EN = `---
name: cr
description: "Full code review: static + dynamic in one pass. Static triangulation (cross-locate the change against three references — intent / input domain / surroundings) sweeps all changes; slices touching state / timing / concurrency additionally run the dynamic-derivation pipeline (state diagram + timeline → 6 classes of dynamic risk). Self-contained."
---

# cr — Full Code Review

Do a PR's complete review in one pass: **broad static sweep + deep dynamic dig**. This skill is **self-contained** in both methods.

Most PR review is static — read the snapshot and you can judge right/wrong, **easy but must not be skipped**. The hard part, the part you can't catch line-by-line, is **deriving dynamic behaviour from static code**: timing / state evolution / concurrency. cr does both tracks.

## Execution mode (choose before you start)

**Iron rule: the actual review always runs in a 【clean subagent】; the main session only dispatches + mechanically merges, NEVER reviews in person.** Having just written the code in the main session, carrying the defensive "I know why I did it this way" context, is the worst possible reviewer. When a subagent is spawned via the Agent tool it **does not inherit the main session's history** — it sees only the diff + this skill → that is exactly the source of fresh eyes. The dev session's residual history **must not pollute** triage / modelling / downgrade judgements.

Two side-effect red lines: ① the main session **does not make substantive judgements on the subagent's behalf**; ② splitting static out also removes the "static breadth dilutes dynamic modelling" dilution of the main thread.

Three tiers by scale (**all enter at least one clean subagent**):
- **Single subagent**: no dynamic surface / tiny → 1 clean subagent runs Part A. Main session just relays the diff + collects the report.
- **Default (2 subagents)**: has a dynamic surface → 1 static + 1 dynamic, **both clean, in parallel**, each triaging on the clean diff itself (static scans all changes / dynamic lists every slice via the slice-archetype checklist).
- **hard (1 + N subagents)**: high-risk / large → first 1 clean triage subagent produces the slice list, then fan out 1 static + 1 subagent per slice. Deepest, slowest.

Subagent prompt template: \`Read this skill (cr/SKILL.md); apply only the matching Part to <your chunk (all of Part A / one dynamic slice)>, triage it yourself, and output findings in the unified format\`.

**Synthesis (main session, organize only — never re-judge)**: gather each subagent's findings → dedup (mark same-root-cause as "accomplices") → sort by impact × probability → one report + gradient chart. **It is forbidden to use the main session's dev context to whitewash / downgrade any finding** — take what the subagent judged as-is. To dispute one, **spawn a fresh clean subagent to re-check**, not the main session deciding on its own.

> Trade-off: the default 2-subagent both isolates dev pollution and removes static-dilutes-dynamic; hard's per-slice fan-out is extra depth (in practice it dug image/video up to 🔴, and multiple independently-converging subagents raised confidence), expensive and slow, only for high risk.

## Step 1 — Triage (do this first in both modes)
Read the diff, cut two surfaces (may overlap):
- **Static surface** = all changes → go to **Part A**.
- **Dynamic surface** = slices touching **state / timing / concurrency / cross-process timing** → additionally go to **Part B**.

Splitting principle: **A judges as-written** (is it written correctly), **B judges over-time** (can timing break it through); check both surfaces on the same spot. No dynamic surface → skip Part B.

---

## Part A — Static triangulation: cross-locate the change against three references

correctness, that "unknown", is triangulated against three independent references — **intent / input domain / surroundings**. Any one alone misses something (intent-only misses boundaries, input-only misses intent, surroundings-only misses both); only the three together nail it down.

Pick only the **semantic-layer problems tools can't judge** (style / format / unused vars / type mismatch go to linter & type-checker). Static bugs are almost always **the snapshot failing to match some reference**:

### A1. vs intent (did it do what it claims)
- Do the name / signature / type / PR description / comment **promises** match what the code **actually does**? (\`isValid\` returns true on error; PR says it changes X but actually touched Y)
- Do error / boundary branches return the **right** thing, or did they carelessly return the happy-path value?
- Are comments / docs in sync with the new code, or still describing the old behaviour?

### A2. vs input domain (did it cover the full input set) — the #1 bug source
- Is the whole set handled: null / undefined / empty / single element / duplicate / boundary value / overflow / negative / unicode / over-length?
- Is the **error path** as correct as the happy path? On early returns / exception paths, are resources closed and state consistent?
- Is external input (user text, params, deserialization, webhook) treated as **untrusted**? (injection, privilege escalation, unvalidated, secrets into logs)
- Classic disease: happy path correct, input domain not fully covered.

### A3. vs surroundings (consistent with existing contracts / conventions)
- **Contract drift**: changed a signature / type / enum / return shape — did **all consumers** change with it? (grep-visible, lint won't flag)
- **Convention deviation**: should have used the project's established pattern / helper but used a raw primitive / reinvented it?
- **Layering / boundary**: bypassed a layer it should go through, introduced a forbidden dependency direction?
- **Type as source of truth**: or bypassed by \`any\` / assertions / casts?
- **Security alignment**: a check the siblings all have (authn, tenant isolation) — missing here?

### Wrap-up (light; don't redo what tools cover)
- Duplicated logic — especially duplicated **decisions / policies** — should converge to a single source? Dead code, over-complexity?
- **Local** performance: N+1, IO in a loop, an obviously degraded algorithm, unbounded growth? (state-evolving cases go to Part B)
- Tests: do the new logic's **boundary / error paths** have assertions? Does the red test fail before the fix and pass after?

---

## Part B — Dynamic: derive the static code into a model, then review (dynamic-surface slices only)

You can't see timing bugs in a snapshot — they live in "how things change over time once running". Derive it into a dynamic model and review that, instead of scanning line-by-line.

**Model per slice (hard rule)**: before modelling, list **all** independent dynamic slices and tick each through B1–B3 — **don't model just the most obvious one and call it done; missing one slice = all of that slice's dynamic risks are missed**. To avoid omissions, sweep these **slice archetypes**:
- **Shared-state init + multi-write** (accumulator / key / cache: who creates first, who writes many)
- **State reused across processes / re-entry** (retry / recovery / multi-worker / queue)
- **check-then-act across an async gap** (precheck → slow operation → side-effect lands late; concurrent starts collectively cross the precheck — TOCTOU)
- **fire-and-forget write + later read** (read overwrites before the write lands)
- **Implicit context across a hop** (ALS / log context: still there after crossing process / queue?)

⚠ **One piece of code can be both a static finding point and a dynamic slice** — don't stop modelling it as a dynamic slice just because Part A already scanned it statically (wording, duplication, optional params). Static "claiming" ≠ dynamic coverage.

### B1. Static read-in (input)
Read out: **what states exist** · **who reads/who writes** (across features, across upstream callers — don't stop at this file) · **contract / type** · **control flow and entry points**.

### B2. Build the dynamic model (the main artifact, written into the report as evidence)
- **State diagram** — what states + transitions exist; annotate each transition with **who changes it under what condition**.
- **Timeline** — all writers/readers on a time axis, marking who's first; **pull it through across components, across processes**, tracing back to the moment the state is **truly born** (not where it's re-referenced locally).
- **Change trajectory** — how the key state value flows along the timeline: created / changed / read by whom, ever overwritten / no-op'd / lost midway.

These two diagrams are the evidence — many bugs (a 6-second gap, a key created too early) only reveal themselves once drawn.

### B3. Evaluate 6 classes of dynamic risk on the model

| Risk | What to look for on the model |
|---|---|
| **Order race** | Is there a writer running before the initializer? "init is awaited in this function" ≠ it's the first touch of that state. Trace to the earliest cross-feature writer. |
| **Overlap / undercount** | Multiple writers to one accumulator: is the same event recorded by >1 path (double count)? Is some event class recorded by no one (undercount)? Don't trust the comment's "this only records X" division. |
| **Lost update** | fire-and-forget write + a following read: does it read a stale value and **overwrite** the locally-correct value? |
| **fail-open wrong value** | Does the degradation path let through a *wrong value* or a *missing value*? Returning a confident wrong value for poisoned input = only half safe. **To judge fail-open/fail-closed, read the guard's actual comparison (\`x < threshold\` vs \`x >= threshold\`); don't go by comment or intuition — \`NaN\`/\`Infinity\` sentinels make every \`x < threshold → safe return\` guard evaluate false, so both let-through and block paths break at once.** |
| **Cross-process / re-entry** | Does retry / recovery / multi-worker reusing the same state cross-talk? Does implicit context (ALS / log context) survive a cross-process hop? |
| **Provenance break** | From source to landing point, is the key value no-op'd / overwritten / type-erased midway? (Seeing dedup / skip / idempotency guards → ask what failure they prevent → go to the path **without** them, or an older version, to find that failure.) |

**Escalation: frame hard ordering / arithmetic as satisfiability** (optional — only for **order race** and **extreme value / cancellation**, and only when informal reasoning is uncertain):
1. **Free variables** — what can vary? Order (writer interleaving), values (key numeric variables / inputs / counts).
2. **Write only real constraints** — which happens-before relations truly hold (await / lock / queue order)? Which are just your **assumption**? + the invariant to hold.
3. **∃ counterexample?** — **SAT** (found an order/value that breaks the invariant) = bug, the counterexample is the trigger scenario; **UNSAT** = proven safe under this model (only if the model is faithful to the code).

**Three disciplines (they decide findings quality)**
1. **A census isn't done until both order + overlap relations are verified.** Listing writers ≠ census complete.
2. **No downgrading on local observation.** For ordering / race findings, before downgrading you must trace the timeline to the state's birth. SMT phrasing: did you treat a non-existent happens-before as a constraint? ("some step is awaited in this function" ≠ it globally precedes other components' writes to the same state.) Not traced → mark \`needs dynamic verification\`, keep the tier, don't drop to ⚪.
3. **Green tests ≠ verification.** Ask: is there an **adversarial-order** test (shuffled / retry / write-before-init)? Was the layer the bug lives in mocked away? With a real trace, reconcile against the timeline.

---

## Produce findings (intuitive first)

Severity = **impact × probability**; give the product conclusion directly, don't make the reader do the math. Merge and dedup findings from both tracks, unified format:

\`\`\`
🔴|🟡|⚪ <location (file:line)> — what happens if unfixed (one plain-language consequence, no jargon)
  Impact: how bad + to whom (specific: which users / tenants / callers, not a vague "users")
  Probability: how likely + what it depends on
  Evidence: static → which reference fails in triangulation (intent / input domain / surroundings); dynamic → model evidence (point back to which spot on the state diagram / timeline)
  Fix: what it should be / the broken invariant (jargon goes here)
\`\`\`

- 🔴 high probability × big impact (blocks release) | 🟡 should fix but not bleeding | ⚪ nice-to-have. Output in descending order.
- The one-line conclusion states the **consequence**, not the technical cause (cause goes in \`Fix\`).
- If probability depends on a to-be-verified factor, say so explicitly and write how to raise/lower the tier; don't disguise "to be verified" as "confirmed".
- Multiple same-root-cause → mark as **"accomplices"** and merge into one; don't report the same problem twice (especially when static/dynamic each see one side of the same line).
- Close with an **impact × probability** gradient chart:

\`\`\`
Impact ↑
 big  │ 🔴 #1
 mid  │            🟡 #2
 small│ 🟡 #3                  ⚪ #4
      └─────────────────────────────→ Probability
        low        mid        high
\`\`\`

## Don't go through the motions
- **Don't skip escalation**: if Step 1 flagged a dynamic surface, you MUST actually run Part B on it (modelling + 6 risk classes); scanning statically once and stopping = a miss.
- **Don't compete with tools** (static): style / format go to linter & type-checker, cr only picks the semantic layer.
- **Don't hand-wave the dynamic**: seeing state / timing / concurrency, **build the model** (Part B), don't conclude from reading code.
- **Trivial changes**: no dynamic surface → skip Part B, deliver only a static report.`;
