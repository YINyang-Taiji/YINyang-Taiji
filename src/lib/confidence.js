'use strict';
/**
 * 置信度门控 + 新鲜度（P2）。
 * 纯逻辑，零外部依赖。
 */

/**
 * 置信度更新公式（新样本加权，越新权重越低，收敛稳定）。
 * new = old*(1-α) + score*α，α = 1/(occurrence+1)
 * @param {number} oldConf 旧置信度 0~1
 * @param {number} score 本次观察得分 0~1
 * @param {number} occurrence 更新后的出现次数（>=1）
 * @returns {number} 新置信度（四舍五入到 4 位）
 */
function updateConfidence(oldConf, score, occurrence) {
  if (occurrence < 1) occurrence = 1;
  const alpha = 1 / (occurrence + 1);
  const next = oldConf * (1 - alpha) + score * alpha;
  return Math.round(next * 10000) / 10000;
}

/**
 * 默认门控配置。
 */
const DEFAULT_GATE = {
  habit: { min_confidence: 0.6, min_occurrence: 3 },
  prompt_pattern: { min_confidence: 0.5, min_occurrence: 2 },
  negative: { min_confidence: 0.7, min_occurrence: 3 },
  schedule: { min_confidence: 0.6, min_occurrence: 5 },
};

/**
 * 判断一条观察是否通过置信度门（达到可写入主档案的条件）。
 * @param {object} obs { kind, confidence, occurrence_count }
 * @param {object} [gate] 覆盖 DEFAULT_GATE 的部分配置
 * @returns {boolean} 通过则 true
 */
function passesGate(obs, gate = {}) {
  const g = { ...DEFAULT_GATE, ...gate };
  const rule = g[obs.kind] ?? g.habit;
  if (!rule) return false;
  const conf = typeof obs.confidence === 'number' ? obs.confidence : 0;
  const occ = obs.occurrence_count ?? 0;
  return conf >= rule.min_confidence && occ >= rule.min_occurrence;
}

/**
 * 默认新鲜度有效期（天）。
 */
const DEFAULT_FRESHNESS = {
  identity: 180,
  preference: 90,
  habit: 30,
  timeline: 14,
  schedule: 30,
};

/**
 * 判断单条目是否过期（stale）。
 * @param {string} lastValidated ISO 时间
 * @param {number} maxDays 有效期（天）
 * @param {Date} [now]
 * @returns {boolean}
 */
function isStale(lastValidated, maxDays, now = new Date()) {
  if (!lastValidated) return true;
  const t = Date.parse(lastValidated);
  if (Number.isNaN(t)) return true;
  return (now.getTime() - t) > maxDays * 86400000;
}

/**
 * 计算整体新鲜度状态。
 * @param {object[]} entries 带 kind/last_validated 的条目
 * @param {object} [cfg] 覆盖 DEFAULT_FRESHNESS
 * @param {Date} [now]
 * @returns {{status:'fresh'|'aging'|'stale', staleCount:number, total:number}}
 */
function overallFreshness(entries, cfg = {}, now = new Date()) {
  const f = { ...DEFAULT_FRESHNESS, ...cfg };
  let stale = 0, aging = 0;
  for (const e of entries) {
    const days = f[e.kind] ?? f.habit;
    const last = e.last_validated;
    if (isStale(last, days, now)) stale++;
    else {
      const t = Date.parse(last);
      const ageDays = (now.getTime() - t) / 86400000;
      if (ageDays > days * 0.5) aging++;
    }
  }
  const total = entries.length || 1;
  const status = stale > 0 ? 'stale' : aging > 0 ? 'aging' : 'fresh';
  return { status, staleCount: stale, total };
}

module.exports = {
  DEFAULT_GATE,
  DEFAULT_FRESHNESS,
  updateConfidence,
  passesGate,
  isStale,
  overallFreshness,
};
