# AI 个人档案 —— 可自定义头像模块（proposal）设计清单

> 状态：**建议暂缓 / 不建议自动采集**（经评估）。完整设计清单保留，供日后需要时参考。

## 决策（评估结论）

**推荐：暂不落地自动头像采集模块。** 理由：

1. **无消费方**：workbuddy / Hermes / Claude Code / ChatGPT / Cursor 等平台**都不在 AI 上下文中消费"用户头像"**——头像是人类账户的 UI 元素，AI 靠档案**文本**（人格/语气/红线/习惯）工作，不读头像图片。
2. **会采到空值**：没有可靠数据源能自动提取头像（workbuddy 无头像文件、会话无头像信息），`observe` 大概率得到**空值**——正好印证你的判断。
3. **复杂度/收益失衡**：需加 schema 字段、资产存储、加密、魔数校验、CLI、适配器引用、EXIF 剥离——一套完整管线，却几乎无功能收益。
4. **正确替代**：若某平台确实支持用户头像展示，那是**该平台自己的账户设置**，由用户在该平台手动上传即可，与便携档案无关。

**若日后确有必要**：只做**用户手工提供**的可选 `meta.avatar` 提示（`edit meta.avatar ...`），**绝不自动采集**；保持 optional，缺失即无。

## 完整设计清单（若落地）

## 需求

档案包携带一张用户自定义头像（`avatar`），随档案一起存储/转移/识别，并在 `identity.md` 摘要与目标平台适配器中呈现。换机后无需重新上传头像。

## 需要完善的部分（逐项）

### 1. Schema 扩展（`schema/profile.schema.json` + `schema/manifest.schema.json`）
在 `identity` 下新增 `avatar`（可选）：
```jsonc
"avatar": {
  "type": "object",
  "required": ["ref", "mime", "sha256", "size_bytes", "created_at"],
  "additionalProperties": false,
  "properties": {
    "ref":        { "type": "string", "description": "包内相对路径，如 data/avatar.png" },
    "mime":       { "type": "string", "enum": ["image/png", "image/jpeg", "image/webp"] },
    "sha256":     { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "size_bytes": { "type": "integer", "minimum": 1, "maximum": 5242880 },   // ≤5MB
    "created_at": { "type": "string", "format": "date-time" },
    "note":       { "type": "string" }
  }
}
```
- `identity.avatar` 引用包内资产，**不内嵌 base64**（避免档案 JSON 膨胀）。
- manifest 的 `entries[]` 增加一条 `{ name: "data/avatar.png", type: "asset", mime, sha256, size }`。
- schema_version 递增补丁（1.0.0 → 1.1.0），manifest_version 同步。

### 2. 资产存储（`archive.js`）
- `buildPackage(profile, { avatarPath })`：读入头像字节，作为独立条目写入 ZIP（`data/avatar.png`），并填 `profile.identity.avatar.ref/sha256/size`。
- `readPackage(zip)`：解出头像字节，按 `ref` 还原到目标（导入时落盘到档案资产目录）。
- 条目类型区分：`data/profile.json`（数据）、`data/avatar.png`（资产）、`*.md`（摘要）、`manifest.json`（元数据）。

### 3. 加密策略
- 若带 `--password`：头像字节与档案一同加密（`profile.enc` 内联资产，或将头像作为独立加密条目 `data/avatar.png.enc`）。
- 明文包：头像直接以 `data/avatar.png` 明文存放。
- 决策点：建议头像**随数据一起加密**，避免头像单独明文泄漏；明文包则天然明文。

### 4. 校验（`verify.js`）
- `verifyChecksums` 增加对头像条目的 `sha256` 校验（与 manifest 一致）。
- `validate` 增加 `identity.avatar` 结构校验。
- 新增**图片真实性**校验：读头 8 字节匹配 PNG(`89 50 4E 47`)/JPEG(`FF D8 FF`)/WebP(`52 49 46 46 .. 57 45 42 50`)，拒绝伪装为图片的任意文件。
- 上限 5MB；超限或类型不符 → 校验失败并给明确错误。

### 5. CLI 命令（`cli.js`）
| 命令 | 作用 |
|---|---|
| `node src/cli.js avatar set <img> [--password P]` | 设置/替换头像，写入档案并落盘资产 |
| `node src/cli.js avatar show [--out <dir>]` | 导出头像到本地供预览 |
| `node src/cli.js avatar remove` | 移除头像 |
| `node src/cli.js avatar info` | 显示头像类型/大小/sha256 |

### 6. 摘要渲染（`summary.js`）
- `identity.md` 增加 `## 头像` 段：`![头像](data/avatar.png)` + 类型/大小/哈希/更新时间。

### 7. 平台适配器（`adapters.js`）
- 各平台适配器在其上下文模板中预留头像引用位：如 `[头像: data/avatar.png]`，或输出"头像路径 + 建议上传方式"。
- 支持把头像作为自定义人格图标上传的平台（如 ChatGPT 自定义 GPT 的 logo）给出直接指令。

### 8. 安全
- 头像为用户自选图片：**只做展示**，绝不按可执行/脚本处理；导入时校验图片魔数 + 大小上限。
- 可选：剥离 EXIF（含 GPS/设备信息）再入库，降低隐私泄漏（默认剥离，`--keep-exif` 关闭）。
- 资产路径必须经 `verify.safeRelPath` 校验，拒绝 `../`、绝对路径、符号链接。

### 9. 迁移与版本
- 旧档案（无 avatar）兼容：`avatar` 可选，缺失视为无头像。
- 新档案在旧版本工具上：`schema_version` 前缀兼容检查，旧工具可忽略未知 `avatar` 字段（`additionalProperties` 需允许在 `identity` 内）。

## 落地顺序（建议）
1. Schema + manifest（含版本号）
2. archive.js 资产读写
3. verify 校验（哈希 + 魔数 + 大小）
4. CLI avatar 子命令
5. summary 摘要
6. adapters 平台引用
7. 测试（schema/打包/校验/魔数拒绝伪装文件/大小上限/EXIF 剥离）

> 若确定落地，我按此顺序实现，并补 `docs/avatar.md` 的"实现记录"章节与测试用例。
