# AI 个人档案 —— 工具架构与 CLI 设计

> 汇总各优先级设计，给出整体架构与命令行界面。
> 语言建议：**Rust 或 Go** 打包为单文件二进制，天然跨平台（Windows/Linux）、无运行时依赖，最符合"换机即用"。

---

## 1. 整体架构

```
┌────────────────────────────────────────────────────────┐
│                Profile Engine（跨平台 CLI）              │
│  ┌──────────┬──────────┬──────────┬─────────────────┐  │
│  │ 采集层    │ 建模层    │ 治理层    │ 分发层           │  │
│  │ 显式输入  │ 标准Schema│ 加密/脱敏 │ 平台适配器        │  │
│  │ 隐式观察  │ 置信度加权 │ 版本/合并 │ 能力协商          │  │
│  │ 授权控制  │ 负向偏好  │ 校验/回滚 │ 生成 SystemPrompt│  │
│  └──────────┴──────────┴──────────┴─────────────────┘  │
│  存储：本地(profiles/) ←→ 加密云备份(自定义, local-first) │
└────────────────────────────────────────────────────────┘
```

模块对应：
- 采集层：`src/observe.js`（或 Rust `observe.rs`）
- 建模层：`schema/profile.schema.json`（数据结构）、`src/confidence.js`
- 治理层：`src/encrypt.js`、`src/merge.js`、`src/verify.js`
- 分发层：`adapters/*.js`

---

## 2. 命令行接口（CLI）

```
# 初始化
profile init --name "张三" --named        # 初始化档案（--named 才用真实名，默认匿名）
profile init --timezone Asia/Shanghai

# 采集 / 更新
profile observe --from-session <log>      # 从授权会话提取观察
profile update --manual                    # 手动更新（合并暂存区）
profile update --auto --interval 7d        # 自动周期更新

# 查看
profile show                               # 人读摘要（.md）
profile diff --rev 3 --rev 4               # 版本差异

# 导出 / 导入
profile export -o profile_<ts>_<host>.zip --password ***
profile import <zip> --dry-run             # 预览差异与冲突，不写入
profile import <zip> --yes                 # 导入（自动快照）
profile verify <zip>                       # 完整性+Schema 校验

# 合并 / 回滚
profile merge A.zip B.zip --dry-run        # 三方合并预览
profile merge A.zip B.zip                  # 合并（冲突写 conflicts/）
profile rollback --to 3                    # 从快照回滚

# 适配器 / 生效
profile load --adapter openai-chatgpt      # 生成目标平台上下文（能力协商）
profile adapters list                      # 列出可用适配器

# 云端
profile push --remote <url> --dry-run      # 上传前清单预览
profile pull --remote <url>
profile sync --remote <url>                # 冲突提示 merge

# 自检
profile self-test                          # 用测试档案跑通完整导入链路
```

---

## 3. 命令与模块映射（✅ 已实现 / 🔜 设计中）
| 命令 | 主要模块 | 状态 |
|---|---|---|
| `init` | `profile.createProfile` + `saveProfile` | ✅ |
| `observe` | `observe.observe`（workbuddy → 习惯 + 会话时段分析） | ✅ |
| `update` | `profile.refreshFreshness` + `bumpRevision` | ✅（简易） |
| `export` | `archive.buildPackage`（真 ZIP：manifest+profile+md+schema） | ✅ |
| `import` | `archive.readPackage` + 快照 + 修订分叉检查 | ✅ |
| `verify` | `archive.readPackage`（checksum + manifest/profile Schema） | ✅ |
| `merge` | `merge.mergeWithArbitration` + `archive.buildPackage(-o)` | ✅（读真 ZIP） |
| `load` | `adapters.renderForPlatform`（能力协商 → developer/system） | ✅ |
| `adapters list` | `adapters.ADAPTERS` | ✅ |
| `observe` | 采集层（解析授权会话 → observations/） | 🔜 |
| `rollback` | 从 `snapshots/` 恢复 | 🔜 |
| `push`/`pull`/`sync` | 云端同步 | 🔜 |
| `self-test` | 端到端自动验证 | 🔜 |

---

## 4. 交付物清单（当前工作区实际文件）

| 文件 | 说明 | 状态 |
|---|---|---|
| `schema/profile.schema.json` | 数据结构 Schema（P0） | ✅ |
| `schema/manifest.schema.json` | 包 manifest Schema（P0） | ✅ |
| `docs/security-versioning.md` | 加密/权限/版本/合并（P0） | ✅ |
| `docs/adapters.md` | 平台适配器 + 能力协商（P1） | ✅ |
| `docs/import-pipeline.md` | 导入校验/回滚/dry-run（P1） | ✅ |
| `docs/update-governance.md` | 置信度门/新鲜度/红线/人在回路（P2） | ✅ |
| `docs/naming-cloud.md` | 命名/匿名ID/UTC/云端（P3） | ✅ |
| `docs/core-code-design.md` | 核心代码简明设计（各组件功能/逻辑/参数/结果） | ✅ |
| `docs/observe.md` | 观察采集：workbuddy → 习惯提取（说话/思考/使用） | ✅ |
| `examples/profile.example.json` | 示例档案数据 | ✅ |
| `examples/manifest.example.json` | 示例 manifest | ✅ |
| `src/lib/*.js`（10 个模块） | 核心实现 | ✅ |
| `src/cli.js` | 命令行入口 | ✅ |
| `tests/run-tests.js` | 单元测试（47 用例） | ✅ |
| `README.md` | 项目总览 + 使用说明 | ✅ |
