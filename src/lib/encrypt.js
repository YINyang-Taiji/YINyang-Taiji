'use strict';
/**
 * 加密模块（P0-3）：AES-256-GCM + PBKDF2-HMAC-SHA256。
 * 仅依赖 Node 内置 crypto，零外部依赖。
 *
 * 加密格式（Buffer 拼接）：
 *   [ 12字节 IV ][ 16字节 GCM authTag ][ 密文... ]
 * 解密时先读 IV、再读 authTag、剩余为密文。
 */
const crypto = require('crypto');

const ALGORITHM = 'AES-256-GCM';
const KDF = 'PBKDF2-HMAC-SHA256';
const DEFAULT_ITERATIONS = 310000;
const IV_LEN = 12;          // GCM 推荐 12 字节
const TAG_LEN = 16;         // GCM tag 长度
const SALT_LEN = 16;        // 盐长度

/**
 * 从口令派生 32 字节密钥。
 * @param {string} password 用户口令
 * @param {Buffer} salt 16 字节盐
 * @param {number} iterations KDF 迭代次数
 * @returns {Buffer} 32 字节密钥
 */
function deriveKey(password, salt, iterations = DEFAULT_ITERATIONS) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('encrypt: password must be a non-empty string');
  }
  if (!Buffer.isBuffer(salt) || salt.length < 16) {
    throw new Error('encrypt: salt must be a Buffer of at least 16 bytes');
  }
  return crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
}

/** 生成随机 16 字节盐。 */
function generateSalt() {
  return crypto.randomBytes(SALT_LEN);
}

/** 生成随机 12 字节 IV。 */
function generateIv() {
  return crypto.randomBytes(IV_LEN);
}

/**
 * 加密任意字符串或 Buffer。
 * @param {string|Buffer} plaintext 明文
 * @param {string} password 口令
 * @param {object} [opts]
 * @param {number} [opts.iterations=310000]
 * @returns {{ciphertext: Buffer, salt: Buffer, iv: Buffer, iterations: number}} 密文 + 参数
 */
function encrypt(plaintext, password, opts = {}) {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const salt = opts.salt ?? generateSalt();
  const iv = opts.iv ?? generateIv();
  const key = deriveKey(password, salt, iterations);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 拼接：IV | authTag | ciphertext
  const payload = Buffer.concat([iv, tag, enc]);
  return { ciphertext: payload, salt, iv, iterations };
}

/**
 * 解密由 encrypt() 产生的 Buffer。
 * @param {Buffer} payload IV|authTag|ciphertext 拼接
 * @param {string} password 口令
 * @param {object} [opts] { salt, iterations }
 * @returns {Buffer} 明文字节
 */
function decrypt(payload, password, opts = {}) {
  if (!Buffer.isBuffer(payload)) {
    throw new Error('encrypt: payload must be a Buffer');
  }
  if (payload.length < IV_LEN + TAG_LEN) {
    throw new Error('encrypt: payload too short');
  }
  const iv = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = payload.subarray(IV_LEN + TAG_LEN);
  const key = deriveKey(password, opts.salt, opts.iterations ?? DEFAULT_ITERATIONS);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch (e) {
    throw new Error('encrypt: authentication failed (wrong password or corrupted data)');
  }
}

/**
 * 便捷：加密对象 → JSON 字符串（供存储）。
 * @returns {{ciphertext_b64: string, salt_b64: string, iv_b64: string, iterations: number}}
 */
function encryptObject(obj, password, opts = {}) {
  const r = encrypt(JSON.stringify(obj), password, opts);
  return {
    ciphertext_b64: r.ciphertext.toString('base64'),
    salt_b64: r.salt.toString('base64'),
    iv_b64: r.iv.toString('base64'),
    iterations: r.iterations,
  };
}

/**
 * 便捷：解密对象（与 encryptObject 配套）。
 */
function decryptObject(blob, password) {
  const payload = Buffer.from(blob.ciphertext_b64, 'base64');
  const salt = Buffer.from(blob.salt_b64, 'base64');
  const out = decrypt(payload, password, { salt, iterations: blob.iterations });
  return JSON.parse(out.toString('utf8'));
}

module.exports = {
  ALGORITHM,
  KDF,
  DEFAULT_ITERATIONS,
  IV_LEN,
  TAG_LEN,
  SALT_LEN,
  deriveKey,
  generateSalt,
  generateIv,
  encrypt,
  decrypt,
  encryptObject,
  decryptObject,
};
