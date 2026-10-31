'use strict';
/**
 * AI 个人档案核心库 —— 聚合导出。
 */
module.exports = {
  encrypt: require('./lib/encrypt'),
  naming: require('./lib/naming'),
  confidence: require('./lib/confidence'),
  merge: require('./lib/merge'),
  verify: require('./lib/verify'),
  profile: require('./lib/profile'),
  adapters: require('./lib/adapters'),
  summary: require('./lib/summary'),
  archive: require('./lib/archive'),
  observe: require('./lib/observe'),
};
