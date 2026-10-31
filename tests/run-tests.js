'use strict';
/**
 * 单元测试（node 内置 assert，零依赖）。
 * 运行：node tests/run-tests.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const enc = require('../src/lib/encrypt');
const naming = require('../src/lib/naming');
const conf = require('../src/lib/confidence');
const merge = require('../src/lib/merge');
const verify = require('../src/lib/verify');
const profile = require('../src/lib/profile');
const adapters = require('../src/lib/adapters');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✘ ' + name + ' :: ' + e.message); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

section('encrypt (AES-256-GCM + PBKDF2)');
test('roundtrip object', () => {
  const blob = enc.encryptObject({ a: 1, b: '中文' }, 'pw', { iterations: 100000 });
  assert.strictEqual(blob.ciphertext_b64.length > 0, true);
  const back = enc.decryptObject(blob, 'pw');
  assert.deepStrictEqual(back, { a: 1, b: '中文' });
});
test('wrong password fails (auth)', () => {
  const blob = enc.encryptObject({ x: 1 }, 'right', { iterations: 100000 });
  assert.throws(() => enc.decryptObject(blob, 'wrong'), /authentication failed/);
});
test('distinct IV per call (nonce uniqueness)', () => {
  const a = enc.encrypt('same', 'pw', { iterations: 100000 });
  const b = enc.encrypt('same', 'pw', { iterations: 100000 });
  assert.notStrictEqual(a.iv.toString('hex'), b.iv.toString('hex'));
});
test('deriveKey is deterministic', () => {
  const salt = enc.generateSalt();
  const k1 = enc.deriveKey('pw', salt, 1000);
  const k2 = enc.deriveKey('pw', salt, 1000);
  assert.strictEqual(k1.toString('hex'), k2.toString('hex'));
  assert.strictEqual(k1.length, 32);
});

section('naming (sanitize / anonymous / UTC)');
test('sanitizeName removes illegal + reserved', () => {
  assert.strictEqual(naming.sanitizeName('a/b:c*d?'), 'a-b-c-d');
  assert.strictEqual(naming.sanitizeName('CON'), '_CON');
  assert.strictEqual(naming.sanitizeName('   '), '_');
  assert.strictEqual(naming.sanitizeName('name.   '), 'name');
});
test('anonymousId deterministic + len', () => {
  const salt = 'salt-hex';
  const a = naming.anonymousId('alice', salt, 16);
  const b = naming.anonymousId('alice', salt, 16);
  const c = naming.anonymousId('bob', salt, 16);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.strictEqual(a.length, 16);
});
test('utcNow ends with Z and parses', () => {
  const s = naming.utcNow();
  assert.ok(s.endsWith('Z'));
  assert.ok(!Number.isNaN(Date.parse(s)));
});
test('defaultFileName shape', () => {
  const n = naming.defaultFileName({ username: 'zhang san', hostname: 'HOST', salt: 's', time: new Date('2026-10-28T23:08:41Z') });
  assert.ok(/^profile_20261028T230841Z_[0-9a-f]{8}_zhang-san\.zip$/.test(n));
});

section('confidence (gate / freshness)');
test('updateConfidence converges', () => {
  let c = 0.5;
  c = conf.updateConfidence(c, 1, 1); // 0.75
  c = conf.updateConfidence(c, 1, 2); // 0.8333
  assert.ok(c > 0.8 && c < 0.9);
});
test('passesGate thresholds', () => {
  assert.strictEqual(conf.passesGate({ kind: 'habit', confidence: 0.6, occurrence_count: 3 }), true);
  assert.strictEqual(conf.passesGate({ kind: 'habit', confidence: 0.5, occurrence_count: 3 }), false);
  assert.strictEqual(conf.passesGate({ kind: 'habit', confidence: 0.9, occurrence_count: 2 }), false);
});
test('isStale / overallFreshness', () => {
  assert.strictEqual(conf.isStale('2020-01-01T00:00:00Z', 30), true);
  assert.strictEqual(conf.isStale('2026-10-27T00:00:00Z', 30), false);
  const fr = conf.overallFreshness([
    { kind: 'habit', last_validated: '2026-10-27T00:00:00Z' },
    { kind: 'identity', last_validated: '2026-10-27T00:00:00Z' },
  ]);
  assert.strictEqual(fr.status, 'fresh');
});

section('merge (three-way field-level + arbitration)');
test('no conflicts when one side unchanged', () => {
  const base = { identity: { persona: { role: 'A', tone: 't' } }, prefs: { lang: 'zh' } };
  const left = JSON.parse(JSON.stringify(base)); left.identity.persona.role = 'B';
  const right = JSON.parse(JSON.stringify(base));
  const r = merge.merge3(base, left, right);
  assert.strictEqual(r.result.identity.persona.role, 'B');
  assert.strictEqual(r.conflicts.length, 0);
});
test('independent edits merge cleanly', () => {
  const base = { a: { x: 1, y: 2 }, b: 3 };
  const left = { a: { x: 1, y: 99 }, b: 3 };
  const right = { a: { x: 1, y: 2 }, b: 7 };
  const r = merge.merge3(base, left, right);
  assert.strictEqual(r.result.a.y, 99);
  assert.strictEqual(r.result.b, 7);
  assert.strictEqual(r.conflicts.length, 0);
});
test('same edit both sides -> no conflict', () => {
  const base = { v: 'old' };
  const left = { v: 'new' }, right = { v: 'new' };
  const r = merge.merge3(base, left, right);
  assert.strictEqual(r.result.v, 'new');
  assert.strictEqual(r.conflicts.length, 0);
});
test('conflicting edits -> conflict reported, not silent', () => {
  const base = { habit: { confidence: 0.5, value: 'x' } };
  const left = { habit: { confidence: 0.5, value: 'x' } };
  const right = { habit: { confidence: 0.5, value: 'x' } };
  // 制造不同叶子
  const lb = JSON.parse(JSON.stringify(base)); lb.habit.value = 'left';
  const rb = JSON.parse(JSON.stringify(base)); rb.habit.value = 'right';
  const r = merge.merge3(base, lb, rb);
  assert.strictEqual(r.conflicts.length, 1);
  assert.strictEqual(r.conflicts[0].path, 'habit.value');
});
test('arbitrate picks higher confidence', () => {
  const arb = merge.arbitrate(null, { confidence: 0.9, value: 'L' }, { confidence: 0.7, value: 'R' });
  assert.strictEqual(arb.winner, 'left');
});
test('arbitrate returns null when indistinguishable', () => {
  const arb = merge.arbitrate(null, { value: 'L' }, { value: 'R' });
  assert.strictEqual(arb, null);
});

section('verify (checksum + schema + path safety)');
test('verifyChecksums pass/fail', () => {
  const ck = { algorithm: 'sha256', files: { 'a.txt': { sha256: verify.sha256Buf(Buffer.from('hi')), size: 2 } } };
  assert.strictEqual(verify.verifyChecksums(ck, { 'a.txt': 'hi' }).ok, true);
  assert.strictEqual(verify.verifyChecksums(ck, { 'a.txt': 'hx' }).ok, false);
});
test('safeRelPath rejects traversal', () => {
  assert.strictEqual(verify.safeRelPath('data/profile.json'), true);
  assert.strictEqual(verify.safeRelPath('../evil'), false);
  assert.strictEqual(verify.safeRelPath('/abs'), false);
  assert.strictEqual(verify.safeRelPath('C:/x'), false);
  assert.strictEqual(verify.safeRelPath('a/../b'), false);
});
test('validate catches required + type', () => {
  const schema = { type: 'object', required: ['x'], properties: { x: { type: 'number' }, y: { type: 'string' } }, additionalProperties: false };
  assert.strictEqual(verify.validate(schema, { x: 1 }).ok, true);
  assert.strictEqual(verify.validate(schema, { x: 's' }).ok, false);   // 类型错
  assert.strictEqual(verify.validate(schema, { x: 1, z: 2 }).ok, false); // 额外属性
});

section('profile (create / bump / freshness)');
test('createProfile baseline', () => {
  const p = profile.createProfile({ profile_id: 'a'.repeat(16), source_device: 'dev', timezone: 'Asia/Shanghai' });
  assert.strictEqual(p.meta.profile_revision, 1);
  assert.strictEqual(p.meta.base_revision, 0);
  assert.strictEqual(p.meta.freshness.status, 'fresh');
  assert.ok(Array.isArray(p.evidence.habits));
});
test('bumpRevision increments + sets base', () => {
  const p = profile.createProfile({ profile_id: 'a'.repeat(16), source_device: 'd' });
  const n = profile.bumpRevision(p);
  assert.strictEqual(n.meta.profile_revision, 2);
  assert.strictEqual(n.meta.base_revision, 1);
});
test('refreshFreshness marks stale when old', () => {
  const p = profile.createProfile({ profile_id: 'a'.repeat(16), source_device: 'd' });
  p.evidence.habits.push({ kind: 'habit', value: 'x', confidence: 0.8, occurrence_count: 5, last_validated: '2020-01-01T00:00:00Z' });
  const n = profile.refreshFreshness(p);
  assert.strictEqual(n.meta.freshness.status, 'stale');
});

section('adapters (negotiate + render)');
test('negotiate drops vision when unsupported', () => {
  const p = profile.createProfile({ profile_id: 'a'.repeat(16), source_device: 'd' });
  const plan = adapters.negotiate(p, { platform: 'x', supportsVision: false, supportsTools: true, supportsLongContext: true });
  assert.ok(plan.drop.includes('vision'));
  assert.ok(plan.consume.includes('identity.persona'));
});
test('render openai-style yields developer+system', () => {
  const p = profile.createProfile({ profile_id: 'a'.repeat(16), source_device: 'd' });
  p.identity.persona.primary_role = '全栈工程师';
  const blocks = adapters.render(p, { consume: [] }, { systemPromptStyle: 'openai' });
  assert.strictEqual(blocks[0].role, 'developer');
  assert.ok(blocks[0].content.includes('全栈工程师'));
  assert.strictEqual(blocks[1].role, 'system');
});
test('renderForPlatform unknown adapter throws', () => {
  const p = profile.createProfile({ profile_id: 'a'.repeat(16), source_device: 'd' });
  assert.throws(() => adapters.renderForPlatform(p, 'nope', { systemPromptStyle: 'openai' }));
});

section('CLI smoke (init/show/update)');
test('cli init + show + update roundtrip', () => {
  const { main } = require('../src/cli');
  // 用临时 DSH_HOME 隔离
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ai-prof-'));
  process.env.DSH_HOME = tmp;
  main(['init', '--timezone', 'Asia/Shanghai']);
  main(['update']);
  const dir = path.join(tmp, 'ai-profile', 'profiles');
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'));
  assert.strictEqual(p.meta.profile_revision, 2);
  fs.rmSync(tmp, { recursive: true, force: true });
});

section('archive (ZIP pack/unpack + package)');
const archive = require('../src/lib/archive');
const summary = require('../src/lib/summary');

test('crc32 known vector', () => {
  assert.strictEqual(archive.crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('pack/unpack roundtrip + real zip magic', () => {
  const files = [
    { path: 'a.txt', data: 'hello world' },
    { path: 'dir/b.json', data: JSON.stringify({ k: '中文' }) },
  ];
  const { buffer } = archive.packArchive(files);
  assert.strictEqual(buffer.subarray(0, 4).toString('hex'), '504b0304'); // PK\x03\x04
  const out = archive.unpackArchive(buffer);
  assert.strictEqual(out.get('a.txt').toString('utf8'), 'hello world');
  assert.strictEqual(JSON.parse(out.get('dir/b.json').toString('utf8')).k, '中文');
});

test('deflate actually shrinks repetitive data', () => {
  const big = 'A'.repeat(5000);
  const { buffer, entries } = archive.packArchive([{ path: 'big.txt', data: big }]);
  assert.strictEqual(entries[0].method, archive.METHOD_DEFLATE);
  assert.ok(entries[0].compSize < big.length);
  assert.strictEqual(archive.unpackArchive(buffer).get('big.txt').toString(), big);
});

test('store mode when deflate disabled', () => {
  const { entries } = archive.packArchive([{ path: 'x.txt', data: 'abc' }], { deflate: false });
  assert.strictEqual(entries[0].method, archive.METHOD_STORE);
});

test('pack rejects unsafe path', () => {
  assert.throws(() => archive.packArchive([{ path: '../evil', data: 'x' }]), /unsafe path/);
});

test('unpack detects payload corruption (crc)', () => {
  const { buffer } = archive.packArchive([{ path: 'a.txt', data: 'hello world' }], { deflate: false });
  // 单文件：local header 30B + name 5B → payload 从 35 开始
  buffer[36] ^= 0xff;
  assert.throws(() => archive.unpackArchive(buffer), /crc mismatch/);
});

test('buildPackage -> manifest schema valid + roles + checksums', () => {
  const p = profile.createProfile({ profile_id: 'a'.repeat(16), source_device: 'dev0', timezone: 'Asia/Shanghai' });
  const { zip, manifest } = archive.buildPackage(p, { time: new Date('2026-10-29T00:00:00Z') });
  assert.ok(Buffer.isBuffer(zip) && zip.length > 0);
  const ms = JSON.parse(fs.readFileSync(path.join(__dirname, '../schema/manifest.schema.json'), 'utf8'));
  assert.strictEqual(verify.validate(ms, manifest).ok, true, JSON.stringify(verify.validate(ms, manifest).errors));
  assert.strictEqual(manifest.format_version, '1.0');
  assert.strictEqual(manifest.profile_id, 'a'.repeat(16));
  const roles = Object.fromEntries(manifest.entries.map((e) => [e.path, e.role]));
  assert.strictEqual(roles['identity.md'], 'human-readable');
  assert.strictEqual(roles['data/profile.json'], 'machine-data');
  assert.ok(!('manifest.json' in manifest.checksum.files)); // manifest 不自哈希
  assert.ok(manifest.checksum.files['data/profile.json'].sha256.length === 64);
});

test('readPackage plaintext roundtrip + profile schema ok', () => {
  const p = profile.createProfile({ profile_id: 'b'.repeat(16), source_device: 'dev1', timezone: 'UTC' });
  p.identity.persona.primary_role = '全栈工程师';
  const { zip } = archive.buildPackage(p);
  const r = archive.readPackage(zip);
  assert.strictEqual(r.checksumOk, true);
  assert.strictEqual(r.profileSchema.ok, true, JSON.stringify(r.profileSchema.errors));
  assert.strictEqual(r.profile.identity.persona.primary_role, '全栈工程师');
  assert.strictEqual(r.manifest.profile_revision, p.meta.profile_revision);
});

test('readPackage encrypted needs right password', () => {
  const p = profile.createProfile({ profile_id: 'c'.repeat(16), source_device: 'dev2' });
  const { zip } = archive.buildPackage(p, { password: 'pw123' });
  assert.throws(() => archive.readPackage(zip), /password required/);
  assert.throws(() => archive.readPackage(zip, { password: 'bad' }), /authentication failed/);
  const r = archive.readPackage(zip, { password: 'pw123' });
  assert.strictEqual(r.profile.meta.profile_id, 'c'.repeat(16));
  assert.strictEqual(r.manifest.encryption.enabled, true);
});

test('readPackage rejects tampered content (checksum)', () => {
  const p = profile.createProfile({ profile_id: 'd'.repeat(16), source_device: 'dev3' });
  const { zip } = archive.buildPackage(p);
  const map = archive.unpackArchive(zip);
  map.set('data/profile.json', Buffer.from(JSON.stringify({ schema_version: '1.0.0' })));
  const tampered = archive.packArchive([...map].map(([p2, data]) => ({ path: p2, data }))).buffer;
  assert.throws(() => archive.readPackage(tampered), /checksum failed/);
});

test('readPackage rejects non-zip input', () => {
  assert.throws(() => archive.readPackage(Buffer.from('not a zip at all')), /not a zip|EOCD not found/);
  assert.throws(() => archive.readPackage(Buffer.alloc(64)), /EOCD not found/);
});

section('summary (.md render)');
test('renderAll returns 3 markdown files with content', () => {
  const p = profile.createProfile({ profile_id: 'e'.repeat(16), source_device: 'dev4' });
  p.identity.persona.primary_role = '全栈工程师';
  p.identity.tone.default = '直接';
  p.identity.guardrails.push({ rule: '不输出医疗建议', severity: 'hard' });
  p.preferences.negative_preferences.push({ item: '不要啰嗦', confidence: 0.9 });
  const md = summary.renderAll(p);
  assert.deepStrictEqual(Object.keys(md).sort(), ['identity.md', 'preferences.md', 'timeline.md']);
  assert.ok(md['identity.md'].includes('全栈工程师'));
  assert.ok(md['identity.md'].includes('不输出医疗建议'));
  assert.ok(md['preferences.md'].includes('不要啰嗦'));
  assert.ok(md['timeline.md'].startsWith('# 时间轴与习惯'));
});

section('observe (workbuddy -> profile extraction)');
const observe = require('../src/lib/observe');

function fixtureRoot() {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'observe-fixture-'));
  fs.writeFileSync(path.join(tmp, 'USER.md'), `---
summary: "User profile record"
---
- **Name:** 测试用户
- **What to call them:** 测试用户
- **City:** 测试市
- **Notes:** Windows系统本地账户，从事数据采集脚本开发（demo_crawl项目），uiautomator2/ADB/OCR技术栈。偏好简洁直接的交流风格，行动导向。
`);
  fs.writeFileSync(path.join(tmp, 'IDENTITY.md'), `# IDENTITY.md - Who Am I?
- **Name:** 助理
- **Creature:** 全栈工程师型AI — 代码即语言，架构即思想
- **Vibe:** 干练直接、一针见血，少废话多出活。深度技术洞察 + 战略思维，专属超级助手。
`);
  fs.writeFileSync(path.join(tmp, 'SOUL.md'), `# SOUL.md
## 核心信念
1. 保持聪明、高效、辩证、思考全面的思维方式
2. 对技术保持敏感与好奇
3. 拥有明确、坚定的观点，不模棱两可
## 四步思考循环
1. 定义成功标准
2. 选择最可能直达的起点
3. 过程校验，而非二元判断
4. 对照停止，完成即止
## 行为边界
1. 严格保护主人隐私
2. 不执行任何具有破坏性、风险性的操作
3. 深夜时段（23:00–08:00）非紧急情况不主动打扰
## 语气风格
1. 语言风格：简洁直接、逻辑清晰、不冗余、不客套
2. 绝不使用「好问题」作为回答开头
`);
  fs.writeFileSync(path.join(tmp, 'MEMORY.md'), `# 用户级长期记忆
## 代码修改守则
- 大修改前必须备份（带时间戳的目录）
- 先预验证方案可行性，确认后再整合到代码中
## UUmit 自动接任务
- 脚本路径：uumit_auto_apply.py（v4，全自动申请+交付流水线）
- 每小时运行（auto_exec.py 节流入口），每日上限 3 单
## 浏览器自动化技能协同调用
- browser-act 与 BrowserSkill(bsk) 互补、互相促进
- 平台技能：taobao-keyword-search / xiaohongshu-search / goofish-item-detail
`);
  return tmp;
}

test('parseUser extracts name/city/notes', () => {
  const u = observe.parseUser(fs.readFileSync(path.join(fixtureRoot(), 'USER.md'), 'utf8'));
  assert.strictEqual(u.name, '测试用户');
  assert.strictEqual(u.city, '测试市');
  assert.ok(u.notes.includes('demo_crawl'));
});

test('parseSoul extracts beliefs and boundaries', () => {
  const s = observe.parseSoul(fs.readFileSync(path.join(fixtureRoot(), 'SOUL.md'), 'utf8'));
  assert.ok(s.beliefs.length >= 3);
  assert.ok(s.thinkingCycle.length >= 4);
  assert.ok(s.boundaries.some((b) => b.includes('隐私')));
});

test('parseMemory detects software', () => {
  const m = observe.parseMemory(fs.readFileSync(path.join(fixtureRoot(), 'MEMORY.md'), 'utf8'));
  assert.ok(m.software.includes('browser-act'));
  assert.ok(m.software.includes('uumit_auto_apply.py'));
});

test('observe full chain: extract + apply + gate', () => {
  const root = fixtureRoot();
  const p = profile.createProfile({ profile_id: 'f'.repeat(16), source_device: 'dev-observe', timezone: 'Asia/Shanghai' });
  const res = observe.observe(p, { root, timezone: 'Asia/Shanghai' });
  assert.strictEqual(res.sources.user, path.join(root, 'USER.md'));
  assert.ok(res.applied > 5);
  assert.strictEqual(res.profile.identity.persona.primary_role, '全栈工程师型AI');
  assert.ok(res.profile.evidence.common_software.length > 0);
  // 置信度门：所有写入的 habit 应 ≥ 门
  for (const h of res.profile.evidence.habits) assert.ok(h.confidence >= observe.GATE, h.value);
  // 档案 Schema 校验通过
  const pv = verify.validate(JSON.parse(fs.readFileSync(path.join(__dirname, '../schema/profile.schema.json'), 'utf8')), res.profile);
  assert.strictEqual(pv.ok, true, JSON.stringify(pv.errors));
  fs.rmSync(root, { recursive: true, force: true });
});

section('observe sessions (会话级时间分析)');

test('analyzeSessions derives peak/sleep from mtime histogram', () => {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'observe-sess-'));
  // 模拟：9点、11点、15点活跃，4-5点无活动（每观测独立文件）
  let n = 0;
  const mk = (h) => { const f = path.join(tmp, `m${n++}.txt`); fs.writeFileSync(f, 'x'); const d = new Date('2026-04-10T08:00:00Z'); d.setHours(h, 30, 0, 0); fs.utimesSync(f, d, d); };
  for (const h of [9, 9, 11, 11, 15, 15, 4, 4]) mk(h);
  const s = observe.analyzeSessions(tmp, { year: 2026, timezone: 'Asia/Shanghai' });
  assert.strictEqual(s.total, 8);
  assert.ok(s.peakFocus.length >= 1, JSON.stringify(s.peakFocus));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('observe integrates session schedule into profile', () => {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'observe-sess2-'));
  fs.writeFileSync(path.join(tmp, 'USER.md'), '- **Name:** 测试用户\n- **City:** 测试市\n');
  fs.writeFileSync(path.join(tmp, 'SOUL.md'), '## 核心信念\n1. 保持聪明\n## 行为边界\n1. 严格保护隐私\n');
  const sess = path.join(tmp, 'sessions');
  fs.mkdirSync(path.join(sess, 's1', 'modify_backup'), { recursive: true });
  const mk = (h, f) => { const d = new Date('2026-05-01T00:00:00Z'); d.setHours(h, 0, 0, 0); fs.utimesSync(path.join(sess, 's1', 'modify_backup', f), d, d); };
  fs.writeFileSync(path.join(sess, 's1', 'modify_backup', 'a.md'), 'x'); mk(9, 'a.md');
  fs.writeFileSync(path.join(sess, 's1', 'modify_backup', 'b.md'), 'x'); mk(15, 'b.md');
  const p = profile.createProfile({ profile_id: 'j'.repeat(16), source_device: 'd', timezone: 'Asia/Shanghai' });
  const res = observe.observe(p, { root: tmp, timezone: 'Asia/Shanghai', sessionsRoot: sess });
  assert.ok(res.sessions.total >= 2);
  // 高峰时段来自会话分析
  assert.ok(res.profile.evidence.schedule.peak_focus_periods.length >= 1);
  // 会话级习惯已写入
  assert.ok(res.profile.evidence.habits.some((h) => h.value.includes('活跃高峰')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

section('observe generalization (通用化：面向任意用户)');

test('empty docs -> generic profile, no hardcoded user content', () => {
  const ex = observe.extract({ user: {}, identity: {}, soul: {}, memory: {}, projectMemories: [] }, { now: new Date('2026-10-30T00:00:00Z'), timezone: 'Asia/Shanghai' });
  const s = JSON.stringify(ex);
  assert.strictEqual(ex.identity.persona.primary_role, '通用智能助理');
  assert.ok(ex.identity.values.length >= 1);
  assert.ok(ex.identity.guardrails.length >= 1);
  assert.strictEqual(ex.evidence.common_software.length, 0);
  // 不得残留任何用户专属硬编码
  for (const k of ['测试用户', '测试市', '专属超级助手', 'A股', 'westock', '08:30', '猫猫', '签到', '只执行不修改已定型代码', '00:30']) {
    assert.strictEqual(s.includes(k), false, '泛化后仍含硬编码: ' + k);
  }
});

test('different user docs -> derives THEIR persona, not ours', () => {
  const ex = observe.extract({
    user: { name: '张伟', city: '北京', callName: '老板' },
    identity: { creature: '数据分析专家AI — 数据驱动决策', vibe: '冷静务实、结论可追溯' },
    soul: { beliefs: ['数据说话，拒绝主观臆断'], boundaries: ['任何数据导出必须脱敏', '分析结论需附置信度'] },
    memory: { rules: ['每次分析先确认数据口径', '报告先给结论再给依据'] },
    projectMemories: [],
  }, { now: new Date('2026-10-30T00:00:00Z'), timezone: 'Asia/Shanghai' });
  assert.strictEqual(ex.identity.persona.primary_role, '数据分析专家AI');
  assert.ok(ex.identity.persona.roles.some((r) => r.name === '数据分析专家AI'));
  assert.ok(ex.identity.guardrails.some((g) => g.rule.includes('脱敏')));
  assert.ok(ex.preferences.ai_requirements.some((a) => a.requirement.includes('数据口径')));
  assert.strictEqual(JSON.stringify(ex).includes('测试用户'), false);
});

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
