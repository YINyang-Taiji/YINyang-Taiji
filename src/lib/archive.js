'use strict';
/**
 * 真实 ZIP 归档模块（P0）：零依赖手写 ZIP 格式。
 * 支持 Store(0) 与 Deflate(8) 两种压缩方式，UTF-8 文件名。
 * 另提供档案包高层 API：buildPackage / readPackage（manifest + checksum + 加密）。
 *
 * 仅依赖 Node 内置 zlib / crypto / fs / path。
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const verify = require('./verify');
const encrypt = require('./encrypt');
const naming = require('./naming');
const summary = require('./summary');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC32。
 * @param {Buffer} buf
 * @returns {number} 无符号 32 位
 */
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- ZIP 打包 ----------
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** 转 DOS 时间/日期（用 UTC 保证跨机可复现）。 */
function dosDateTime(d) {
  const year = d.getUTCFullYear();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

/**
 * 打包为 ZIP Buffer。
 * @param {Array<{path:string, data:Buffer|string, compress?:boolean}>} files 文件清单
 * @param {object} [opts] { time?: Date, deflate?: boolean }
 * @returns {{buffer: Buffer, entries: object[]}}
 */
function packArchive(files, opts = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('archive: files must be a non-empty array');
  }
  const now = opts.time || new Date();
  const { time, date } = dosDateTime(now);
  const useDeflate = opts.deflate !== false;

  const locals = [];
  const records = [];
  let offset = 0;

  for (const f of files) {
    if (!f || typeof f.path !== 'string') throw new Error('archive: each file needs a path');
    if (!verify.safeRelPath(f.path)) throw new Error(`archive: unsafe path "${f.path}"`);
    const nameBuf = Buffer.from(f.path, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(raw);

    let method = METHOD_STORE;
    let payload = raw;
    if (useDeflate && f.compress !== false) {
      const deflated = zlib.deflateRawSync(raw);
      if (deflated.length < raw.length) { method = METHOD_DEFLATE; payload = deflated; }
    }

    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4);           // version needed
    header.writeUInt16LE(FLAG_UTF8, 6);    // flags
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);           // extra len

    locals.push(header, nameBuf, payload);
    records.push({ nameBuf, method, crc, compSize: payload.length, rawSize: raw.length, offset, time, date });
    offset += 30 + nameBuf.length + payload.length;
  }

  const cdStart = offset;
  const centrals = [];
  for (const r of records) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(20, 4);   // version made by
    cd.writeUInt16LE(20, 6);   // version needed
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(r.method, 10);
    cd.writeUInt16LE(r.time, 12);
    cd.writeUInt16LE(r.date, 14);
    cd.writeUInt32LE(r.crc, 16);
    cd.writeUInt32LE(r.compSize, 20);
    cd.writeUInt32LE(r.rawSize, 24);
    cd.writeUInt16LE(r.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);   // extra
    cd.writeUInt16LE(0, 32);   // comment
    cd.writeUInt16LE(0, 34);   // disk start
    cd.writeUInt16LE(0, 36);   // internal attrs
    cd.writeUInt32LE(0, 38);   // external attrs
    cd.writeUInt32LE(r.offset, 42);
    centrals.push(cd, r.nameBuf);
    offset += 46 + r.nameBuf.length;
  }
  const cdSize = offset - cdStart;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return { buffer: Buffer.concat([...locals, ...centrals, eocd]), entries: records };
}

// ---------- ZIP 解包 ----------
/**
 * 解包 ZIP Buffer。
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>} 路径 → 内容
 */
function unpackArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('archive: not a zip buffer');
  }
  // 从尾部找 EOCD
  let eocdPos = -1;
  const minPos = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= minPos; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error('archive: EOCD not found (not a valid zip)');

  const count = buffer.readUInt16LE(eocdPos + 10);
  const cdOffset = buffer.readUInt32LE(eocdPos + 16);
  const files = new Map();
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error('archive: corrupt central directory');
    }
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compSize = buffer.readUInt32LE(p + 20);
    const rawSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);

    if (!verify.safeRelPath(name)) throw new Error(`archive: unsafe path in zip "${name}"`);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`archive: corrupt local header for "${name}"`);
    }
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buffer.length) throw new Error(`archive: truncated data for "${name}"`);
    const comp = buffer.subarray(dataStart, dataStart + compSize);

    let raw;
    if (method === METHOD_STORE) raw = Buffer.from(comp);
    else if (method === METHOD_DEFLATE) raw = zlib.inflateRawSync(comp);
    else throw new Error(`archive: unsupported compression method ${method} for "${name}"`);

    if (raw.length !== rawSize) throw new Error(`archive: size mismatch for "${name}"`);
    if (crc32(raw) !== crc) throw new Error(`archive: crc mismatch for "${name}"`);

    files.set(name, raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------- 档案包高层 API ----------
/** 路径 → 条目角色。 */
function roleOf(p) {
  if (p === 'manifest.json') return 'metadata';
  if (p.startsWith('observations/')) return 'observations';
  if (p.startsWith('artifacts/')) return 'artifacts';
  if (p.startsWith('adapters/')) return 'adapter-config';
  if (p.endsWith('.md')) return 'human-readable';
  return 'machine-data';
}

const PROFILE_SCHEMA_URL = 'https://ai-personal-profile.dev/schema/profile.schema.json';
const MANIFEST_SCHEMA_URL = 'https://ai-personal-profile.dev/schema/manifest.schema.json';

function schemaPathOf(name) {
  return path.join(__dirname, '../../schema', name);
}

/**
 * 构建完整档案包（ZIP Buffer + manifest）。
 * @param {object} profile 档案对象
 * @param {object} [opts] { password?, time?, sensitivity? }
 * @returns {{zip: Buffer, manifest: object, files: object[]}}
 */
function buildPackage(profile, opts = {}) {
  const now = opts.time || new Date();
  const files = [];
  let encryptionDecl;
  let profilePath;

  const profileJson = JSON.stringify(profile, null, 2);

  if (opts.password) {
    const blob = encrypt.encryptObject(profile, opts.password);
    profilePath = 'data/profile.enc';
    files.push({ path: profilePath, data: JSON.stringify(blob, null, 2) });
    encryptionDecl = {
      enabled: true,
      algorithm: 'AES-256-GCM',
      key_derivation: 'PBKDF2-HMAC-SHA256',
      kdf_params: { iterations: blob.iterations, salt_b64: blob.salt_b64, iv_b64: blob.iv_b64 },
    };
  } else {
    profilePath = 'data/profile.json';
    files.push({ path: profilePath, data: profileJson });
    encryptionDecl = {
      enabled: false,
      algorithm: 'AES-256-GCM',
      key_derivation: 'PBKDF2-HMAC-SHA256',
      kdf_params: {
        iterations: encrypt.DEFAULT_ITERATIONS,
        salt_b64: encrypt.generateSalt().toString('base64'),
        iv_b64: encrypt.generateIv().toString('base64'),
      },
    };
  }

  // 人读摘要（.md）
  const md = summary.renderAll(profile);
  for (const [name, content] of Object.entries(md)) {
    files.push({ path: name, data: content });
  }

  // 随包 schema（离线校验用）
  files.push({ path: 'data/schema.json', data: fs.readFileSync(schemaPathOf('profile.schema.json'), 'utf8') });

  // 计算 checksum（manifest 自身不参与）
  const checksumFiles = {};
  for (const f of files) {
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    checksumFiles[f.path] = { sha256: verify.sha256Buf(raw), size: raw.length };
  }

  const sensitivity = opts.sensitivity || {
    public: ['identity.persona', 'identity.tone', 'preferences.output_style'],
    private: ['evidence.habits', 'evidence.schedule', 'evidence.common_software', 'evidence.artifacts'],
    secret: ['evidence.timeline.location', 'evidence.timeline.note'],
  };

  const manifest = {
    format_version: '1.0',
    manifest_version: '1.0',
    schema_version: profile.schema_version || '1.0.0',
    generated_at: naming.utcNow(now),
    profile_id: profile.meta.profile_id,
    profile_revision: profile.meta.profile_revision,
    base_revision: profile.meta.base_revision,
    checksum: { algorithm: 'sha256', files: checksumFiles },
    entries: files.map((f) => ({
      path: f.path,
      role: roleOf(f.path),
      ...(f.path === profilePath ? { schema_ref: PROFILE_SCHEMA_URL } : {}),
      size: Buffer.isBuffer(f.data) ? f.data.length : Buffer.byteLength(String(f.data), 'utf8'),
    })),
    encryption: encryptionDecl,
    sensitivity,
    source: {
      source_device: profile.meta.source_device,
      naming: { scheme: 'timestamp+host-hash+user', anonymous: true, custom_name: null },
    },
  };

  files.push({ path: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
  const { buffer } = packArchive(files, { time: now });
  return { zip: buffer, manifest, files };
}

/**
 * 读取并校验档案包。
 * @param {Buffer} zipBuffer
 * @param {object} [opts] { password? }
 * @returns {{manifest, profile, files: Map, checksumOk: boolean, profileSchema: {ok,errors}}}
 */
function readPackage(zipBuffer, opts = {}) {
  const files = unpackArchive(zipBuffer);

  const manifestBuf = files.get('manifest.json');
  if (!manifestBuf) throw new Error('archive: missing manifest.json');
  const manifest = JSON.parse(manifestBuf.toString('utf8'));

  const manifestSchema = JSON.parse(fs.readFileSync(schemaPathOf('manifest.schema.json'), 'utf8'));
  const mv = verify.validate(manifestSchema, manifest);
  if (!mv.ok) throw new Error('archive: manifest schema invalid: ' + mv.errors.join('; '));

  const contents = {};
  for (const [k, v] of files) contents[k] = v;
  const ck = verify.verifyChecksums(manifest.checksum, contents);
  if (!ck.ok) throw new Error('archive: checksum failed: ' + ck.errors.join('; '));

  let profile;
  if (manifest.encryption && manifest.encryption.enabled) {
    if (!opts.password) throw new Error('archive: package is encrypted, password required');
    const encEntry = manifest.entries.find((e) => e.path.startsWith('data/profile.') && e.path.endsWith('.enc'));
    const encName = encEntry ? encEntry.path : 'data/profile.enc';
    const blobBuf = files.get(encName);
    if (!blobBuf) throw new Error(`archive: missing encrypted payload "${encName}"`);
    profile = encrypt.decryptObject(JSON.parse(blobBuf.toString('utf8')), opts.password);
  } else {
    const pj = files.get('data/profile.json');
    if (!pj) throw new Error('archive: missing data/profile.json');
    profile = JSON.parse(pj.toString('utf8'));
  }

  const profileSchema = JSON.parse(fs.readFileSync(schemaPathOf('profile.schema.json'), 'utf8'));
  const pv = verify.validate(profileSchema, profile);
  return { manifest, profile, files, checksumOk: ck.ok, profileSchema: pv };
}

module.exports = {
  // 底层
  crc32,
  packArchive,
  unpackArchive,
  dosDateTime,
  SIG_LOCAL, SIG_CENTRAL, SIG_EOCD, METHOD_STORE, METHOD_DEFLATE,
  // 高层
  buildPackage,
  readPackage,
  roleOf,
};
