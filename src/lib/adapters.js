'use strict';
/**
 * 平台适配器 + 能力协商（P1）。
 * 档案不变，换平台 = 换适配器；适配器输出前先做能力协商。
 * 零外部依赖。
 */

/**
 * 默认能力协商配置：只注入目标平台能消费的部分。
 */
function negotiate(profile, caps) {
  const plan = {
    platform: caps.platform,
    consume: [],
    drop: [],
    renderedBlocks: [],
  };
  // 可注入字段映射：能力 → 档案路径
  const fieldFor = {
    identity: ['identity.persona', 'identity.tone', 'identity.guardrails', 'identity.negative_traits'],
    preferences: ['preferences.output_style', 'preferences.ai_requirements', 'preferences.negative_preferences'],
    habits: ['evidence.habits'],
    schedule: ['evidence.schedule'],
  };
  // 依平台能力裁剪
  if (caps.supportsVision === false) plan.drop.push('vision');
  if (caps.supportsTools === false) plan.drop.push('tools');
  if (caps.supportsLongContext === false) plan.drop.push('long_context');
  // 基础身份 + 偏好总是注入（身份是复用的核心）
  plan.consume.push(...fieldFor.identity, ...fieldFor.preferences);
  if (caps.supportsLongContext !== false) {
    plan.consume.push(...fieldFor.habits);
    if (caps.supportsSchedule !== false) plan.consume.push(...fieldFor.schedule);
  }
  // 去掉被裁剪的（本实现中 habits/schedule 属长上下文范畴）
  return plan;
}

/**
 * 渲染目标平台的上下文块（system prompt / developer / system）。
 * @param {object} profile
 * @param {object} plan negotiate() 的结果
 * @param {object} [caps]
 * @returns {Array<{role:string, content:string}>}
 */
function render(profile, plan, caps = {}) {
  const id = profile.meta?.persona?.primary_role || profile.meta?.profile_id || 'user';
  const persona = profile.identity?.persona?.primary_role || '';
  const tone = profile.identity?.tone?.default || '';
  const values = profile.identity?.values || [];
  const guardrails = (profile.identity?.guardrails || []).filter((g) => g.severity === 'hard').map((g) => g.rule);
  const negative = (profile.preferences?.negative_preferences || []).map((n) => n.item);
  const output = profile.preferences?.output_style || {};
  const edge = (profile.preferences?.edge_cases || []).map((e) => `${e.case} → ${e.strategy}`);

  const identityLines = [
    persona && `【角色】${persona}`,
    tone && `【语气】${tone}`,
    values.length && `【价值观】${values.join('；')}`,
    guardrails.length && `【红线(禁止)】${guardrails.join('；')}`,
    negative.length && `【避免】${negative.join('；')}`,
  ].filter(Boolean);
  const prefLines = [
    `【输出】语言=${output.language || 'auto'}，详细度=${output.verbosity || 'normal'}，格式=${output.format_preference || 'auto'}`,
    edge.length && `【边界】${edge.join('；')}`,
  ].filter(Boolean);

  const style = caps.systemPromptStyle || 'openai';
  if (style === 'anthropic') {
    return [
      { role: 'system', content: identityLines.concat(prefLines).join('\n') },
    ];
  }
  // openai 风格：developer 身份层，system 偏好层
  return [
    { role: 'developer', content: identityLines.join('\n') },
    { role: 'system', content: prefLines.join('\n') },
  ];
}

/**
 * 注册表：内置适配器（MVP）。
 */
const ADAPTERS = {
  generic: {
    id: 'generic',
    platform: 'generic-openai-compat',
    name: 'Generic OpenAI-compatible',
    render,
  },
  'openai-chatgpt': {
    id: 'openai-chatgpt',
    platform: 'chatgpt',
    name: 'OpenAI ChatGPT',
    render,
  },
};

/**
 * 通过适配器 id 获取。
 */
function getAdapter(id) {
  return ADAPTERS[id] || null;
}

/**
 * 便捷：一次生成目标平台上下文（negotiate + render）。
 * @param {object} profile
 * @param {string} adapterId
 * @param {object} caps 平台能力
 * @returns {{plan, blocks}}
 */
function renderForPlatform(profile, adapterId, caps) {
  const adapter = getAdapter(adapterId);
  if (!adapter) throw new Error(`adapters: unknown adapter "${adapterId}"`);
  const plan = negotiate(profile, caps);
  const blocks = adapter.render(profile, plan, caps);
  return { plan, blocks };
}

module.exports = {
  negotiate,
  render,
  getAdapter,
  renderForPlatform,
  ADAPTERS,
};
