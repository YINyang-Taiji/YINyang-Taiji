'use strict';
/**
 * 命名/标识模块（P3）：文件名消毒、匿名 ID、UTC 时间戳。
 * 仅依赖 Node 内置 crypto，零外部依赖。
 */
const crypto = require('crypto');

/** Windows 保留名，防止生成非法文件名。 */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...['COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9'],
  ...['LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9'],
]);

/** 文件名非法字符（含空格，空格统一转 -）。 */
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f ]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const TRAILING_DASH = /^[-.]+|[-.]+$/g;

/**
 * 消毒文件名组件（用户名/主机名/自定义名）。
 * @param {string} name 原始名字
 * @param {number} [maxLen=32]
 * @returns {string} 安全文件名组件
 */
function sanitizeName(name, maxLen = 32) {
  if (typeof name !== 'string') return '_';
  let out = name
    .replace(ILLEGAL_CHARS, '-')
    .replace(CONTROL_CHARS, '')
    .replace(TRAILING_DASH, '')
    .trim();
  if (out.length === 0) out = '_';
  if (out.length > maxLen) out = out.slice(0, maxLen).replace(TRAILING_DASH, '');
  // Windows 保留名（不区分大小写）
  if (WINDOWS_RESERVED.has(out.toUpperCase())) out = '_' + out;
  return out;
}

/**
 * 确定性匿名 ID（同一用户名+盐 → 同一 ID），用于跨机关联但不暴露真实名。
 * @param {string} username 真实用户名
 * @param {Buffer|string} salt 盐（Buffer 或 hex 字符串）
 * @param {number} [len=16] 输出十六进制字符数
 * @returns {string} 十六进制匿名 ID
 */
function anonymousId(username, salt, len = 16) {
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'utf8');
  const h = crypto.createHash('sha256').update(String(username)).update(saltBuf).digest('hex');
  return h.slice(0, len);
}

/**
 * 主机名匿名标识。
 * @param {string} hostname
 * @param {Buffer|string} salt
 * @param {number} [len=12]
 * @returns {string}
 */
function hostHash(hostname, salt, len = 12) {
  return anonymousId(hostname, salt, len);
}

/**
 * UTC 时间戳（ISO 8601，Z 结尾），用于所有时间字段。
 * @param {Date} [d=new Date()]
 * @returns {string} 如 2026-10-28T23:08:41Z
 */
function utcNow(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 文件名时间戳（紧凑 UTC），用于默认命名。
 * @param {Date} [d=new Date()]
 * @returns {string} 如 20261028T230841Z
 */
function timestampPart(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 生成默认档案文件名。
 * @param {object} opts { username, hostname, salt, time?, seq? }
 * @returns {string} 如 profile_20261028T230841Z_a1b2c3d4_zhangsan.zip
 */
function defaultFileName({ username, hostname, salt, time = new Date(), seq = 0 }) {
  const ts = timestampPart(time);
  const host = hostHash(hostname, salt, 8);
  const user = sanitizeName(username, 32);
  const suffix = seq > 0 ? `-${seq}` : '';
  return `profile_${ts}_${host}_${user}${suffix}.zip`;
}

module.exports = {
  sanitizeName,
  anonymousId,
  hostHash,
  utcNow,
  timestampPart,
  defaultFileName,
  WINDOWS_RESERVED,
};
