# AI 个人档案 · 部署包说明（识别与部署指南）

> 这是 **用户** 的 AI 个人档案部署包。换电脑/换环境时，把本包复制到目标机器，用档案包内的工具即可恢复工作角色与状态，**无需重新训练**。

## 这是什么东西（识别）

| 字段 | 值 |
|---|---|
| 档案 ID | 见包内 `manifest.json`（`profile_id`） |
| 修订 | 2（`profile_revision`） |
| 导出时间 | 2026-10-30 |
| 源设备 | 见 `manifest.json`（`source_device`） |
| 时区 | Asia/Shanghai |
| 人格 | 全栈工程师型AI + 专属超级助手 |
| 内容 | 身份 / 偏好 / 时间线 / 软件 / 作息 / 习惯 |

## 包内内容

| 条目 | 说明 |
|---|---|
| `data/profile.json` | 完整档案数据（明文包；加密包则为 `data/profile.enc`） |
| `data/schema.json` | 档案 Schema（随包，目标机无需联网校验） |
| `manifest.json` | 包清单（校验和 / 条目 / 元数据） |
| `identity.md` | 身份摘要（角色 / 语气 / 红线 / 价值观） |
| `preferences.md` | 偏好摘要（输出风格 / AI要求 / 负面偏好 / 边界） |
| `timeline.md` | 时间线摘要（软件 / 作息 / 习惯 / 会话时段） |
| `README-DEPLOY.md` | 本说明 |
| `部署提示词.md` | 目标机上的部署提示词（复制给 AI 即可） |

## 如何部署到另一台电脑

1. 把本包复制到目标电脑，解压出 `ai-profile.zip`（档案包）。
2. 目标电脑需有本工具（`node src/cli.js`，零外部依赖）。
3. 打开 `部署提示词.md`，把全文复制给目标电脑上的 AI，它会自动执行 `verify → import → show → load`。
4. 或手动执行（见部署提示词）。

## 校验

```bash
node src/cli.js verify ai-profile.zip
# 通过 => revision=2，checksum=OK，profile Schema=OK
```

## 安全提示

- 明文包含全部偏好/作息/软件信息，请妥善保管，勿公开分享。
- 若需隐私保护，重新用 `node src/cli.js export -o 包.zip --password <密码>` 导出加密包（此时 `data/profile.json` 变为 `data/profile.enc`）。
