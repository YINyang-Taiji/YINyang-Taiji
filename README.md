# AI 个人档案（AI Personal Profile）

> 可移植、可复用的个人 AI 画像包 —— 换电脑 / 换场景 / 换 AI 平台时，无需重新调教，直接进入用户最习惯的工作角色与状态。
> 支持 Windows / Linux；档案格式为 ZIP + 结构化数据 + 人读 Markdown；可存本地或自定义加密云备份。

---

## 这是什么

一个跨平台工具（建议 Rust/Go 单文件二进制），收集并维护一份**标准化个人 AI 画像**，包含：

- **身份层**：角色、人格、语气、价值观、安全红线、负面特质
- **偏好层**：对 AI 的要求、功能设置、输出风格、负向偏好、例外场景、边界规则
- **证据层**：习惯、作息、常用软件、行为时间轴、历史作品引用
- **能力层**：适配的平台与适配器清单（供能力协商）

换平台时，用**平台适配器**把档案翻译成目标平台能消费的上下文（system prompt / developer message），无需重新积累提示词与角色定义。

---

## 快速开始（概念示例）

```bash
# 初始化（默认匿名，--named 才用真实用户名）
profile init --timezone Asia/Shanghai

# 观察授权会话并更新（置信度门 + 暂存区）
profile observe --from-session <log>
profile update --manual

# 导出加密档案
profile export -o profile_20261028T201500Z_a1b2c3d4_zhangsan.zip --password ***

# 换机导入（先 dry-run 预览，再确认）
profile import profile_*.zip --dry-run
profile import profile_*.zip --yes

# 生成目标平台上下文
profile load --adapter openai-chatgpt
```

---

## 目录结构

```
schema/
  profile.schema.json      # 数据结构 Schema（P0）
  manifest.schema.json     # 包 manifest Schema（P0）
docs/
  security-versioning.md   # 加密/权限/版本/合并（P0）
  adapters.md              # 平台适配器 + 能力协商（P1）
  import-pipeline.md       # 导入校验/回滚/dry-run（P1）
  update-governance.md     # 置信度门/新鲜度/红线/人在回路（P2）
  naming-cloud.md          # 命名/匿名ID/UTC/云端（P3）
  cli.md                   # 架构 + CLI 设计
examples/
  profile.example.json     # 示例档案（已通过 Schema 校验）
  manifest.example.json    # 示例 manifest（已通过 Schema 校验）
src/
  index.js                 # 聚合导出
  cli.js                   # 命令行入口
  lib/
    encrypt.js             # AES-256-GCM + PBKDF2
    naming.js              # 命名消毒 / 匿名ID / UTC
    confidence.js          # 置信度门 + 新鲜度
    merge.js               # 三方字段级合并 + 冲突仲裁
    verify.js              # SHA-256 + JSON Schema 校验 + 路径安全
    profile.js             # 档案读写 / 版本 / 新鲜度
    adapters.js            # 平台适配器 + 能力协商
    summary.js             # 生成 identity.md / preferences.md / timeline.md
    archive.js             # 零依赖真实 ZIP 打包/解包 + manifest
    observe.js             # 从 workbuddy 数据提取用户习惯（说话/思考/使用）+ 会话时段分析
tests/run-tests.js         # 单元测试（47 用例）
```

---

## 设计原则（本方案的核心改进）

1. **结构化 Schema 承载机器数据**（`data/profile.json`），`.md` 仅为人读摘要 —— 机器逻辑不建在脆弱的 Markdown 上。
2. **平台适配器 + 能力协商** —— "任何一个平台都能用"改写为"任何实现了标准适配器接口的平台"。
3. **默认 AES-256-GCM 加密 + 字段级敏感度**（public/private/secret）—— 隐私是最大风险。
4. **版本 + 三方字段级合并 + 冲突仲裁** —— 多设备不互相覆盖丢数据。
5. **导入校验管线 + 快照回滚 + dry-run** —— 换机即用可靠可回退。
6. **置信度门 + 新鲜度 + 负向偏好/红线** —— 防止档案污染，避免把异常行为当习惯。
7. **命名消毒 + 匿名 ID + UTC + local-first 云备份** —— 消除命名/隐私/时区/覆盖四类隐患。

---

## 已验证

- ✅ `schema/profile.schema.json`、`schema/manifest.schema.json` —— 合法 JSON，且示例通过 Ajv(2020) 严格校验
- ✅ 核心代码 10 模块 + CLI —— `node tests/run-tests.js` **47/47 通过**
- ✅ **observe 采集（通用化）**：从本机 workbuddy（USER/SOUL/IDENTITY/MEMORY + 96 个项目记忆文件 + **1734 个会话时间戳样本**）提取 `applied` 条，Schema 校验通过；会话分析实测高峰 09–12/15–16、实际睡眠 04–07。**面向任意用户**：人格/红线/习惯/称谓/时间轴全部从解析数据派生 + 通用兜底，不再硬编码个人内容；空数据用户得到通用档案（角色=通用智能助理）。
- ✅ **真实 ZIP 档案包**：`export` 产出真 ZIP（magic `PK\x03\x04`），已被 .NET `System.IO.Compression.ZipFile`（Windows 资源管理器同款）成功打开并逐条解压
- ✅ **跨机迁移链路**：`export --password` → 目标机 `import --dry-run`/`import` → `verify`（checksum=OK、profile Schema=OK）；错误口令被正确拒绝
- ✅ 包内结构：`manifest.json` + `data/profile.json`(或 `data/profile.enc`) + `identity.md`/`preferences.md`/`timeline.md` + `data/schema.json`

## 快速验证

```bash
node tests/run-tests.js                                   # 47 用例
node src/cli.js init --timezone Asia/Shanghai             # 初始化
node src/cli.js edit <路径> <值>                          # 自定义项可修改/输入（人格/红线/习惯/称谓/时间轴等）
node src/cli.js observe --root <workbuddy根>              # 从 workbuddy 提取习惯+会话时段
node src/cli.js export -o myprofile.zip --password ***    # 导出真 ZIP
node src/cli.js verify myprofile.zip --password ***       # 校验完整性+Schema
node src/cli.js load --adapter openai-chatgpt             # 生成目标平台上下文
```

## 自定义项编辑（`edit`）

观察采集自动派生；想改任意字段用 `edit` 直接输入/覆盖（只作用于当前档案）：

```bash
node src/cli.js edit <点路径> <值>
```

- 点路径支持数组索引：`evidence.habits.0.value`
- 值解析：`true/false/null`/纯数字/`{...}`/`[...]`/`"..."`（JSON），其余为字符串
- 写入前 **Schema 校验**，不合法即拒绝并回滚（退出码 1）；通过后自增 revision

```bash
node src/cli.js edit identity.persona.primary_role "数据分析专家AI"   # 改人格主角色
node src/cli.js edit identity.tone.default "正式、严谨、结论前置；数据说话"  # 改默认语气
node src/cli.js edit evidence.habits.0.value "每周日做数据复盘"       # 改第0条习惯
node src/cli.js edit preferences.output_style.verbosity "detailed"   # 改输出详细度
node src/cli.js edit preferences.output_style.language "en-US"       # 改语言（"fr" 会被拒绝）
```

## 面向任意用户（泛化）

工具**不绑定任何特定用户内容**：人格/红线/习惯/称谓/时间轴/软件全部从解析数据派生 + 通用兜底，不做硬编码。

- **全新用户（无 workbuddy）**：`init`+`observe` → 角色=`通用智能助理`、通用红线 3 条、软件空、通用作息。
- **有自己文档（如"张伟"）**：USER/IDENTITY/SOUL → 派生其**自身**人格（角色=`数据分析专家AI`、红线含"脱敏"等），换用户即换内容。
- **修改自定义项**：用 `edit` 覆盖任意字段，不被观察结果限定。
- 验证：`empty docs -> generic profile`、`different user docs -> derives THEIR persona` 两项单测。
