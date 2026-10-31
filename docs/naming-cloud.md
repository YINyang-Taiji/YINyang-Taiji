# AI 个人档案 —— 命名/标识/云端策略设计（P3）

> 本文档落实审查结论中的 P3：命名消毒、匿名 ID、UTC 时间戳、云端策略。
> 目标是消除"同名冲突、非法字符、隐私泄露、时区歧义"四类隐患。

---

## 1. 命名方案

### 1.1 默认命名
```
profile_<UTC时间戳>_<host-hash8>_<user-sanitized>.zip

示例：profile_20261028T201500Z_a1b2c3d4_zhang-san.zip
```

### 1.2 消毒规则（sanitize）
| 规则 | 处理 |
|---|---|
| 非法字符 | 空格、`/ \ : * ? " < > |` → `-` |
| 控制字符 | 移除 |
| 长度 | 用户名截断至 32 字符 |
| 保留字 | Windows 保留名（CON/PRN/AUX/NUL/COM1..）→ 加前缀 `_` |
| 尾点/空格 | 移除 |
| 用户名 | 默认转匿名 ID（见 2），`--named` 才用真实（含隐私提示） |

### 1.3 唯一性
- 时间戳用 **UTC**，避免时区/夏令时同名歧义。
- `host-hash8` = SHA-256(主机名+盐)[0:8]，**不同机器不撞**（即使同名用户名）。
- 同秒同机：追加序号 `-1`、`-2`。

---

## 2. 匿名 ID 与脱敏
| 项 | 计算 | 用途 |
|---|---|---|
| `profile_id` | SHA-256(用户名+盐)[0:16] | 档案跨机关联，不暴露真实名 |
| `source_device` | SHA-256(主机名+盐)[0:12] | 设备匿名标识 |
| `location.granularity` | 默认 `city` | 不存精确 GPS/地址 |
| 密钥盐 | 随机 16 字节，生成时固化 | 防止彩虹表 |

> 匿名 ID 是**确定性**的（同一用户名+盐 → 同一 ID），用于多机合并；但盐不随档案迁移，否则 ID 会变。盐存于 `~/.dsh/ai-profile/salt`。

---

## 3. UTC 时间戳
- 所有时间字段（`created_at`、`updated_at`、`last_seen`、`last_validated`、`generated_at`、`at`）**一律 UTC ISO 8601**，如 `2026-10-28T20:15:00Z`。
- 展示层才转换到用户时区（`meta.timezone`，IANA）。
- `time_window` 的 `start/end` 为本地钟点，但必须带 `timezone` 字段，避免歧义。

---

## 4. 云端策略

### 4.1 本地优先（local-first）
- 档案默认存本地：`~/.dsh/ai-profile/profiles/`。
- 云端仅作**加密备份**，不做运行时依赖。

### 4.2 上传决策（按 sensitivity）
| 层 | 上云 | 说明 |
|---|---|---|
| `public` | 允许 | 可明文或加密 |
| `private` | 需显式 + 加密 | 默认不上传 |
| `secret` | **禁止** | 绝不自动上云 |

### 4.3 上传前清单
- 上传前输出"将上传字段清单"，用户确认。
- 云端同步前先 `verify`（完整性 + Schema），防止坏档覆盖好档。

### 4.4 同步冲突
- 云备份带 `profile_revision` + `checksum`。
- 云端与本地版本不一致 → 提示 `merge`，不静默覆盖。
- 支持 `push` / `pull` / `sync --dry-run`。

---

## 5. 存储布局
```
~/.dsh/ai-profile/
├─ config.yaml            # 更新/合并/云端配置
├─ salt                   # 匿名ID盐（16字节，不随档案迁移）
├─ profiles/              # 本地档案（未打包的工作目录）
├─ archives/              # 打包后的 ZIP
├─ snapshots/             # 合并/导入前快照（供回滚）
└─ staging/               # 自动更新的暂存区
```
