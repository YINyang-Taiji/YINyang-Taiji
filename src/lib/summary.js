'use strict';
/**
 * 人读摘要生成（P1）：把 profile 渲染为 Markdown。
 * 生成 identity.md / preferences.md / timeline.md，供人类阅读与交接。
 * 敏感层（secret）默认脱敏，不写入明文摘要。
 */

function list(items, fmt) {
  if (!items || items.length === 0) return '_（暂无）_';
  return items.map((it) => '- ' + fmt(it)).join('\n');
}

function confidenceTag(obj) {
  const c = obj && typeof obj.confidence === 'number' ? obj.confidence : null;
  return c === null ? '' : ` _(置信度 ${c})_`;
}

/** identity.md —— 身份层。 */
function renderIdentity(profile) {
  const id = profile.identity || {};
  const persona = id.persona || {};
  const tone = id.tone || {};
  const lines = [];
  lines.push('# 身份');
  lines.push('');
  lines.push(`> 档案 ID：\`${profile.meta?.profile_id || '-'}\` ｜ 修订：${profile.meta?.profile_revision ?? '-'} ｜ 更新：${profile.meta?.updated_at || '-'}`);
  lines.push('');
  lines.push('## 核心角色');
  lines.push('');
  lines.push(persona.primary_role || '_（未设定）_');
  lines.push('');
  lines.push('## 角色明细');
  lines.push('');
  lines.push(list(persona.roles, (r) => `**${r.name}**：${r.description || ''}${confidenceTag(r)}`));
  lines.push('');
  lines.push('## 语气');
  lines.push('');
  lines.push(tone.default ? `默认语气：**${tone.default}**` : '_（未设定）_');
  if (tone.traits && tone.traits.length) {
    lines.push('');
    lines.push(list(tone.traits, (t) => `${t.trait}${confidenceTag(t)}`));
  }
  lines.push('');
  lines.push('## 价值观');
  lines.push('');
  lines.push(list(id.values, (v) => (typeof v === 'string' ? v : JSON.stringify(v))));
  lines.push('');
  lines.push('## 红线');
  lines.push('');
  lines.push(list(id.guardrails, (g) => `**[${g.severity === 'hard' ? '硬' : '软'}]** ${g.rule}`));
  lines.push('');
  lines.push('## 请避免');
  lines.push('');
  lines.push(list(id.negative_traits, (t) => (typeof t === 'string' ? t : JSON.stringify(t))));
  lines.push('');
  return lines.join('\n');
}

/** preferences.md —— 偏好层。 */
function renderPreferences(profile) {
  const p = profile.preferences || {};
  const os = p.output_style || {};
  const lines = [];
  lines.push('# 偏好');
  lines.push('');
  lines.push('## 对 AI 的要求');
  lines.push('');
  lines.push(list(p.ai_requirements, (r) => `**[${r.priority}]** ${r.requirement}`));
  lines.push('');
  lines.push('## 输出风格');
  lines.push('');
  lines.push(`- 语言：${os.language || 'auto'}`);
  lines.push(`- 详细度：${os.verbosity || 'normal'}`);
  lines.push(`- 格式：${os.format_preference || 'auto'}`);
  lines.push(`- 正式度：${os.professionalism || 'semi_formal'}`);
  if (os.max_output_length != null) lines.push(`- 最大长度：${os.max_output_length}`);
  lines.push('');
  lines.push('## 负向偏好（不要做）');
  lines.push('');
  lines.push(list(p.negative_preferences, (n) => `${n.item}${confidenceTag(n)}${n.reason ? `（原因：${n.reason}）` : ''}`));
  lines.push('');
  lines.push('## 例外场景');
  lines.push('');
  lines.push(list(p.exceptions, (e) => `当 ${e.condition} → ${JSON.stringify(e.override)}`));
  lines.push('');
  lines.push('## 边界规则');
  lines.push('');
  lines.push(list(p.edge_cases, (e) => `**${e.case}** → ${e.strategy}`));
  lines.push('');
  return lines.join('\n');
}

/** timeline.md —— 证据/时间轴层（敏感字段脱敏）。 */
function renderTimeline(profile) {
  const ev = profile.evidence || {};
  const lines = [];
  lines.push('# 时间轴与习惯');
  lines.push('');
  lines.push('## 习惯');
  lines.push('');
  lines.push(list(ev.habits, (h) => `**${h.kind}**：${h.value}${confidenceTag(h)}（出现 ${h.occurrence_count ?? '-'} 次，最近 ${h.last_seen || '-'}）`));
  lines.push('');
  lines.push('## 作息');
  lines.push('');
  const sch = ev.schedule || {};
  if (sch.work_hours && sch.work_hours.length) {
    lines.push('工作时窗：');
    lines.push(list(sch.work_hours, (w) => `${w.start}–${w.end}（${w.timezone}）${confidenceTag(w)}`));
  } else {
    lines.push('_（暂无）_');
  }
  if (sch.sleep_window) {
    lines.push('');
    lines.push(`睡眠窗口：${sch.sleep_window.start}–${sch.sleep_window.end}（${sch.sleep_window.timezone}）`);
  }
  if (sch.peak_focus_periods && sch.peak_focus_periods.length) {
    lines.push('');
    lines.push('高效时段：');
    lines.push(list(sch.peak_focus_periods, (w) => `${w.start}–${w.end}${confidenceTag(w)}`));
  }
  lines.push('');
  lines.push('## 常用软件');
  lines.push('');
  lines.push(list(ev.common_software, (s) => `**${s.name}**：${s.purpose || ''}（${s.frequency || '-'}）`));
  lines.push('');
  lines.push('## 行为时间轴');
  lines.push('');
  // 敏感：仅显示城市级，note 脱敏
  lines.push(list(ev.timeline, (t) => `${t.at} — ${t.event}${t.location?.city ? `（${t.location.city}）` : ''}${confidenceTag(t)}`));
  lines.push('');
  lines.push('## 历史作品');
  lines.push('');
  lines.push(list(ev.artifacts, (a) => `**${a.title}**（${a.platform || '-'}，${a.created_at || '-'}）：\`${a.reference || '-'}\``));
  lines.push('');
  return lines.join('\n');
}

/**
 * 渲染全部摘要。
 * @param {object} profile
 * @returns {{'identity.md': string, 'preferences.md': string, 'timeline.md': string}}
 */
function renderAll(profile) {
  return {
    'identity.md': renderIdentity(profile),
    'preferences.md': renderPreferences(profile),
    'timeline.md': renderTimeline(profile),
  };
}

module.exports = {
  renderIdentity,
  renderPreferences,
  renderTimeline,
  renderAll,
};
