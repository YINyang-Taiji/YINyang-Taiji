'use strict';
/**
 * 校验模块（P1）：SHA-256 完整性 + JSON Schema 结构校验。
 * 零外部依赖（Schema 校验用轻量内置实现，避免运行时引入 Ajv 依赖）。
 */
const crypto = require('crypto');
const path = require('path');

/** 计算字符串 SHA-256 十六进制。 */
function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/** 计算 Buffer SHA-256 十六进制。 */
function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 校验 manifest.checksum.files 是否与提供的文件内容一致。
 * @param {object} checksum {algorithm:'sha256', files:{path:{sha256,size}}}
 * @param {object} fileContents {path: Buffer|string}
 * @returns {{ok:boolean, errors:string[]}}
 */
function verifyChecksums(checksum, fileContents) {
  const errors = [];
  if (!checksum || checksum.algorithm !== 'sha256') {
    return { ok: false, errors: ['verify: checksum.algorithm must be sha256'] };
  }
  for (const [p, expect] of Object.entries(checksum.files)) {
    const buf = fileContents[p];
    if (buf === undefined) { errors.push(`verify: missing file ${p}`); continue; }
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
    if (b.length !== expect.size) errors.push(`verify: size mismatch for ${p}`);
    if (sha256Buf(b) !== expect.sha256) errors.push(`verify: sha256 mismatch for ${p}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 轻量 JSON Schema 校验器（内置，支持本工具 schema 用到的子集）。
 * 支持：type, required, properties, additionalProperties, items, enum,
 *       const, minimum, maximum, minLength, maxLength, pattern, format, $ref(#/$defs)。
 * @param {object} schema
 * @param {any} data
 * @returns {{ok:boolean, errors:string[]}}
 */
function validate(schema, data) {
  const errors = [];
  const defs = schema.$defs || {};
  walk(schema, data, '#', errors, defs);
  return { ok: errors.length === 0, errors };
}

function walk(schema, data, path, errors, defs) {
  if (!schema) return;
  // $ref 解引用
  if (schema.$ref) {
    const ref = schema.$ref;
    const key = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : null;
    if (key && defs[key]) { walk(defs[key], data, path, errors, defs); return; }
  }
  // oneOf / anyOf：任一子 schema 通过即可
  const union = schema.oneOf || schema.anyOf;
  if (Array.isArray(union)) {
    const ok = union.some((sub) => {
      const subErrors = [];
      walk(sub, data, path, subErrors, defs);
      return subErrors.length === 0;
    });
    if (!ok) errors.push(`${path}: does not match any ${schema.oneOf ? 'oneOf' : 'anyOf'} branch`);
    return;
  }
  const type = schema.type;
  if (type) {
    if (Array.isArray(type)) {
      if (!type.some((t) => matchesType(t, data))) { errors.push(`${path}: expected one of ${type.join('|')}`); return; }
    } else if (!matchesType(type, data)) {
      errors.push(`${path}: expected ${type}, got ${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data}`);
      return;
    }
  }
  if (type === 'string' && typeof data === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(data)) errors.push(`${path}: pattern mismatch`);
    if (typeof schema.minLength === 'number' && data.length < schema.minLength) errors.push(`${path}: minLength`);
    if (typeof schema.maxLength === 'number' && data.length > schema.maxLength) errors.push(`${path}: maxLength`);
    if (schema.format === 'date-time' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(data)) errors.push(`${path}: not a date-time`);
  }
  if (typeof data === 'number') {
    if (typeof schema.minimum === 'number' && data < schema.minimum) errors.push(`${path}: below minimum`);
    if (typeof schema.maximum === 'number' && data > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (schema.const !== undefined && JSON.stringify(data) !== JSON.stringify(schema.const)) errors.push(`${path}: const mismatch`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(data))) errors.push(`${path}: not in enum`);

  if (isObj(data)) {
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (!(r in data)) errors.push(`${path}.${r}: missing required`);
      }
    }
    if (isObj(schema.properties)) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in data) walk(sub, data[k], `${path}.${k}`, errors, defs);
      }
    }
    if (schema.additionalProperties === false && isObj(schema.properties)) {
      for (const k of Object.keys(data)) {
        if (!(k in schema.properties)) errors.push(`${path}.${k}: additional property not allowed`);
      }
    }
  } else if (Array.isArray(data) && isObj(schema.items)) {
    data.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, errors, defs));
  }
}

function matchesType(t, data) {
  switch (t) {
    case 'object': return isObj(data);
    case 'array': return Array.isArray(data);
    case 'string': return typeof data === 'string';
    case 'number': return typeof data === 'number';
    case 'integer': return Number.isInteger(data);
    case 'boolean': return typeof data === 'boolean';
    case 'null': return data === null;
    default: return true;
  }
}
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** 防止路径穿越：校验相对路径不以 / 开头、不含 ..、无盘符。 */
function safeRelPath(p) {
  if (typeof p !== 'string' || p.startsWith('/') || p.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  const segs = p.split('/');
  if (segs.some((s) => s === '..' || s === '' && segs.length > 1)) return false;
  return true;
}

module.exports = {
  sha256Hex,
  sha256Buf,
  verifyChecksums,
  validate,
  safeRelPath,
};
