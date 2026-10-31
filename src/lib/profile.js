'use strict';
/**
 * 档案读写/版本模块（P0-4 支撑）。
 * 负责 profile 对象的加载、保存、版本自增、新鲜度注入。
 * 零外部依赖。
 */
const fs = require('fs');
const path = require('path');
const { utcNow } = require('./naming');
const { overallFreshness } = require('./confidence');
const { validate } = require('./verify');

/** 默认档案存储目录。 */
function defaultDir() {
  return path.join(process.env.DSH_HOME || require('os').homedir(), 'ai-profile', 'profiles');
}

/**
 * 从目录加载 profile.json。
 * @param {string} dir 档案目录
 * @returns {object|null} profile 对象，不存在返回 null
 */
function loadProfile(dir) {
  const p = path.join(dir, 'profile.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * 保存 profile.json（原子写入：先写临时文件再 rename）。
 * @param {object} profile
 * @param {string} dir
 */
function saveProfile(profile, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'profile.json');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * 创建新档案（profile_revision=1, base_revision=0）。
 * @param {object} meta { profile_id, source_device, timezone, username? }
 * @param {object} [identity] 初始身份
 * @returns {object} 新 profile
 */
function createProfile(meta, identity = {}) {
  const now = utcNow();
  return {
    schema_version: '1.0.0',
    meta: {
      profile_id: meta.profile_id,
      profile_revision: 1,
      base_revision: 0,
      created_at: now,
      updated_at: now,
      source_device: meta.source_device,
      timezone: meta.timezone || 'UTC',
      encryption: {
        algorithm: 'AES-256-GCM',
        key_derivation: 'PBKDF2-HMAC-SHA256',
        kdf_params: { iterations: 310000, salt_b64: '' },
      },
      freshness: { status: 'fresh', stale_since: null },
      tags: [],
    },
    identity: {
      persona: { primary_role: '', roles: [] },
      tone: { default: '', traits: [] },
      values: [],
      guardrails: [],
      ...(identity || {}),
    },
    preferences: {
      ai_requirements: [],
      feature_settings: {},
      output_style: { language: 'auto', verbosity: 'normal', format_preference: 'auto', professionalism: 'semi_formal', max_output_length: null },
      negative_preferences: [],
      exceptions: [],
      edge_cases: [],
    },
    evidence: { habits: [], schedule: { work_hours: [], sleep_window: null, peak_focus_periods: [], weekly_pattern: [] }, common_software: [], timeline: [], artifacts: [] },
    capabilities: { platforms: [], adapters: [] },
  };
}

/**
 * 版本自增：profile_revision += 1，base_revision = 旧 revision。
 * @param {object} profile
 * @returns {object} 新 profile（浅拷贝 + 更新 meta）
 */
function bumpRevision(profile) {
  const next = { ...profile, meta: { ...profile.meta } };
  next.meta.base_revision = profile.meta.profile_revision;
  next.meta.profile_revision = profile.meta.profile_revision + 1;
  next.meta.updated_at = utcNow();
  return next;
}

/**
 * 计算并写入整体新鲜度到 meta.freshness。
 * @param {object} profile
 * @returns {object} 更新后的 profile
 */
function refreshFreshness(profile) {
  const entries = [
    ...(profile.identity?.persona?.roles || []).map((r) => ({ kind: 'identity', ...r })),
    ...(profile.evidence?.habits || []),
    ...(profile.evidence?.schedule?.work_hours || []),
    ...(profile.evidence?.timeline || []),
  ];
  const fr = overallFreshness(entries);
  const p = { ...profile, meta: { ...profile.meta } };
  p.meta.freshness = { status: fr.status, stale_since: fr.status === 'stale' ? utcNow() : null };
  return p;
}

/**
 * 校验 profile 对象是否符合 profile.schema.json。
 * @param {object} profile
 * @param {string} [schemaPath] 可选 schema 文件路径
 * @returns {{ok, errors}}
 */
function validateProfile(profile, schemaPath) {
  const schema = JSON.parse(fs.readFileSync(schemaPath || path.join(__dirname, '../../schema/profile.schema.json'), 'utf8'));
  return validate(schema, profile);
}

module.exports = {
  defaultDir,
  loadProfile,
  saveProfile,
  createProfile,
  bumpRevision,
  refreshFreshness,
  validateProfile,
};
