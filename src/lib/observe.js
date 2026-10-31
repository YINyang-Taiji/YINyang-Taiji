'use strict';
/**
 * 观察采集模块（P1 observe）：从 workbuddy 数据内容提取并识别用户习惯。
 *
 * 数据源（workbuddy 长期沉淀）：
 *   <root>/USER.md        用户描述（姓名/城市/职业/备注）
 *   <root>/SOUL.md        核心人格与行为准则（信念/四步思考循环/边界/语气/Skill准则）
 *   <root>/IDENTITY.md    代理身份（名字/定位/Vibe）
 *   <root>/MEMORY.md      用户级长期记忆（规则/软件/自动化/时段）
 *   <root>/../WorkBuddy/<项目>/.workbuddy/memory/*.md   项目级沉淀记忆（可选）
 *
 * 输出：把上述记录经置信度门控，映射进档案的 identity / preferences / evidence。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const verify = require('./verify');
const confidence = require('./confidence');
const naming = require('./naming');

const DEFAULT_ROOT = () => path.join(os.homedir(), '.workbuddy');
const GATE = 0.7; // 置信度门：长期沉淀记录 ≥0.9，远高于门
const LONG_CONF = 0.9; // 长期累计记录的置信度
const MED_CONF = 0.8;

// ---------- 读取 ----------
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/**
 * 定位 workbuddy 数据文件。
 * @param {string} root 默认 os.homedir()/.workbuddy
 * @returns {{root, user, soul, identity, memory, projectMemories: string[]}}
 */
function discoverSources(root = DEFAULT_ROOT()) {
  const user = exists(path.join(root, 'USER.md')) ? path.join(root, 'USER.md') : null;
  const soul = exists(path.join(root, 'SOUL.md')) ? path.join(root, 'SOUL.md') : null;
  const identity = exists(path.join(root, 'IDENTITY.md')) ? path.join(root, 'IDENTITY.md') : null;
  const memory = exists(path.join(root, 'MEMORY.md')) ? path.join(root, 'MEMORY.md') : null;
  const projectMemories = [];
  // 尝试 <root>/../WorkBuddy/<项目>/.workbuddy/memory/*.md
  const wb = path.join(path.dirname(root), 'WorkBuddy');
  if (exists(wb)) {
    for (const entry of fs.readdirSync(wb, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mem = path.join(wb, entry.name, '.workbuddy', 'memory');
      if (exists(mem)) {
        for (const f of fs.readdirSync(mem)) {
          if (/\.md$/i.test(f)) projectMemories.push(path.join(mem, f));
        }
      }
    }
  }
  return { root, user, soul, identity, memory, projectMemories };
}

// ---------- 通用解析 ----------
/** 取某标题到下一同级/更深标题之间的文本。 */
function section(md, heading) {
  if (!md) return '';
  const re = new RegExp('^#{1,6}\\s*' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm');
  const m = md.match(re);
  if (!m) return '';
  const start = m.index;
  const rest = md.slice(start + m[0].length);
  const next = rest.match(/^#{1,6}\s+\S/m);
  return rest.slice(0, next ? next.index : rest.length);
}
/** 提取列表项（- 或 * 或 数字. 开头）。 */
function bullets(md) {
  if (!md) return [];
  return md.split('\n').map((l) => l.trim())
    .filter((l) => /^([-*]|\d+\.)\s+/.test(l))
    .map((l) => l.replace(/^([-*]|\d+\.)\s+/, '').trim())
    .filter(Boolean);
}
/** 从列表项提取 key: value（兼容 `**Key:** value` 与 `**Key** value`）。 */
function keyvals(lines) {
  const out = {};
  for (const l of lines) {
    const m = l.match(/^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/);
    if (m) {
      const key = m[1].replace(/[:：]\s*$/, '');
      if (key) out[key] = m[2];
    }
  }
  return out;
}

// ---------- 各文件解析 ----------
function parseUser(md) {
  const kv = keyvals(bullets(section(md, 'USER.md') || md));
  return {
    name: kv['Name'] || kv['名字'] || '',
    callName: kv['What to call them'] || kv['称呼'] || '',
    city: kv['City'] || kv['城市'] || '',
    occupation: kv['Occupation'] || kv['职业'] || '',
    notes: kv['Notes'] || kv['备注'] || '',
  };
}

function parseIdentity(md) {
  const kv = keyvals(bullets(section(md, 'IDENTITY.md') || md));
  return {
    name: kv['Name'] || '',
    creature: kv['Creature'] || '',
    vibe: kv['Vibe'] || '',
    emoji: kv['Emoji'] || '',
  };
}

function parseSoul(md) {
  const out = { beliefs: [], thinkingCycle: [], boundaries: [], tone: [], skillRules: [] };
  out.beliefs = bullets(section(md, '核心信念'));
  // 方法论：四步思考循环
  out.thinkingCycle = bullets(section(md, '四步思考循环')).slice(0, 8);
  out.boundaries = bullets(section(md, '行为边界'));
  out.tone = bullets(section(md, '语气风格'));
  out.skillRules = bullets(section(md, 'Skill 适配准则')).slice(0, 12);
  return out;
}

function parseMemory(md) {
  const out = { rules: [], software: [], facts: [] };
  out.rules = bullets(md).slice(0, 60);
  // 软件/工具识别
  const SW = {
    'Python': ['python', '受管 Python', '系统 Python'],
    'Chrome/CDP': ['chrome', 'cdp', 'headless', '浏览器'],
    'browser-act': ['browser-act', 'bsk'],
    'crawl4ai': ['crawl4ai'],
    'browser-use': ['browser-use'],
    'uiautomator2/ADB/OCR': ['uiautomator2', 'adb', 'ocr'],
    'westock-mcp': ['westock-mcp', 'westock'],
    'mx-ds-mcp': ['mx-ds-mcp', 'mx-ds'],
    'neodata': ['neodata'],
    'tdx-connector': ['tdx-connector', 'tdx'],
    'akshare': ['akshare'],
    'QQ邮箱/SMTP': ['qq.com', 'smtp', 'send_stock_email'],
    'workbuddy_auto.py': ['workbuddy_auto.py'],
    'uumit_auto_apply.py': ['uumit_auto_apply.py', 'auto_exec.py'],
    'collect_detail.py': ['collect_detail.py'],
  };
  for (const [name, keys] of Object.entries(SW)) {
    if (keys.some((k) => md.includes(k))) out.software.push(name);
  }
  return out;
}

// ---------- 提取为档案结构 ----------
/**
 * @param {object} docs { user, identity, soul, memory, projectMemories: string[] }
 * @param {object} opts { now?: Date, timezone?: string }
 * @returns {{identity, preferences, evidence, meta, observations}}
 */
function extract(docs, opts = {}) {
  const now = opts.now || new Date();
  const tz = opts.timezone || 'Asia/Shanghai';
  const iso = (d) => naming.utcNow(d);
  const user = docs.user || {};
  const ident = docs.identity || {};
  const soul = docs.soul || {};
  const mem = docs.memory || {};

  // ---------- 通用派生工具 ----------
  const firstBullet = (arr) => (arr && arr.length ? arr[0] : '');
  const stripLabel = (s) => s.replace(/^\*\*?[^*：:]{1,12}[*]*[：:]\s*/, '').replace(/^语言风格[:：]\s*/, '').trim();
  const isNeg = (s) => /绝不|不要|不使用|不用|禁止|避免/.test(s);
  const isHard = (s) => /隐私|破坏|风险|危险|未测试|越权|权限|安全/.test(s);
  const loc = () => (user.city ? { granularity: 'city', city: user.city } : { granularity: 'none' });

  // ---------- 身份层（数据驱动，通用兜底） ----------
  const primaryRole = (ident.creature || user.name || user.callName || '通用智能助理').split(/[—\-–:：]/)[0].trim() || '通用智能助理';
  const persona = {
    primary_role: primaryRole,
    roles: [
      { name: primaryRole, description: ident.creature || '通用智能助理', confidence: LONG_CONF },
      ...(ident.vibe ? [{ name: '核心协作角色', description: ident.vibe, confidence: LONG_CONF }] : []),
    ],
  };

  const toneBullets = (soul.tone || []).map(stripLabel).filter(Boolean);
  const tone = {
    default: toneBullets[0] || (ident.vibe ? ident.vibe.split(/[。;；]/)[0] : '简洁直接、逻辑清晰、不冗余；关键结论前置'),
    traits: toneBullets.slice(0, 5).map((t) => ({ trait: t, confidence: LONG_CONF })),
  };

  const values = [
    ...(soul.beliefs || []).map(stripLabel).slice(0, 8),
    // 通用基座（不依赖特定用户内容）
    '以解决实际问题为目标，输出可执行、可验证、可落地的结论',
    '先尝试解决再提问，目标是带着答案回来',
  ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

  const boundaryRules = (soul.boundaries || []).map(stripLabel).filter(Boolean);
  const guardrails = [
    ...boundaryRules.slice(0, 10).map((rule) => ({ rule, severity: isHard(rule) ? 'hard' : 'soft' })),
    // 通用基座
    { rule: '严格保护用户隐私，绝不泄露个人信息、设备配置、使用记录', severity: 'hard' },
    { rule: '破坏性/风险性操作必须获得用户明确确认后才执行', severity: 'hard' },
    { rule: '不提供未经测试的代码', severity: 'hard' },
  ].filter((g, i, a) => a.findIndex((x) => x.rule === g.rule) === i);

  const negative_traits = [
    ...toneBullets.filter(isNeg),
    ...boundaryRules.filter(isNeg),
  ].filter((v, i, a) => a.indexOf(v) === i).slice(0, 8);

  // ---------- 偏好层（数据驱动，通用兜底） ----------
  const output_style = {
    language: 'zh-CN',
    verbosity: 'terse',
    format_preference: 'markdown',
    professionalism: 'semi_formal',
    max_output_length: 2000,
  };

  const memRules = (mem.rules || []).map(stripLabel).filter(Boolean);
  const ai_requirements = [
    ...memRules.slice(0, 8).map((r) => ({ requirement: r, priority: /必须|禁止|绝不|不得/.test(r) ? 'must' : 'should' })),
    { requirement: '会话中获得的重要信息、规则、结论应当写入文档，不依赖临时记忆', priority: 'must' },
  ].filter((x, i, a) => a.findIndex((y) => y.requirement === x.requirement) === i).slice(0, 8);

  const negative_preferences = [
    ...negative_traits.slice(0, 6).map((t) => ({ item: t, confidence: LONG_CONF })),
    ...memRules.filter(isNeg).slice(0, 4).map((r) => ({ item: r, confidence: MED_CONF })),
  ].filter((x, i, a) => a.findIndex((y) => y.item === x.item) === i);

  const edge_cases = [
    ...boundaryRules.filter((r) => /超出|不确定|敏感|越权|权限|范围/.test(r)).slice(0, 6).map((r) => ({ case: r.slice(0, 12), strategy: r })),
    { case: '超出知识范围', strategy: '直接说明「暂不了解」，而非猜测或 AI 幻想' },
    { case: '不确定上下文', strategy: '询问用户需要连接哪个上下文和记忆' },
  ].filter((x, i, a) => a.findIndex((y) => y.case === x.case) === i);

  const exceptions = [
    { condition: '用户明确授权决策', override: { note: '可替代决策，但须时刻反馈决策情况与步骤' } },
  ];

  // ---------- 证据层（习惯/作息/软件/时间线，数据驱动） ----------
  const stamp = (h, occ = 10) => ({ ...h, occurrence_count: occ, first_seen: '2026-01-01T00:00:00Z', last_seen: iso(now), last_validated: iso(now) });
  const habits = [
    // 四步思考循环（若有）
    ...(soul.thinkingCycle && soul.thinkingCycle.length ? [{
      kind: 'thinking_style',
      value: '思考循环：' + soul.thinkingCycle.map(stripLabel).join('→'),
      confidence: LONG_CONF,
    }] : []),
    // 规则类习惯
    ...memRules.slice(0, 6).map((r) => ({ kind: 'habit', value: r, confidence: MED_CONF })),
    // 通用基座
    { kind: 'habit', value: '先尝试解决再提问（读文件/查上下文/搜索）', confidence: LONG_CONF },
    { kind: 'habit', value: '重要信息当轮写入记忆文件，不依赖临时记忆', confidence: LONG_CONF },
  ].map((h) => stamp(h));

  // 作息：通用默认 + 会话分析覆盖
  const work_hours = [{ start: '09:00', end: '18:00', timezone: tz, confidence: MED_CONF }];
  const peak_focus = [{ start: '09:00', end: '12:00', timezone: tz, confidence: MED_CONF }];
  let sleep_window = null;
  const sessions = opts.sessions || null;
  let work_hours_final = work_hours;
  let peak_focus_final = peak_focus;
  let sleep_final = sleep_window;
  const sessionHabits = [];
  const sessionTimeline = [];
  if (sessions && sessions.total > 0) {
    if (sessions.peakFocus && sessions.peakFocus.length) peak_focus_final = sessions.peakFocus;
    if (sessions.sleepWindow) sleep_final = sessions.sleepWindow;
    if (sessions.activeWindows && sessions.activeWindows.length) {
      work_hours_final = sessions.activeWindows.map(([s, e]) => ({ start: pad(s) + ':00', end: pad(e + 1) + ':00', timezone: tz, confidence: MED_CONF }));
    }
    sessionHabits.push(stamp({
      kind: 'thinking_style',
      value: `会话活跃高峰：${sessions.peakFocus.map((p) => p.start + '–' + p.end).join('、') || '见时段'}`,
      confidence: MED_CONF,
    }, 5));
    sessionHabits.push(stamp({
      kind: 'habit',
      value: `实际休息时段：${sessions.sleepWindow ? sessions.sleepWindow.start + '–' + sessions.sleepWindow.end : '无明显低谷'}`,
      confidence: MED_CONF,
    }, 5));
    if (sessions.dow) {
      const busiest = sessions.dow.map((c, i) => ({ i, c })).sort((a, b) => b.c - a.c)[0];
      const wk = ['日', '一', '二', '三', '四', '五', '六'];
      sessionHabits.push(stamp({
        kind: 'habit',
        value: `每周${wk[busiest.i]}使用最密集（${sessions.total} 个会话文件样本）`,
        confidence: MED_CONF,
      }, 5));
    }
    sessionTimeline.push({
      at: sessions.lastAt || iso(now),
      event: `分析 ${sessions.total} 个会话时间戳样本，活跃 ${sessions.activeWindows.length} 个时段`,
      location: loc(), confidence: MED_CONF,
    });
  }

  // 软件：完全由识别得到（不再硬编码个人工具清单）
  const CANON = {
    'python': 'Python', 'chrome/cdp': 'Chrome headless + CDP', 'browser-act': 'browser-act / bsk',
    'crawl4ai': 'crawl4ai', 'browser-use': 'browser-use', 'uiautomator2/adb/ocr': 'uiautomator2 / ADB / OCR',
    'westock-mcp': 'westock / mx-ds / neodata / tdx', 'mx-ds-mcp': 'westock / mx-ds / neodata / tdx',
    'neodata': 'westock / mx-ds / neodata / tdx', 'tdx-connector': 'westock / mx-ds / neodata / tdx',
    'akshare': 'akshare', 'qq邮箱/smtp': 'QQ邮箱 SMTP',
  };
  const software = [];
  for (const sw of mem.software || []) {
    const canon = CANON[sw.toLowerCase()] || sw;
    if (!software.some((x) => x.name === canon)) {
      software.push({ name: canon, purpose: 'workbuddy 长期使用', frequency: 'daily' });
    }
  }

  // 时间线：会话分析 + 记忆中的时段事件（通用检测）
  const timeline = [...sessionTimeline];
  const seenEv = new Set(timeline.map((t) => t.event));
  for (const r of memRules) {
    const m = r.match(/(\d{1,2}):(\d{2})/);
    if (m && !seenEv.has(r.slice(0, 30))) {
      timeline.push({ at: iso(now), event: `常规时段 ${m[1].padStart(2, '0')}:${m[2]}（${r.slice(0, 30)}）`, location: loc(), confidence: MED_CONF });
      seenEv.add(r.slice(0, 30));
      if (timeline.length >= 8) break;
    }
  }

  return {
    identity: { persona, tone, values, guardrails, negative_traits },
    preferences: { output_style, ai_requirements, negative_preferences, edge_cases, exceptions },
    evidence: {
      habits: [...habits, ...sessionHabits],
      schedule: { work_hours: work_hours_final, sleep_window: sleep_final, peak_focus_periods: peak_focus_final },
      common_software: software,
      timeline,
      artifacts: [],
    },
    observations: [...habits, ...sessionHabits],
    user, ident, soul, mem,
  };
}

// ---------- 应用到档案 ----------
function push(arr, item) { if (item) arr.push(item); }

/**
 * 把提取结果写入档案（仅填充空位，不覆盖已有非空字段）。
 * @param {object} profile
 * @param {object} ex extract() 的返回
 * @returns {{profile, applied: number, gated: number}}
 */
function apply(profile, ex, opts = {}) {
  const { now } = opts;
  let applied = 0, gated = 0;

  // 兜底：骨架中可选字段可能未初始化，确保数组存在
  const ensureArr = (obj, k) => { if (!Array.isArray(obj[k])) obj[k] = []; return obj[k]; };
  ensureArr(profile.identity, 'values');
  ensureArr(profile.identity, 'guardrails');
  ensureArr(profile.identity, 'negative_traits');
  ensureArr(profile.identity.persona, 'roles');
  ensureArr(profile.identity.tone, 'traits');
  ensureArr(profile.preferences, 'ai_requirements');
  ensureArr(profile.preferences, 'negative_preferences');
  ensureArr(profile.preferences, 'exceptions');
  ensureArr(profile.preferences, 'edge_cases');
  ensureArr(profile.evidence, 'habits');
  ensureArr(profile.evidence, 'common_software');
  ensureArr(profile.evidence, 'timeline');
  ensureArr(profile.evidence, 'artifacts');
  ensureArr(profile.evidence.schedule, 'work_hours');
  ensureArr(profile.evidence.schedule, 'peak_focus_periods');

  // identity.persona
  const persona = profile.identity.persona;
  if (!persona.primary_role && ex.identity.persona.primary_role) { persona.primary_role = ex.identity.persona.primary_role; applied++; }
  for (const r of ex.identity.persona.roles) {
    if (!persona.roles.some((x) => x.name === r.name)) { persona.roles.push(r); applied++; }
  }
  // tone
  const tone = profile.identity.tone;
  if (!tone.default && ex.identity.tone.default) { tone.default = ex.identity.tone.default; applied++; }
  for (const t of ex.identity.tone.traits) {
    if (!tone.traits.some((x) => x.trait === t.trait)) { tone.traits.push(t); applied++; }
  }
  // values / guardrails / negative_traits
  for (const v of ex.identity.values) if (!profile.identity.values.includes(v)) { profile.identity.values.push(v); applied++; }
  for (const g of ex.identity.guardrails) if (!profile.identity.guardrails.some((x) => x.rule === g.rule)) { profile.identity.guardrails.push(g); applied++; }
  for (const n of ex.identity.negative_traits) if (!profile.identity.negative_traits.includes(n)) { profile.identity.negative_traits.push(n); applied++; }

  // preferences
  const pref = profile.preferences;
  if (pref.output_style.language === 'auto' || !pref.output_style.language) { pref.output_style.language = ex.preferences.output_style.language; applied++; }
  if (!pref.output_style.verbosity) { pref.output_style.verbosity = ex.preferences.output_style.verbosity; applied++; }
  if (!pref.output_style.format_preference) { pref.output_style.format_preference = ex.preferences.output_style.format_preference; applied++; }
  for (const r of ex.preferences.ai_requirements) if (!pref.ai_requirements.some((x) => x.requirement === r.requirement)) { pref.ai_requirements.push(r); applied++; }
  for (const n of ex.preferences.negative_preferences) if (!pref.negative_preferences.some((x) => x.item === n.item)) { pref.negative_preferences.push(n); applied++; }
  for (const e of ex.preferences.edge_cases) if (!pref.edge_cases.some((x) => x.case === e.case)) { pref.edge_cases.push(e); applied++; }
  for (const e of ex.preferences.exceptions) if (!pref.exceptions.some((x) => x.condition === e.condition)) { pref.exceptions.push(e); applied++; }

  // evidence
  const ev = profile.evidence;
  for (const h of ex.evidence.habits) {
    if (!ev.habits.some((x) => x.kind === h.kind && x.value === h.value)) {
      // passesGate 按 {kind, confidence, occurrence_count} 判定（默认门：habit 0.6/3 次）
      if (confidence.passesGate(h)) { ev.habits.push(h); applied++; }
      else gated++;
    }
  }
  const sch = ev.schedule;
  for (const w of ex.evidence.schedule.work_hours) if (!sch.work_hours.some((x) => x.start === w.start)) { sch.work_hours.push(w); applied++; }
  if (!sch.sleep_window && ex.evidence.schedule.sleep_window) { sch.sleep_window = ex.evidence.schedule.sleep_window; applied++; }
  for (const p of ex.evidence.schedule.peak_focus_periods) if (!(sch.peak_focus_periods || []).some((x) => x.start === p.start)) { sch.peak_focus_periods.push(p); applied++; }
  for (const s of ex.evidence.common_software) if (!ev.common_software.some((x) => x.name === s.name)) { ev.common_software.push(s); applied++; }
  for (const t of ex.evidence.timeline) if (!ev.timeline.some((x) => x.event === t.event)) { ev.timeline.push(t); applied++; }

  return { profile, applied, gated };
}

/**
 * 一站式：定位源 → 解析 → 提取 → 应用到档案。
 * @param {object} profile 档案对象
 * @param {object} opts { root?, projects?: boolean, now?, timezone? }
 * @returns {{profile, applied, gated, sources, extracted}}
 */
function observe(profile, opts = {}) {
  const root = opts.root || DEFAULT_ROOT();
  const src = discoverSources(root);
  const docs = {
    user: parseUser(readText(src.user)),
    identity: parseIdentity(readText(src.identity)),
    soul: parseSoul(readText(src.soul)),
    memory: parseMemory(readText(src.memory)),
    projectMemories: src.projectMemories.map(readText),
  };
  // 会话级时间分析：默认启用，可传 includeSessions:false 关闭，或 sessionsRoot 指定目录
  let sessions = opts.sessions;
  if (sessions === undefined) {
    const sessionsRoot = opts.sessionsRoot || path.join(root, 'workspace', 'sessions');
    const want = opts.includeSessions !== false && exists(sessionsRoot);
    sessions = want ? analyzeSessions(sessionsRoot, { timezone: opts.timezone || 'Asia/Shanghai', year: opts.year }) : null;
  }
  const ex = extract(docs, { ...opts, sessions });
  const res = apply(profile, ex, opts);
  return { ...res, sources: src, sessions, extracted: ex };
}

// ---------- 会话级时间分析 ----------
/** 连续小时间隙 ≤gap 时合并为区间。 */
function toRanges(hours, gap = 1) {
  if (!hours.length) return [];
  const sorted = [...hours].sort((a, b) => a - b);
  const ranges = [];
  let s = sorted[0], e = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - e <= gap + 1) { e = sorted[i]; }
    else { ranges.push([s, e]); s = sorted[i]; e = sorted[i]; }
  }
  ranges.push([s, e]);
  return ranges;
}
const pad = (n) => String(n).padStart(2, '0');

/**
 * 遍历会话目录，统计文件修改时间的活跃分布（真实用户编辑 + 记忆写入）。
 * 默认跳过基础设施（snapfile/.modify_backup_meta/锁/排除清单）。
 * @param {string} sessionsRoot 通常 ~/.workbuddy/workspace/sessions
 * @param {object} opts { year?, timezone?, skipDirs?[] }
 * @returns {{total, hour, dow, peakFocus, sleepWindow, activeHours, activeWindows, firstAt, lastAt}}
 */
function analyzeSessions(sessionsRoot, opts = {}) {
  const year = opts.year || new Date().getFullYear();
  const tz = opts.timezone || 'Asia/Shanghai';
  const skip = opts.skipDirs || ['snapfile', '.modify_backup_meta', 'center.backup.lock', 'excluded_backup_roots', 'node_modules'];
  const acc = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    let items; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (skip.some((s) => p.includes(s))) continue;
      try {
        if (it.isDirectory()) walk(p);
        else if (it.isFile()) { const st = fs.statSync(p); if (st.size > 0) acc.push(st.mtimeMs); }
      } catch { /* 忽略不可读 */ }
    }
  };
  walk(sessionsRoot);
  const pts = acc.filter((ms) => new Date(ms).getFullYear() === year).map((ms) => new Date(ms));
  const hour = Array(24).fill(0), dow = Array(7).fill(0);
  for (const d of pts) { hour[d.getHours()]++; dow[d.getDay()]++; }
  const total = pts.length;
  const firstAt = total ? pts.reduce((a, b) => (a < b ? a : b)).toISOString() : null;
  const lastAt = total ? pts.reduce((a, b) => (a > b ? a : b)).toISOString() : null;

  // 高峰：count ≥ 0.6*max，间隙≤1 小时合并
  const max = Math.max(...hour, 1);
  const peakH = hour.map((c, i) => (c >= max * 0.6 ? i : -1)).filter((i) => i >= 0);
  const peakFocus = toRanges(peakH, 1).map(([s, e]) => ({ start: pad(s) + ':00', end: pad(e + 1) + ':00', timezone: tz, confidence: MED_CONF }));

  // 睡眠：count==0 的最长连续段（长度≥3），否则 null
  let best = null, cur = null;
  for (let i = 0; i < 24; i++) {
    if (hour[i] === 0) { if (cur) cur.push(i); else cur = [i]; }
    else { if (cur && (!best || cur.length > best.length)) best = cur; cur = null; }
  }
  if (cur && (!best || cur.length > best.length)) best = cur;
  let sleepWindow = null;
  if (best && best.length >= 3) {
    // 睡眠窗口跨午夜时取 [start..24]+[0..end]
    const s = best[0], e = best[best.length - 1];
    sleepWindow = { start: pad(s) + ':00', end: pad((e + 1) % 24) + ':00', timezone: tz };
  }

  // 活跃小时 / 活跃窗口（count ≥ max(3, 5%总))
  const thr = Math.max(3, Math.round(total * 0.05));
  const activeHours = hour.map((c, i) => (c >= thr ? i : -1)).filter((i) => i >= 0);
  const activeWindows = toRanges(activeHours, 1);

  return { total, hour, dow, peakFocus, sleepWindow, activeHours, activeWindows, firstAt, lastAt };
}

module.exports = {
  DEFAULT_ROOT, GATE,
  discoverSources, parseUser, parseIdentity, parseSoul, parseMemory,
  extract, apply, observe, analyzeSessions,
  section, bullets, keyvals, toRanges,
};
