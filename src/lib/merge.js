'use strict';
/**
 * 三方字段级合并 + 冲突仲裁（P0-4）。
 * 纯逻辑，零外部依赖。
 * 合并按叶子字段进行，绝不做整文件覆盖；冲突不静默覆盖。
 */

/** 判断是否为普通对象（非数组、非 null）。 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 获取对象上某点路径的值。
 * @param {object} obj 根对象
 * @param {string[]} path 路径数组
 * @returns {any} 值或 undefined
 */
function getPath(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (cur == null || !isPlainObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * 收集对象所有叶子路径。
 * @param {object} obj
 * @param {string[]} [prefix]
 * @param {Set} [out]
 * @returns {string[]} 点号路径数组
 */
function leafPaths(obj, prefix = [], out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const path = [...prefix, k];
    if (isPlainObject(v)) {
      leafPaths(v, path, out);
    } else {
      out.add(path.join('.'));
    }
  }
  return [...out];
}

/**
 * 设置对象上某路径的值（深拷贝分支）。
 * @param {object} obj 目标（会被修改）
 * @param {string[]} path
 * @param {any} value
 */
function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isPlainObject(cur[path[i]])) cur[path[i]] = {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
}

/** 深度克隆（JSON 安全）。 */
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * 三方字段级合并。
 * @param {object} base 共同祖先（三方合并基准）
 * @param {object} left 分支 A
 * @param {object} right 分支 B
 * @returns {{result: object, conflicts: Array<{path:string, left:any, right:any}>}}
 */
function merge3(base, left, right) {
  const result = clone(base);
  const conflicts = [];
  // 收集三方所有叶子路径
  const paths = new Set([
    ...leafPaths(base), ...leafPaths(left), ...leafPaths(right),
  ]);
  for (const p of paths) {
    const seg = p.split('.');
    const b = getPath(base, seg);
    const l = getPath(left, seg);
    const r = getPath(right, seg);
    const lChanged = JSON.stringify(l) !== JSON.stringify(b);
    const rChanged = JSON.stringify(r) !== JSON.stringify(b);
    if (!lChanged && !rChanged) continue;         // 都没改
    if (lChanged && !rChanged) setPath(result, seg, clone(l)); // 仅左改
    else if (!lChanged && rChanged) setPath(result, seg, clone(r)); // 仅右改
    else {
      // 都改且相同 → 取左；不同 → 冲突
      if (JSON.stringify(l) === JSON.stringify(r)) setPath(result, seg, clone(l));
      else conflicts.push({ path: p, left: clone(l), right: clone(r) });
    }
  }
  return { result, conflicts };
}

/**
 * 冲突仲裁：按 (confidence, last_validated, 来源设备) 取高者。
 * 若无法判定（缺少 confidence 等）返回 null，表示需人工处理。
 * @param {object} base 基准值
 * @param {object} left 左值（含可选 confidence/last_validated/source）
 * @param {object} right 右值
 * @returns {{winner:'left'|'right', value:any}|null}
 */
function arbitrate(base, left, right) {
  const lConf = typeof left?.confidence === 'number' ? left.confidence : -1;
  const rConf = typeof right?.confidence === 'number' ? right.confidence : -1;
  const lTime = left?.last_validated ? Date.parse(left.last_validated) : 0;
  const rTime = right?.last_validated ? Date.parse(right.last_validated) : 0;
  // 优先级：置信度 > 时间 > 来源（来源仅作 tie-break，这里不比较字符串）
  if (lConf !== rConf) return lConf > rConf ? { winner: 'left', value: clone(left) } : { winner: 'right', value: clone(right) };
  if (lTime !== rTime) return lTime > rTime ? { winner: 'left', value: clone(left) } : { winner: 'right', value: clone(right) };
  // 完全不可判定 → 人工
  return null;
}

/**
 * 带仲裁的完整合并：先 merge3，再对每个冲突尝试 arbitrate；
 * 无法仲裁的仍留在 conflicts（供人工处理），绝不静默覆盖。
 * @returns {{result, conflicts, resolved:Array}}
 */
function mergeWithArbitration(base, left, right) {
  const { result, conflicts } = merge3(base, left, right);
  const resolved = [];
  const unresolved = [];
  for (const c of conflicts) {
    const seg = c.path.split('.');
    const arb = arbitrate(getPath(base, seg), c.left, c.right);
    if (arb) {
      setPath(result, seg, arb.value);
      resolved.push({ path: c.path, winner: arb.winner });
    } else {
      unresolved.push(c);
    }
  }
  return { result, conflicts: unresolved, resolved };
}

module.exports = {
  merge3,
  arbitrate,
  mergeWithArbitration,
  leafPaths,
  getPath,
  setPath,
  clone,
  isPlainObject,
};
