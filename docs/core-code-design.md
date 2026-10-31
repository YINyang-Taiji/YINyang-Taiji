# AI 个人档案 —— 核心代码设计文档（简明版）

> 版本：1.4.0（对应 `src/` 全部模块，47/47 单测通过）
> 语言：Node.js（CommonJS，**零外部运行时依赖**，仅用 Node 内置模块）
> 运行：`node src/cli.js <命令>` ｜ 测试：`node tests/run-tests.js`

---

## 总览

```
src/
├─ index.js       聚合导出（lib/* 统一入口）
├─ cli.js         命令行入口（命令分发）
└─ lib/
   ├─ encrypt.js      AES-256-GCM 加解密 + PBKDF2
   ├─ naming.js       文件名消毒 / 匿名ID / UTC 时间戳
   ├─ confidence.js   置信度门控 + 新鲜度
   ├─ merge.js        三方字段级合并 + 冲突仲裁
   ├─ verify.js       SHA-256 完整性 + Schema 校验 + 路径安全
   ├─ profile.js      档案创建 / 读写 / 版本自增 / 新鲜度注入
   ├─ adapters.js     平台适配器 + 能力协商 + 上下文渲染
   ├─ summary.js      人读摘要生成（identity/preferences/timeline.md）
   ├─ archive.js      零依赖真实 ZIP 打包/解包 + manifest + 档案包 API
   └─ observe.js      从 workbuddy 数据提取用户习惯 + 会话时段分析
tests/run-tests.js  单元测试（node 内置 assert，47 用例）
```

---

## 各组成部分

### 1. `lib/encrypt.js` —— 加密（AES-256-GCM + PBKDF2）
| 项 | 内容 |
|---|---|
| **功能** | 用口令加密/解密档案数据，认证加密（防篡改），错误口令立即失败 |
| **逻辑** | PBKDF2-HMAC-SHA256(口令,盐,迭代) → 32字节密钥 → AES-256-GCM 加密；密文拼接为 `[12B IV][16B authTag][密文]` |
| **参数** | `encrypt(data, password, {iterations=310000, salt?, iv?})`；`decrypt(payload, password, {salt, iterations})`；`encryptObject/decryptObject`（对象↔Base64 负载） |
| **结果/效果** | 返回 `{ciphertext, salt, iv, iterations}`；解密返回明文字节；口令错误抛 `authentication failed`；每次调用 IV 唯一（防 nonce 重用） |
| **验证** | 往返一致 ✔、错误口令拒绝 ✔、IV 唯一 ✔、密钥派生确定性 ✔ |

### 2. `lib/naming.js` —— 命名/标识
| 项 | 内容 |
|---|---|
| **功能** | 文件名消毒、确定性匿名 ID、UTC 时间戳、默认档案名 |
| **逻辑** | 非法字符/空格→`-`、去首尾连接符、Windows 保留名加 `_` 前缀；匿名ID = SHA-256(用户名+盐)[0:n]；时间戳一律 UTC |
| **参数** | `sanitizeName(name, maxLen=32)`；`anonymousId(username, salt, len=16)`；`hostHash(host, salt, len=12)`；`utcNow()`；`defaultFileName({username,hostname,salt,time,seq})` |
| **结果/效果** | `profile_<UTCts>_<host8>_<user>.zip`；匿名ID 确定性（同用户同盐→同 ID）且不暴露真实名；时间戳无时区歧义 |
| **验证** | 消毒规则 ✔、匿名ID 确定性/区分性 ✔、UTC 结尾 `Z` ✔、默认名格式 ✔ |

### 3. `lib/confidence.js` —— 置信度门控 + 新鲜度
| 项 | 内容 |
|---|---|
| **功能** | 判断观察是否可写入主档案（防污染）；计算单条/整体新鲜度 |
| **逻辑** | 置信度更新 `new = old*(1-α) + score*α`，`α=1/(occ+1)` 收敛；门控 `conf>=min && occ>=min`；新鲜度按 `last_validated` 与有效期比较 |
| **参数** | `updateConfidence(old,score,occ)`；`passesGate(obs, gate?)`；`isStale(lastValidated, maxDays, now?)`；`overallFreshness(entries, cfg?, now?)` |
| **结果/效果** | 门控返回 true/false；整体新鲜度 `fresh|aging|stale` + `staleCount`；低于门槛的观察留在候选区不写入 |
| **验证** | 置信度收敛 ✔、门槛阈值 ✔、过期判断 ✔、整体新鲜度 ✔ |

### 4. `lib/merge.js` —— 三方字段级合并 + 冲突仲裁
| 项 | 内容 |
|---|---|
| **功能** | 多设备档案合并，不互相覆盖；冲突不静默 |
| **逻辑** | 按叶子字段三方(base/left/right)合并：只左改→取左，只右改→取右，都改且同→取左，都改且不同→记冲突；仲裁按 `(confidence, last_validated)` 取高，无法判定→返回 null（人工处理） |
| **参数** | `merge3(base,left,right)`→`{result,conflicts}`；`arbitrate(base,left,right)`→`{winner,value}|null`；`mergeWithArbitration(base,left,right)`→`{result,conflicts,resolved}` |
| **结果/效果** | 独立修改自动合并；冲突写入 `conflicts` 供人工裁决；无法仲裁的不覆盖 |
| **验证** | 无冲突合并 ✔、独立编辑合并 ✔、同向合并 ✔、冲突上报不覆盖 ✔、仲裁取高置信度 ✔、不可判定返回 null ✔ |

### 5. `lib/verify.js` —— 完整性 + Schema 校验 + 路径安全
| 项 | 内容 |
|---|---|
| **功能** | 导入前校验：文件校验和、JSON 结构、路径穿越防护 |
| **逻辑** | SHA-256 逐文件比对；内置轻量 JSON Schema 校验器（支持 type/required/properties/additionalProperties/items/enum/const/min/max/pattern/format/$ref）；拒绝 `..`、绝对路径、盘符 |
| **参数** | `verifyChecksums(checksum, fileContents)`；`validate(schema, data)`；`safeRelPath(p)`；`sha256Hex/sha256Buf` |
| **结果/效果** | 校验和通过/失败 + 错误清单；Schema 返回 `{ok,errors}`；路径安全返回布尔 |
| **验证** | 校验和通过/拒绝 ✔、路径穿越拒绝 ✔、Schema 类型/必填/多余属性校验 ✔ |

### 6. `lib/profile.js` —— 档案创建/读写/版本
| 项 | 内容 |
|---|---|
| **功能** | 初始化档案、原子读写、版本自增、新鲜度注入、Schema 校验 |
| **逻辑** | `createProfile` 生成四层空骨架(revision=1,base=0)；`saveProfile` 原子写（先 tmp 后 rename）；`bumpRevision` revision+1、base=旧revision；`refreshFreshness` 计算并写 `meta.freshness` |
| **参数** | `createProfile(meta, identity?)`；`loadProfile/saveProfile(dir)`；`bumpRevision(profile)`；`refreshFreshness(profile)`；`validateProfile(profile, schemaPath?)` |
| **结果/效果** | 新档案基线；每次合并/导入 revision 自增；`meta.freshness.status` 反映整体；原子写防半写损坏 |
| **验证** | 基线 revision=1 ✔、bump 后 2/base=1 ✔、过期标记 stale ✔ |

### 7. `lib/adapters.js` —— 平台适配器 + 能力协商
| 项 | 内容 |
|---|---|
| **功能** | 换平台时把档案翻译成目标平台能消费的上下文，且只注入其支持的能力 |
| **逻辑** | `negotiate` 按平台能力(视觉/工具/长上下文)裁剪注入字段；`render` 生成 openai 风格 `developer`(身份层)+`system`(偏好层)，anthropic 风格合并为单 `system` |
| **参数** | `negotiate(profile, caps)`→`{consume,drop}`；`render(profile, plan, caps)`→`[{role,content}]`；`renderForPlatform(profile, adapterId, caps)`；`ADAPTERS` 内置 `generic`、`openai-chatgpt` |
| **结果/效果** | 平台不支持视觉→不注入多模态；输出目标平台可读的 system/developer 消息；红线(hard)始终保留 |
| **验证** | 视觉裁剪 ✔、openai 双消息含角色 ✔、未知适配器抛错 ✔ |

### 8. `lib/summary.js` —— 人读摘要生成
| 项 | 内容 |
|---|---|
| **功能** | 把结构化档案渲染为人类可读的 Markdown（`identity.md` / `preferences.md` / `timeline.md`） |
| **逻辑** | 分段模板拼接：身份（角色/语气/价值观/红线/负面特质）、偏好（AI 要求/输出风格/负向偏好/例外/边界）、时间轴（习惯/作息/软件/行为/作品）；`secret` 层只输出城市级，不写精确地址 |
| **参数** | `renderIdentity(profile)`；`renderPreferences(profile)`；`renderTimeline(profile)`；`renderAll(profile)`→3 个 md 的字符串 |
| **结果/效果** | 生成 3 份 md；随 `buildPackage` 写入 ZIP 的根目录；可脱离工具直接阅读与交接 |
| **验证** | 3 个文件名正确 ✔、身份/红线/负向偏好正确渲染 ✔、标题正确 ✔ |

### 9. `lib/archive.js` —— 真实 ZIP + 档案包
| 项 | 内容 |
|---|---|
| **功能** | 零依赖手写 ZIP（打包/解包），并组装/校验完整档案包（manifest + 数据 + md + schema） |
| **逻辑** | **ZIP**：CRC32 查表 → local file header(`PK\x03\x04`) + Deflate(8)/Store(0) 数据 → central directory(`PK\x01\x02`) → EOCD(`PK\x05\x06`)；UTF-8 文件名标志位 0x0800；解包时按 EOCD→中央目录→本地头→CRC 校验还原。**档案包**：`buildPackage` 依次放入 profile(明文 `data/profile.json` 或加密 `data/profile.enc`)、3 个 md、`data/schema.json`，对全部条目算 SHA-256 写入 manifest.checksum，最后放入 manifest.json（自身不自哈希） |
| **参数** | 底层 `packArchive(files,{time?,deflate?})`→`{buffer,entries}`；`unpackArchive(buffer)`→`Map<path,Buffer>`；`crc32(buf)`。高层 `buildPackage(profile,{password?,time?,sensitivity?})`→`{zip,manifest,files}`；`readPackage(zipBuffer,{password?})`→`{manifest,profile,files,checksumOk,profileSchema}` |
| **结果/效果** | 产出可被 Windows 资源管理器/.NET `ZipFile`/`unzip` 直接打开的**真 ZIP**；`readPackage` 依次做：解包→manifest Schema 校验→逐文件 checksum→解密（如需）→profile Schema 校验；任何一步失败即抛错，不产生半导入 |
| **验证** | CRC32 标准向量 ✔、真实 magic `PK\x03\x04` ✔、deflate 压缩生效 ✔、store 模式 ✔、路径穿越拒绝 ✔、载荷篡改被 CRC 检出 ✔、manifest Schema 校验 ✔、明文/加密往返 ✔、错误口令拒绝 ✔、checksum 篡改检出 ✔、非 ZIP 输入拒绝 ✔、.NET ZipFile 可打开（外部验证）✔ |

### 10. `lib/observe.js` —— 观察采集（workbuddy → 档案）
| 项 | 内容 |
|---|---|
| **功能** | 从本机 workbuddy 数据内容提取并识别用户习惯（说话/思考/使用），并分析会话目录时间戳得出真实作息与活跃时段 |
| **逻辑** | `discoverSources(root)` 定位 USER/SOUL/IDENTITY/MEMORY + 项目记忆 → `parse*` 按标题段/列表项/`**Key:** value` 解析 → `extract` 归一化到 identity/preferences/evidence → `apply` 只填充空位（不覆盖人工设定），habits 经 `confidence.passesGate` 门控；`analyzeSessions(sessionsRoot)` 遍历文件 mtime 直方图 → `peakFocus`/`sleepWindow`/`dow` |
| **参数** | `discoverSources(root)`；`parse* (md)`；`extract(docs,{now,timezone,sessions})`；`apply(profile,ex)`；`observe(profile,{root,timezone,includeSessions,sessionsRoot})`；`analyzeSessions(sessionsRoot,{year,timezone})` |
| **结果/效果** | SOUL 信念/四步思考循环/边界/语气、IDENTITY 角色/Vibe、MEMORY 规则/软件/自动化时段 → 档案对应字段；会话分析给出高峰/睡眠/最密星期并写入 habits。实测 `applied=74`、`gated=0`（1734 会话样本） |
| **验证** | 解析 user/soul/memory ✔、全链路应用+门控 ✔、档案 Schema PASS ✔、真实数据端到端（96 项目记忆 + 1734 会话样本）✔、会话分析高峰 09–12/15–16 睡眠 04–07 ✔、软件别名归并 13→10 ✔ |

### 11. `cli.js` —— 命令行入口
| 项 | 内容 |
|---|---|
| **功能** | 把上述库暴露为命令行工具 |
| **逻辑** | 按首参分发命令；读写 `~/.dsh/ai-profile/`（可用 `DSH_HOME` 覆盖）；盐文件自动生成；`export`/`import`/`verify`/`merge` 全部走真实 ZIP |
| **参数** | `init [--timezone TZ] [--named]`、`show`、`update [--manual]`、`edit <路径> <值>`（自定义项可修改/输入）、`observe [--root <workbuddy根>] [--timezone TZ]`、`export -o <zip> [--password P]`、`verify <zip> [--password P]`、`import <zip> [--dry-run|--yes] [--password P]`、`merge A.zip B.zip [--dry-run] [-o out.zip]`、`load --adapter <id>`、`adapters list` |
| **结果/效果** | observe→从 workbuddy 提取并保存习惯；export→真 ZIP（含 manifest/md/schema）；verify→checksum+Schema 结论；import→无本地档案直接导入，有则修订分叉需 `--yes` 且先快照；load→输出适配器渲染的上下文 |
| **验证** | init/update 往返 revision 递增 ✔、observe 真实数据 applied=70 ✔、export 产出真 ZIP ✔、跨机 import ✔、dry-run 不写入 ✔、错误口令 exit=1 ✔ |

---

## 关键设计要点
1. **零外部依赖**：只用 Node 内置模块（crypto/fs/path/os/zlib），单文件可拷贝即用，符合"换机即用"。
2. **真实 ZIP**：手写 ZIP 格式，产出可被操作系统与其他工具直接打开的 `.zip`，而非"改名 JSON"。
3. **认证加密**：AES-256-GCM，错误口令立即失败，不产生可读垃圾。
4. **完整性可验证**：manifest 内逐文件 SHA-256；解包即校验，篡改会被发现。
5. **不静默覆盖**：合并冲突写入 `conflicts`，无法仲裁返回 null 交人工；导入前先快照。
6. **防污染**：置信度门 + 新鲜度，低于门槛/过期的观察不注入。
7. **适配器契约**：档案不变，换平台=换适配器；能力协商只注入目标平台支持的部分。

## 后续（已留待实现）
- 会话消息正文 → 平台/工具使用频次统计（当前已基于文件 mtime 得到时段规律）。
- 负面偏好负样本校准（用户纠正过的行为作为负例）。
- 快照回滚命令 `rollback --to <rev>`（快照已在导入时自动生成，命令尚未实现）。
- 云端 `push/pull/sync`（设计见 `docs/naming-cloud.md`）。
- 发行版可编译为 Rust/Go 单文件（本设计逻辑可直接移植）。
