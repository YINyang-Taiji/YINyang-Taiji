# AI 个人档案 —— 导入/迁移链路设计（P1）

> 本文档落实审查结论中的 P1-2：导入校验 / 回滚 / dry-run。
> 目标：保证"换机即用"是可靠、可验证、可回退的，而不是"能打包但导入即坏"。

---

## 0. 实现状态（对应 `src/lib/archive.js` + `src/cli.js`）

| 步骤 | 设计 | 实现状态 |
|---|---|---|
| [1] 结构检查（路径穿越防护） | ✅ | ✅ `unpackArchive` 用 `verify.safeRelPath` 拒绝 `..`/绝对路径/盘符 |
| [2] 完整性校验（SHA-256） | ✅ | ✅ `readPackage` → `verifyChecksums` |
| [3] 解密（AES-256-GCM） | ✅ | ✅ `readPackage` 支持 `--password`，错误口令抛 `authentication failed` |
| [4] Schema 校验 | ✅ | ✅ manifest + profile 双 Schema 校验 |
| [5] 冲突检测 | ✅ | 🟡 简化为"修订分叉检测"（`base_revision` 是否等于本地 `profile_revision`） |
| [6] dry-run 预览 | ✅ | ✅ `import --dry-run` 只报告不写入 |
| [7] 确认 | ✅ | ✅ 分叉时需 `--yes` |
| [8] 快照 | ✅ | ✅ 导入前写 `snapshots/<rev>.zip` |
| [9] 生效 | ✅ | ✅ 保存档案 |
| 回滚命令 `rollback` | ✅ | 🔜 快照已生成，命令未实现 |

> 未经实现的部分已在 `docs/core-code-design.md` 的"后续"中列出。

---

## 1. 导入管线（Import Pipeline）

```
profile_<ts>.zip
   │
   ▼
[1] 结构检查     解压为临时目录；拒绝路径穿越（../、绝对路径、符号链接）
   │
   ▼
[2] 完整性校验   对每个条目算 SHA-256，与 manifest.checksum 比对
   │
   ▼
[3] 解密         若 manifest.encryption.enabled → AES-256-GCM 解密（需口令/密钥文件）
   │
   ▼
[4] Schema 校验  manifest.json ← manifest.schema.json
                  data/profile.json ← profile.schema.json
   │
   ▼
[5] 冲突检测     与本地现有档案做 base 三方合并，列出冲突（若有）
   │
   ▼
[6] dry-run 预览 输出：将新增/修改/删除的字段清单 + 冲突清单（不写入）
   │
   ▼
[7] 确认         用户确认（--yes 跳过，需显式）
   │
   ▼
[8] 快照         备份当前档案到 snapshots/<rev>.zip（供回滚）
   │
   ▼
[9] 生效         写入 profile.json，profile_revision += 1，更新 manifest
```

---

## 2. 命令设计

| 命令 | 作用 |
|---|---|
| `import <zip> --dry-run` | 只做 1–6 步，输出差异预览与冲突，**不写入** |
| `import <zip> --yes` | 完整导入（7–9 步），导入前自动快照 |
| `rollback --to <rev>` | 从快照恢复指定修订 |
| `verify <zip>` | 只做 1–4 步，返回"通过/失败+原因" |
| `merge A.zip B.zip --dry-run` | 三方合并预览 |
| `merge A.zip B.zip` | 合并并生成新档案（冲突写入 conflicts/） |

---

## 3. 完整性校验细节
- `manifest.checksum.files`：`{ "path": { "sha256", "size" } }`。
- 校验**加密后字节**（先校验密文完整性，再解密），保证传输/存储无损坏。
- 任何条目校验失败 → 整个导入中止，**不部分写入**（原子性）。

## 4. 回滚细节
- 每次成功导入/合并前，先复制当前档案到 `snapshots/<profile_revision>.zip`。
- `rollback --to <rev>`：用快照替换当前档案，`profile_revision` 回退到快照版本。
- 保留最近 N 份快照（默认 5，可配置），超出自动清理最旧。

## 5. 安全性
- **路径穿越防护**：拒绝 `..`、绝对路径、符号链接、盘符前缀。
- **解压炸弹防护**：限制条目数、单条目大小、总解压大小、压缩比。
- **校验失败不部分生效**：所有检查通过前不触碰目标档案。

## 6. self-test（迁移演练）
- `self-test` 用内置**测试档案**跑通完整管线（1–9 步），验证"换机可用"。
- 测试档案：`examples/profile.example.json` + `examples/manifest.example.json`。
