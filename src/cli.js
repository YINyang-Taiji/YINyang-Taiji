'use strict';
/**
 * CLI 入口（零外部依赖）。
 * 用法示例：
 *   node src/cli.js init --timezone Asia/Shanghai
 *   node src/cli.js export -o out.zip --password ***
 *   node src/cli.js verify <zip>
 *   node src/cli.js merge A.zip B.zip --dry-run
 *   node src/cli.js load --adapter openai-chatgpt
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
  encrypt, naming, confidence, merge, verify, profile, adapters, archive, observe,
} = require('./index');

function usage() {
  console.log(`AI 个人档案 CLI

用法:
  node src/cli.js init [--timezone TZ] [--named]
  node src/cli.js show
  node src/cli.js update [--manual]
  node src/cli.js edit <路径> <值>   （自定义项可修改/输入，例：edit identity.persona.primary_role "数据分析专家AI"）
  node src/cli.js observe [--root <workbuddy根>] [--timezone TZ] [--sessions <dir|off>]
  node src/cli.js export -o <zip> [--password P]
  node src/cli.js import <zip> [--dry-run|--yes] [--password P]
  node src/cli.js verify <zip>
  node src/cli.js merge A.zip B.zip [--dry-run]
  node src/cli.js rollback --to <rev>
  node src/cli.js load --adapter <id>
  node src/cli.js adapters list
`);
}

function saltFile() {
  return path.join(process.env.DSH_HOME || os.homedir(), 'ai-profile', 'salt');
}
function getSalt() {
  const f = saltFile();
  if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  const s = crypto.randomBytes(16);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s.toString('hex'));
  return s;
}

function profileDir() {
  return path.join(process.env.DSH_HOME || os.homedir(), 'ai-profile', 'profiles');
}

function getProfile() {
  return profile.loadProfile(profileDir());
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init': {
      const tz = rest.includes('--timezone') ? rest[rest.indexOf('--timezone') + 1] : 'UTC';
      const named = rest.includes('--named');
      const salt = getSalt();
      const username = named ? (os.userInfo().username || 'user') : 'anon';
      const p = profile.createProfile({
        profile_id: naming.anonymousId(os.userInfo().username || 'user', salt, 16),
        source_device: naming.hostHash(os.hostname(), salt, 12),
        timezone: tz,
      });
      profile.saveProfile(p, profileDir());
      console.log(`初始化完成：profile_revision=${p.meta.profile_revision}，匿名=${!named}`);
      return;
    }
    case 'show': {
      const p = getProfile();
      if (!p) { console.log('尚无档案，先运行 init'); return; }
      console.log(JSON.stringify(p, null, 2));
      return;
    }
    case 'edit': {
      // 自定义项可修改/输入：node src/cli.js edit <点路径> <值>
      // 例：edit identity.persona.primary_role "数据分析专家AI"
      //     edit preferences.output_style.verbosity detailed
      //     edit evidence.habits.0.value "每周复盘"
      const pathStr = rest[0];
      if (!pathStr) { console.log('edit 需要 <路径> <值>，例：edit identity.tone.default "正式、简洁"'); return; }
      const valStr = rest.slice(1).join(' ');
      const p = getProfile();
      if (!p) { console.log('尚无档案，先运行 init'); return; }
      // 解析值：JSON/布尔/数字/字符串
      const jv = valStr.trim();
      let val;
      if (jv === 'true') val = true;
      else if (jv === 'false') val = false;
      else if (jv === 'null') val = null;
      else if (/^-?\d+(\.\d+)?$/.test(jv)) val = Number(jv);
      else if (jv.startsWith('{') || jv.startsWith('[') || jv.startsWith('"')) { try { val = JSON.parse(jv); } catch { val = valStr; } }
      else val = valStr;
      // 沿点路径写入（支持数组索引 [n]）
      const parts = pathStr.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
      let obj = p;
      for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (obj[k] == null) obj[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
        obj = obj[k];
      }
      const last = parts[parts.length - 1];
      const prev = obj[last];
      obj[last] = val;
      // Schema 校验（不合规则回滚并提示）
      const vr = profile.validateProfile(p);
      if (vr && vr.ok === false) {
        obj[last] = prev;
        console.log(`编辑被拒绝：${pathStr} 不符合 Schema —— ${(vr.errors || []).map((e) => e.message || JSON.stringify(e)).join('；')}`);
        process.exitCode = 1;
        return;
      }
      let next = profile.bumpRevision(p);
      profile.saveProfile(next, profileDir());
      console.log(`已编辑 ${pathStr} => ${JSON.stringify(val)}（revision=${next.meta.profile_revision}）`);
      return;
    }
    case 'update': {
      const p = getProfile();
      if (!p) { console.log('尚无档案，先运行 init'); return; }
      // 仅做新鲜度刷新 + 版本自增（示意）
      let next = profile.refreshFreshness(p);
      next = profile.bumpRevision(next);
      profile.saveProfile(next, profileDir());
      console.log(`更新完成：revision=${next.meta.profile_revision}，freshness=${next.meta.freshness.status}`);
      return;
    }
    case 'observe': {
      const p = getProfile();
      if (!p) { console.log('尚无档案，先运行 init'); return; }
      const ri = rest.indexOf('--root');
      const root = ri >= 0 ? rest[ri + 1] : null;
      const ti = rest.indexOf('--timezone');
      const tz = ti >= 0 ? rest[ti + 1] : null;
      const si = rest.indexOf('--sessions');
      const sessions = si >= 0 ? (rest[si + 1] || 'true') : undefined;
      const opts = { root: root || undefined, timezone: tz || undefined };
      if (sessions === 'false' || sessions === 'off') opts.includeSessions = false;
      else if (sessions && sessions !== 'true') opts.sessionsRoot = sessions;
      const res = observe.observe(p, opts);
      console.log(`观察完成：来源=${res.sources.root}`);
      console.log(`  USER=${!!res.sources.user}  SOUL=${!!res.sources.soul}  IDENTITY=${!!res.sources.identity}  MEMORY=${!!res.sources.memory}  项目记忆=${res.sources.projectMemories.length} 文件`);
      if (res.sessions) {
        const pk = res.sessions.peakFocus.map((x) => x.start + '–' + x.end).join('、') || '无';
        const slp = res.sessions.sleepWindow ? res.sessions.sleepWindow.start + '–' + res.sessions.sleepWindow.end : '无';
        console.log(`  会话样本=${res.sessions.total} ｜ 高峰=${pk} ｜ 睡眠=${slp}`);
      }
      console.log(`  应用=${res.applied}，置信度门拦截=${res.gated}`);
      console.log(`  人格=${res.profile.identity.persona.primary_role} ｜ 语气=${res.profile.identity.tone.default}`);
      console.log(`  红线=${res.profile.identity.guardrails.length} ｜ AI要求=${res.profile.preferences.ai_requirements.length} ｜ 软件=${res.profile.evidence.common_software.length} ｜ 习惯=${res.profile.evidence.habits.length} ｜ 时段=${res.profile.evidence.schedule.work_hours.length}`);
      const next = profile.bumpRevision(profile.refreshFreshness(res.profile));
      profile.saveProfile(next, profileDir());
      console.log(`已保存：revision=${next.meta.profile_revision}，freshness=${next.meta.freshness.status}`);
      return;
    }
    case 'export': {
      const p = getProfile();
      if (!p) { console.log('尚无档案，先运行 init'); return; }
      const oi = rest.indexOf('-o');
      const pw = rest.includes('--password') ? rest[rest.indexOf('--password') + 1] : null;
      const out = oi >= 0 ? rest[oi + 1] : null;
      const salt = getSalt();
      const final = out || naming.defaultFileName({
        username: os.userInfo().username || 'user', hostname: os.hostname(), salt,
      });
      // 真实 ZIP：manifest + data/profile.json + .md 摘要 + 随包 schema
      const { zip, manifest } = archive.buildPackage(p, { password: pw || undefined });
      fs.mkdirSync(path.dirname(path.resolve(final)), { recursive: true });
      fs.writeFileSync(final, zip);
      console.log(`已导出：${final}（真 ZIP，${zip.length} 字节，文件数=${manifest.entries.length}，加密=${!!pw}）`);
      return;
    }
    case 'verify': {
      const f = rest[0];
      if (!f) { console.log('verify 需要 <zip>'); return; }
      const pw = rest.includes('--password') ? rest[rest.indexOf('--password') + 1] : null;
      try {
        const r = archive.readPackage(fs.readFileSync(f), { password: pw || undefined });
        console.log(`verify：${f} => 通过`);
        console.log(`  revision=${r.manifest.profile_revision}，profile_id=${r.manifest.profile_id}`);
        console.log(`  加密=${r.manifest.encryption.enabled}，文件数=${r.manifest.entries.length}，checksum=${r.checksumOk ? 'OK' : 'FAIL'}`);
        console.log(`  profile Schema=${r.profileSchema.ok ? 'OK' : 'FAIL'}`);
      } catch (e) {
        console.log(`verify：${f} => 失败：${e.message}`);
        process.exitCode = 1;
      }
      return;
    }
    case 'import': {
      const f = rest[0];
      if (!f) { console.log('import 需要 <zip>'); return; }
      const dry = rest.includes('--dry-run');
      const yes = rest.includes('--yes');
      const pw = rest.includes('--password') ? rest[rest.indexOf('--password') + 1] : null;
      let r;
      try {
        r = archive.readPackage(fs.readFileSync(f), { password: pw || undefined });
      } catch (e) {
        console.log(`导入失败：${e.message}`);
        process.exitCode = 1;
        return;
      }
      const incoming = r.profile;
      const local = getProfile();
      if (!local) {
        if (dry) {
          console.log(`[dry-run] 将导入新档案：revision=${incoming.meta.profile_revision}，profile_id=${incoming.meta.profile_id}`);
          return;
        }
        profile.saveProfile(incoming, profileDir());
        console.log(`已导入新档案：revision=${incoming.meta.profile_revision}，profile_id=${incoming.meta.profile_id}`);
        return;
      }
      const ff = incoming.meta.base_revision === local.meta.profile_revision;
      console.log(`${dry ? '[dry-run] ' : ''}导入包 revision=${incoming.meta.profile_revision}（base=${incoming.meta.base_revision}），本地 revision=${local.meta.profile_revision}${ff ? '（可直接快进）' : '（修订分叉）'}`);
      if (!ff && !yes) {
        console.log('非直接子修订，如需覆盖导入请加 --yes（会先快照当前档案）');
        if (dry) console.log('  [dry-run] 未写入任何内容');
        return;
      }
      if (dry) { console.log('  [dry-run] 未写入任何内容'); return; }
      // 快照当前档案
      const snapDir = path.join(process.env.DSH_HOME || os.homedir(), 'ai-profile', 'snapshots');
      fs.mkdirSync(snapDir, { recursive: true });
      fs.writeFileSync(path.join(snapDir, `${local.meta.profile_revision}.zip`), archive.buildPackage(local).zip);
      profile.saveProfile(incoming, profileDir());
      console.log(`导入完成：revision=${incoming.meta.profile_revision}（原档案已快照到 snapshots/${local.meta.profile_revision}.zip）`);
      return;
    }
    case 'merge': {
      const a = rest[0], b = rest[1];
      if (!a || !b) { console.log('merge 需要 A.zip B.zip'); return; }
      const dry = rest.includes('--dry-run');
      const ra = archive.readPackage(fs.readFileSync(a));
      const rb = archive.readPackage(fs.readFileSync(b));
      const base = { ...ra.profile, meta: { ...ra.profile.meta } };
      const m = merge.mergeWithArbitration(base, ra.profile, rb.profile);
      console.log(`合并${dry ? '(dry-run)' : ''}：冲突=${m.conflicts.length}，已仲裁=${m.resolved.length}`);
      if (m.conflicts.length) console.log('  未决冲突：' + m.conflicts.map((c) => c.path).join(', '));
      if (!dry) {
        const oi = rest.indexOf('-o');
        if (oi >= 0) {
          const out = rest[oi + 1];
          fs.writeFileSync(out, archive.buildPackage(m.result).zip);
          console.log('已写出合并包：' + out);
        }
      }
      return;
    }
    case 'load': {
      const ai = rest.indexOf('--adapter');
      const adapterId = ai >= 0 ? rest[ai + 1] : 'generic';
      const p = getProfile();
      if (!p) { console.log('尚无档案，先运行 init'); return; }
      const caps = { platform: 'chatgpt', supportsVision: false, supportsTools: true, supportsLongContext: true, systemPromptStyle: 'openai' };
      const { plan, blocks } = adapters.renderForPlatform(p, adapterId, caps);
      console.log(`适配器=${adapterId}，消费字段=${plan.consume.length}，裁剪=${plan.drop.join(',') || '无'}`);
      blocks.forEach((b) => console.log(`\n[${b.role}]\n${b.content}`));
      return;
    }
    case 'adapters': {
      if (rest[0] === 'list') {
        Object.values(adapters.ADAPTERS).forEach((a) => console.log(`${a.id}\t${a.platform}\t${a.name}`));
      }
      return;
    }
    default:
      usage();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
}

module.exports = { main };
