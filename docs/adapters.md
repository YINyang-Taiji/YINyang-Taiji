# AI 个人档案 —— 平台适配器层设计（P1）

> 本文档落实审查结论中的 P1-1：平台适配器层 + 能力协商。
> 核心结论：**"任何一个平台都能用"必须改写为"任何实现了标准适配器接口的平台"。**
> 档案本身不变，换平台 = 换适配器；适配器输出前先做能力协商。

---

## 1. 适配器接口（Adapters）

### 1.1 统一接口（每个平台实现）
```ts
interface PlatformAdapter {
  id: string;                 // 如 "openai-chatgpt"
  platform: string;           // 目标平台名
  name: string;

  // 能力声明：该适配器能消费档案的哪些字段、能输出哪些上下文块
  consumes(): FieldPath[];    // 如 ["identity.persona", "preferences.output_style"]
  produces(): ContextBlockType[]; // 如 ["system_prompt", "role", "tool_spec"]

  // 能力协商：读取目标平台能力清单，只注入能消费的部分
  negotiate(platformCaps: PlatformCapabilities): NegotiatedPlan;

  // 生成目标平台的上下文块（system prompt / 角色 / 偏好注入）
  render(profile: Profile, plan: NegotiatedPlan): RenderedContext[];
}
```

### 1.2 能力清单（目标平台声明）
```ts
interface PlatformCapabilities {
  supportsVision: boolean;       // 多模态
  supportsTools: boolean;        // 工具调用
  supportsLongContext: boolean;  // 长上下文
  maxContextTokens: number;
  systemPromptStyle: "openai" | "anthropic" | "custom";
  toolProtocol: "openai-function" | "anthropic-tools" | "none";
}
```

### 1.3 能力协商规则
- **只注入能消费的**：`negotiate()` 依据 `PlatformCapabilities` 裁剪 `consumes()`。
  - 平台不支持视觉 → 不注入多模态字段。
  - 平台工具协议为 `none` → 不注入工具定义。
  - 上下文超长 → 按 `edge_cases` 的保留策略裁剪（保留 identity + 关键偏好）。
- **协商结果持久化**到 `capabilities.adapters[].consumes`，供审计。

---

## 2. 内置适配器清单（MVP）

| 适配器 id | 目标平台 | 状态 | 说明 |
|---|---|---|---|
| `generic` | 任意 OpenAI 兼容 | verified | 通用回退：输出标准 system prompt + 角色 |
| `openai-chatgpt` | ChatGPT | experimental | 输出 OpenAI 风格 system/developer 消息 |
| `anthropic-claude` | Claude | planned | 输出 Anthropic 风格 system 块 |
| `deepseek` | DeepSeek | planned | 走 DeepSeek 协议 |
| `sensenova` | 商汤日日新 | planned | 走 OpenAI 兼容 token.sensenova.cn |

> MVP 先实现 `generic` + `openai-chatgpt`，验证链路后再扩展。

---

## 3. 渲染输出示例

### 3.1 `generic` 适配器 → system prompt
```
你正在以用户 <profile_id> 的 AI 个人档案工作。

【角色】{primary_role}
【语气】{tone.default}；特质：{traits}
【价值观】{values}
【红线(禁止)】{guardrails.hard}
【避免】{negative_preferences} / {negative_traits}
【输出偏好】{output_style}
【边界规则】{edge_cases}
```
> 注：`secret` 层字段（如精确地点、时间轴细节）**默认不注入**，除非用户显式开启且目标为本地。

### 3.2 `openai-chatgpt` 适配器 → messages
```json
[
  { "role": "developer", "content": "<角色+语气+价值观+红线 拼接>" },
  { "role": "system",   "content": "<输出偏好+边界规则>" }
]
```
> OpenAI 新协议用 `developer` 承载身份层，`system` 承载偏好层；工具协议用 `openai-function`。

---

## 4. 字段路径约定
- 用点号路径引用档案字段：`identity.persona.primary_role`、`preferences.output_style.language`。
- 适配器 `consumes()` 只声明它真实读取的字段，**未声明字段不注入**，避免泄露 `secret` 层。

---

## 5. 交付物
- 🔜 `adapters/generic.js` —— 通用适配器（待实现）
- 🔜 `adapters/openai-chatgpt.js` —— ChatGPT 适配器（待实现）
- ✅ `schema/profile.schema.json` 的 `capabilities` 段已定义 `platforms[]` 与 `adapters[]` 结构，供协商结果落盘。
