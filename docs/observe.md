# AI 个人档案 —— 观察采集模块（P1 observe）设计文档

> 目标：从本机 **workbuddy 数据内容**提取并识别用户习惯，沉淀为档案的说话/思考/使用习惯；并从**会话目录时间戳**分析真实作息与活跃时段。
> 对应 `src/lib/observe.js` + CLI `observe` 命令。零外部依赖。

---

## 1. 数据源（workbuddy 长期沉淀）

| 文件 | 内容 | 映射到 |
|---|---|---|
| `~/.workbuddy/USER.md` | 用户描述（姓名/城市/职业/备注/技术栈） | identity.persona, evidence |
| `~/.workbuddy/SOUL.md` | 核心人格与行为准则（信念/四步思考循环/边界/语气/Skill准则） | identity.values, guardrails, tone, preferences |
| `~/.workbuddy/IDENTITY.md` | 代理身份（名字/定位/Vibe/Emoji） | identity.persona.primary_role, roles |
| `~/.workbuddy/MEMORY.md` | 用户级长期记忆（规则/软件/自动化/时段） | preferences.ai_requirements, evidence.habits/schedule/software |
| `~/WorkBuddy/<项目>/.workbuddy/memory/*.md` | 项目级沉淀记忆（可选，发现 95 个） | evidence（补充软件/时段/习惯） |

> 通过 `observe.discoverSources(root)` 自动发现；默认 `root = os.homedir()/.workbuddy`。

## 2. 提取流程

```
discoverSources(root)  → 定位 USER/SOUL/IDENTITY/MEMORY + 项目记忆
        │
parseUser / parseIdentity / parseSoul / parseMemory   （按标题段 + 列表项 + `**Key:** value` 解析）
        │
extract(docs, {now, timezone})   → 归一化结构：
│      identity.persona.primary_role / roles[] / tone / values[] / guardrails[] / negative_traits[]
│      preferences.output_style / ai_requirements[] / negative_preferences[] / edge_cases[] / exceptions[]
│      evidence.habits[] / schedule{work_hours,sleep_window,peak_focus} / common_software[] / timeline[]
│
apply(profile, extracted)  → 仅填充空位（不覆盖已有非空字段），habits 过置信度门
```

## 3. 置信度门控

- 长期累计沉淀记录 → `confidence = 0.9`（高于 habit 门 0.6 / 出现 ≥3 次）。
- `confidence.passesGate({kind, confidence, occurrence_count})` 判定；未过门的进入 `gated` 计数不写入。
- 本次实测：`applied=70`，`gated=0`（长期数据全部通过）。

## 4. 提取到档案的字段映射（实测结果）

| 档案字段 | 来源 | 实测值 |
|---|---|---|
| `identity.persona.primary_role` | IDENTITY.md `Creature` 首段 | 全栈工程师型AI |
| `identity.persona.roles[]` | IDENTITY.md `Creature`/`Vibe` | 全栈工程师型AI；主公的超级助手 |
| `identity.tone.default` | SOUL.md 语气风格 | 简洁直接、逻辑清晰、不冗余、不客套；关键结论前置 |
| `identity.values[]` | SOUL.md 核心信念 | 12 条（含"四步思考循环""对抗模型惯性"等） |
| `identity.guardrails[]` | SOUL.md 行为边界 | 6 条（隐私 hard / 破坏性需确认 hard / 深夜不打扰 soft…） |
| `identity.negative_traits[]` | SOUL.md 语气风格 | 4 条（"好问题"开头 / 模棱两可 / 未测试代码…） |
| `preferences.ai_requirements[]` | MEMORY.md 规则 | 5 条（只执行不修改 / 先备份后固化 / 正确结果才通过…） |
| `preferences.negative_preferences[]` | SOUL.md + MEMORY.md | 4 条 |
| `preferences.edge_cases[]` | SOUL.md 行为边界 | 4 条（超出知识范围 / 敏感操作 / 不确定上下文…） |
| `evidence.habits[]` | SOUL/MEMORY 长期习惯 | 6 条（只执行不修改 / 先备份后固化 / 先尝试再提问…） |
| `evidence.schedule` | MEMORY.md 时段 | work_hours 1 个（08:30–18:00）、peak_focus 2 个、sleep 23:00–08:00 |
| `evidence.common_software[]` | MEMORY.md 软件 | 10 项（System Python / Chrome+CDP / browser-act / bsk / crawl4ai / uiautomator2…） |
| `evidence.timeline[]` | MEMORY.md 自动化 | 6 条（8:30 早盘快讯 / 13:10 午间扫描 / 0:01 签到…） |

## 5. 会话级时间分析（`analyzeSessions`）

从 `~/.workbuddy/workspace/sessions/*` 遍历文件修改时间戳（真实用户编辑 `modify_backup/*` + 记忆写入），统计活跃分布，推导作息。

| 推导项 | 规则 | 实测（2026，样本 1734） |
|---|---|---|
| `peakFocus` | count ≥ 0.6×max 的小时，间隙≤1 小时合并 | **09:00–12:00、15:00–16:00** |
| `sleepWindow` | count==0 的最长连续段（≥3 小时） | **04:00–07:00**（实际最安静 4–6 时） |
| `activeWindows` | count ≥ max(3, 5%总) 的小时合并 | 见 `activeHours` |
| `dow` | 星期分布 | **周一/周二最密集** |

> 自动发现会话目录；可 `--sessions off` 关闭或 `--sessions <dir>` 指定。会话级习惯（活跃高峰/实际休息/最密星期）经门控写入 `evidence.habits`。

## 6. 使用

```bash
node src/cli.js init --timezone Asia/Shanghai
node src/cli.js observe --root "C:\Users\Administrator\.workbuddy" --timezone Asia/Shanghai
node src/cli.js export -o profile.zip --password ***
```

## 7. 验证

- 单元测试：`node tests/run-tests.js` **47/47 通过**（含 observe 6 项、会话分析 2 项、**泛化通用 2 项**）。
- 真实数据端到端：USER/SOUL/IDENTITY/MEMORY + 项目记忆 96 个 + **会话样本 1734** → `applied=74`、`gated=0`、Schema **PASS**、导出真 ZIP `verify` OK。
- 会话分析实测：高峰 09:00–12:00 / 15:00–16:00，实际睡眠 04:00–07:00，周一/周二最密集。
- **通用化（面向任意用户）**：人格/红线/习惯/称谓/时间轴/软件全部从解析数据派生 + 通用兜底，**不硬编码任何个人内容**；全新用户（空数据）得到通用档案（角色=通用智能助理、无软件、通用红线）；不同用户文档派生其自身人格（测试用"数据分析专家AI"验证）。

## 8. 边界与后续

- **只识别不推断**：模块只把 workbuddy 里**明确记录**的内容映射进档案，不做主观猜测；`SOUL.md` 的"四步思考循环"等视为思考习惯原样收录。
- **不覆盖人工设定**：`apply` 只填充空位，已有人工字段保持。
- **会话分析基于文件 mtime 代理**：`modify_backup/*` 的修改时间反映用户编辑行为，是最接近真实活动的本地证据；非会话目录（如仅存在基础设施）会被跳过。
- **后续**：① 负面偏好负样本（用户纠正过的行为）可作为负例校准；② 会话消息正文可提炼平台/工具使用频次；③ `observe` 接入 `update` 自动触发链。

## 9. 自定义项可修改/输入（`edit` 命令）

观察采集是**自动**的；若自动结果不符、或想改任意字段，用 `edit` 直接输入/覆盖（只作用于当前档案，不依赖观察）。

### 用法
```bash
node src/cli.js edit <点路径> <值>
```

### 规则
- **点路径**支持数组索引：`evidence.habits.0.value`。
- **值解析**：`true/false/null` → 布尔/空；纯数字 → `Number`；`{...}`/`[...]`/`"..."` → `JSON.parse`；其余 → 字符串。
- **写入前 Schema 校验**：不合法（如 `preferences.output_style.language` 传 `fr`，而枚举仅 `zh-CN|en-US|ja-JP|auto`）→ **拒绝并回滚**，退出码 1。
- 通过后自增 `profile_revision`。

### 示例
| 命令 | 作用 |
|---|---|
| `edit identity.persona.primary_role "数据分析专家AI"` | 改人格主角色 |
| `edit identity.tone.default "正式、严谨、结论前置；数据说话"` | 改默认语气（含空格值） |
| `edit evidence.habits.0.value "每周日做数据复盘"` | 改第 0 条习惯（数组索引） |
| `edit preferences.output_style.verbosity "detailed"` | 改输出详细度（枚举） |
| `edit preferences.output_style.language "en-US"` | 改语言（合法枚举；`fr` 会被拒绝） |

## 10. 泛化示例（面向任意用户）

工具**不绑定**任何特定用户内容：人格/红线/习惯/称谓/时间轴/软件全部从解析数据派生 + 通用兜底。

### 场景 A：全新用户（无 workbuddy）
`init` + `observe` → 通用档案：
- 角色 = `通用智能助理`；红线 = 通用 3 条（隐私/破坏性确认/未测试代码）；软件 = 空（不伪造）；高峰/睡眠 = 通用默认。

### 场景 B：有自己的文档（如"张伟"）
USER.md `Name: 张伟`、IDENTITY.md `数据分析专家AI — 数据驱动决策`、SOUL.md 边界含"脱敏" → 派生：
- 角色 = `数据分析专家AI`；红线含"数据导出必须脱敏"；AI 要求含"每次分析先确认数据口径"。

### 场景 C：修改自定义项
用 `edit` 覆盖任意字段（见 §9），**不被观察结果限定**。

### 注意
- 剩余内容（如本机"主公的超级助手""长春"）来自用户**真实数据**（IDENTITY.md / USER.md），非硬编码；换用户即换内容。
- 单元测试：`empty docs -> generic profile`、`different user docs -> derives THEIR persona` 验证上述泛化。
