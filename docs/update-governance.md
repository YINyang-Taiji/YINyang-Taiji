# AI 个人档案 —— 更新治理与防污染设计（P2）

> 本文档落实审查结论中的 P2：置信度门 + 新鲜度 + 负面偏好/红线，以及自动更新触发 + 人在回路。
> 核心目标：**防止把一次性异常行为当成习惯固化，避免"档案污染"。**

---

## 1. 置信度门（Confidence Gate）

### 1.1 概念
每条观察条目带 `confidence`（0~1）与 `occurrence_count`（出现次数）。
**低于阈值的观察不写入主档案**，仅进入候选区（`observations/`），达到门槛后才合并。

### 1.2 阈值（默认，可配置）
| 类别 | 写入主档案所需 | 说明 |
|---|---|---|
| 习惯/交互风格 | `confidence >= 0.6` 且 `occurrence_count >= 3` | 需多次出现 |
| 提示词模式 | `confidence >= 0.5` 且 `occurrence_count >= 2` | 可放宽 |
| 负面偏好 | `confidence >= 0.7` 且 `occurrence_count >= 3` | 从严，避免误判 |
| 时间窗(作息) | `confidence >= 0.6` 且 `occurrence_count >= 5` | 需足够样本 |

### 1.3 置信度更新公式
```
new_confidence = old_confidence * (1 - α) + observed_score * α
α = 1 / (occurrence_count + 1)   # 越新样本权重越低，收敛稳定
```
> 避免一次高置信度样本把长期习惯带偏。

---

## 2. 新鲜度机制（Freshness）

### 2.1 概念
每条目带 `last_validated`。超过**有效期**标记为 `stale`，不再作为"当前习惯"注入，提示重新确认。

### 2.2 有效期（默认）
| 类别 | 有效期 | 超过后 |
|---|---|---|
| 身份/角色 | 180 天 | `stale`，注入时降级提示 |
| 偏好/输出风格 | 90 天 | `stale` |
| 习惯/作息 | 30 天 | `stale` |
| 地点/时间轴 | 14 天 | `secret` 层，`stale` 即停止注入 |

### 2.3 整体新鲜度
`meta.freshness.status` = `fresh` / `aging` / `stale`，由引擎基于全部条目 `last_validated` 计算：
- 全部 fresh → `fresh`
- 部分 aging（>50% 有效期）→ `aging`
- 任一核心字段 stale → `stale`

---

## 3. 负面偏好与红线（已写入 Schema）

### 3.1 负面偏好（`preferences.negative_preferences[]`）
用户明确**不喜欢/不要**的内容、主题、指令类型。AI 应主动规避，而非顺着习惯。
```json
{ "item": "不要主动联网", "confidence": 0.9, "reason": "曾因自动联网泄露草稿" }
```

### 3.2 红线（`identity.guardrails[]`）
安全/合规红线，`severity: hard | soft`：
- `hard`：绝对禁止（如"不输出医疗建议""不发送未脱敏数据"）。
- `soft`：默认避免，可被用户显式覆盖。

### 3.3 例外（`preferences.exceptions[]`）
特定平台/场景覆盖默认偏好，用于处理"某平台能力不同"的情况。

### 3.4 边界情况（`preferences.edge_cases[]`）
如"上下文超长时优先保留什么"。默认策略：
```
优先保留：identity(红线>角色>语气) > preferences(输出>负向) > 关键 habit
可裁剪：timeline 细节、artifacts 引用
```

---

## 4. 自动更新触发（P2）

### 4.1 三类触发源
| 触发 | 说明 | 示例 |
|---|---|---|
| 时间触发 | 周期（自定义） | 每日/每周/每月 |
| 事件触发 | 会话结束、工作流完成、关键行为 | AI 会话结束、文件产出 |
| 手动触发 | 用户主动 | `update` 命令 |

### 4.2 证据采集
- 只采集**用户自己授权**的会话与行为（不被动监控他人/系统级数据）。
- `显式输入`：问卷、标签、用户确认。
- `隐式观察`：对用户自己 AI 会话的结构化解析（提示词模式、输出偏好）。

---

## 5. 人在回路（Human-in-the-loop）

### 5.1 暂存区（Staging）
自动更新默认进入 `staging/`，**不直接写入主档案**。达到置信度门槛后：
- 自动更新 → 进入暂存区 → 达到阈值或周期 → **提示用户确认合并**。
- 关键字段（身份、红线、负向偏好）变更 → **必须人工确认**。

### 5.2 流程
```
观察 → 候选区(observations/) → 置信度门通过?
  ├─ 否 → 保留候选，不写入
  └─ 是 → staging/ 暂存
            ├─ 关键字段? → 人工确认 → 合并
            └─ 普通字段 → 周期到达 → 合并（可配置为自动/需确认）
```

### 5.3 默认配置（`config.yaml`）
```yaml
update:
  triggers:
    time: { enabled: true, interval_days: 7 }
    event: { enabled: true, on_session_end: true }
  confidence_gate:
    habit: { min_confidence: 0.6, min_occurrence: 3 }
  human_in_loop:
    critical_fields: ["identity.persona", "identity.guardrails", "preferences.negative_preferences"]
    auto_merge_ordinary: true   # 普通字段可自动合并；关键字段必须人工确认
  freshness:
    identity_days: 180
    habit_days: 30
```
