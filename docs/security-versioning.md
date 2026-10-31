# AI 个人档案 —— 安全与版本治理设计（P0）

> 本文档落实审查结论中的 P0-3（加密 + 字段级权限）与 P0-4（版本 + 字段级合并 + 冲突仲裁）。
> 配套 Schema：`schema/profile.schema.json`、`schema/manifest.schema.json`。

---

## 1. 加密与字段级权限（P0-3）

### 1.1 核心原则
1. **默认强制加密**：档案主体默认加密，ZIP 仅作外层容器。
2. **分层敏感度**：字段分 `public / private / secret` 三层，决定"是否加密 / 是否可上云 / 是否脱敏"。
3. **本地优先（local-first）**：档案默认存本地；云端仅存**加密备份**，上传前明确列出将被上传的字段。
4. **最小化收集**：默认关闭敏感项（如精确 GPS），只保留必要粒度。

### 1.2 算法与参数
| 项 | 值 |
|---|---|
| 对称加密 | AES-256-GCM（认证加密，密文 + 认证标签） |
| 密钥派生 | PBKDF2-HMAC-SHA256，迭代 ≥ 100000，随机 16 字节盐 |
| IV | GCM 随机 12 字节 |
| 口令来源 | 用户口令（`profile export --password`）或密钥文件（`--keyfile`） |

> 声明已写入 `manifest.encryption`：`{ enabled, algorithm: "AES-256-GCM", key_derivation: "PBKDF2-HMAC-SHA256", kdf_params: { iterations, salt_b64, iv_b64 } }`。

### 1.3 分层敏感度模型
| 层 | 示例字段 | 加密 | 默认上云 | 备注 |
|---|---|---|---|---|
| `public` | persona、tone、output_style、values | 否 | 可 | 用于"身份卡片"共享 |
| `private` | habit、schedule、common_software、artifacts | 是 | 否（需显式） | 个人习惯 |
| `secret` | timeline.location、note、通信记录 | 是（强） | **禁止** | 机密层，导出也需单独口令 |

### 1.4 脱敏别名
- `profile_id = SHA-256(用户名 + 盐)[0:16]`，不存真实用户名。
- `source_device = SHA-256(主机名 + 盐)[0:12]`，不存真实主机名。
- `timeline.location.granularity` 默认 `city`，**不存精确 GPS/地址**；仅 `secret` 层可开启 `district`。

### 1.5 加密流程（导出）
```
明文 data/ + 人读 .md
  → 按 sensitivity 分层：public 明文 / private+secret 加密
  → 组装 ZIP：
      manifest.json（明文，含 checksum 与 encryption 声明）
      encrypted/<name>.bin（AES-256-GCM(JSON)）
      data/profile.json（若 public 层，明文结构化）
  → 计算 manifest.checksum（对每个条目 SHA-256）
```
> 注意：`checksum` 对加密后的字节计算，保证密文完整性；解密后再对解密结果做 Schema 校验。

---

## 2. 版本与修订（P0-4 前半）

### 2.1 版本字段（写入 `meta` 与 `manifest`）
| 字段 | 含义 |
|---|---|
| `schema_version` | 数据 Schema 版本（如 `1.0.0`），语义化 |
| `profile_revision` | 档案修订号，每次合并/导入自增 |
| `base_revision` | 本档案基于的父修订号，用于冲突检测 |
| `generated_at` / `updated_at` | UTC ISO 8601 |
| `source_device` | 生成/最后更新设备匿名 ID |

### 2.2 版本不变量
- 新档案：`profile_revision = 1`，`base_revision = 0`。
- 单机修改：`profile_revision += 1`，`base_revision = 旧 profile_revision`。
- 合并：`profile_revision = max(左右) + 1`，`base_revision = max(左右 base)`。

---

## 3. 字段级合并与冲突仲裁（P0-4 后半）

### 3.1 合并原则
- **按叶子字段合并**，绝不做整文件覆盖。
- 合并前先做 **base 三方合并**（base / left / right），检测双方相对 base 的变更。
- 冲突仲裁优先级：`(置信度, last_validated, 来源设备)` → 高者胜。

### 3.2 合并算法（伪代码）
```
function merge3(base, left, right):
  result = clone(base)
  for each leaf field f:
    lChanged = (left[f] != base[f])
    rChanged = (right[f] != base[f])
    if not lChanged and not rChanged: continue        # 都没改，保持
    if lChanged and not rChanged: result[f] = left[f]  # 只有左边改，取左
    if not lChanged and rChanged: result[f] = right[f] # 只有右边改，取右
    if lChanged and rChanged:
      if left[f] == right[f]: result[f] = left[f]      # 改得一样，取任
      else: conflicts.append(f)                        # 都改且不同 → 冲突
  return { result, conflicts }

# 冲突仲裁
function arbitrate(conflict, base, left, right):
  # 按 (confidence, last_validated, source_device) 排序取高
  # 无法自动判定 → 写入 conflicts/ 供人工仲裁，绝不静默覆盖
```

### 3.3 关键保障
1. **不静默覆盖**：冲突写入 `conflicts/*.md`，由用户决定。
2. **先 dry-run**：`merge A.zip B.zip --dry-run` 只输出差异预览。
3. **回滚**：合并/导入前自动快照当前档案（`snapshots/<rev>.zip`），保留 undo 入口。

---

## 4. 校验与回滚（P1 支撑）
- **完整性**：`manifest.checksum`（SHA-256 逐文件）。
- **Schema**：`data/profile.json` 用 `profile.schema.json` 校验；`manifest.json` 用 `manifest.schema.json` 校验。
- **导入流程**：`checksum → Schema → 冲突检测 → dry-run 预览 → 确认 → 快照 → 生效`。
- **回滚**：导入失败或用户不满意，可从快照一键恢复。

---

## 5. 交付物（本设计对应的产出）
- ✅ `schema/profile.schema.json` —— 数据结构（含 confidence、freshness、guardrails、negative_preferences）
- ✅ `schema/manifest.schema.json` —— 包 manifest（版本、checksum、entries、encryption、sensitivity）
- 🔜 `src/merge.js` —— 三方字段级合并 + 冲突仲裁（待写实现）
- 🔜 `src/encrypt.js` —— AES-256-GCM 加解密封装（待写实现）
