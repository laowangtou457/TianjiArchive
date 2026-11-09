#!/usr/bin/env node
'use strict';
/**
 * QA 独立验证脚本 —— P0 文件链路（SeaweedFS 方案 A / minio@8 → S3 Gateway）
 *
 * 规格与判据：docs/QA-FILE-PIPELINE-PLAN.md（唯一权威口径）
 * 入口：node scripts/qa-file-pipeline-verify.cjs --suite core
 *      node scripts/qa-file-pipeline-verify.cjs --self-test
 *      node scripts/qa-file-pipeline-verify.cjs --suite full --large-mb 2048
 *
 * 纪律（与方案 §0 一致，不可删）：
 *  1. apps/api/__tests__/storage.minio-contract.spec.ts:4-8 不发网络请求，只证 SDK 方法存在；
 *     本脚本不以它的绿色作为任何一条 wire 兼容性的证据。
 *  2. 「脚本存在」≠「验证通过」；「--self-test 全绿」≠「服务兼容」。
 *     self-test 只证明判据引擎不假绿，不产生任何验收结论。
 *  3. 全部走真实 wire（真实 S3 网关 + minio@8 SDK 调用序列 + 原生 HTTP 模拟浏览器），
 *     禁止只用 mock；本脚本不 import 被测 storage.module.ts，避免替身陷阱。
 *
 * fail-closed：当前 suite 声明的检查点全部 status==='PASS' 才 IS_PASS: YES。
 *   任一 FAIL/ERROR/BLOCKED/NOT_RUN、未跑、工具异常、日志写入失败、配置缺失 → IS_PASS: NO。
 *   退出码 0=YES / 1=NO / 2=脚本自身不可用。
 *
 * 日志：docs/perf/runs/qa-file-pipeline-<tag>-<UTC>.log（LF；.gitignore:46 已开白名单）
 *      stdout 与日志绝不输出 accessKey / secretKey（架构 §5.2 红线），并有兜底脱敏。
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const { Readable } = require('node:stream');
const { URL } = require('node:url');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(REPO_ROOT, 'docs', 'perf', 'runs');
const PART_SIZE = 5 * 1024 * 1024; // CHUNK_SIZE=5MB（packages/shared/src/enums.ts:572-574）

// ---------------------------------------------------------------- CLI / 配置

const ARGV = process.argv.slice(2);
const hasFlag = (f) => ARGV.includes(f);
function opt(name, def) {
  const i = ARGV.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i < 0) return def;
  const a = ARGV[i];
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  const next = ARGV[i + 1];
  return next !== undefined && !String(next).startsWith('--') ? next : def;
}

const SELF_TEST = hasFlag('--self-test');
const SUITE = opt('--suite', 'core'); // core | full
const TAG = opt('--tag', SELF_TEST ? 'self-test' : SUITE);
const LARGE_MB = Number(opt('--large-mb', '2048'));
const STREAM_MB = Number(opt('--stream-mb', '50'));
const TIMEOUT_MS = Number(opt('--timeout-ms', '8000'));
const ORIGIN_OPT = opt('--origin', '');

function readEnvFile(file) {
  const out = {};
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* .env 不存在是允许的，走环境变量/命令行 */ }
  return out;
}
const ENV_FILE = readEnvFile(opt('--env-file', path.join(REPO_ROOT, '.env')));
function cfg(key, def) {
  if (process.env[key] !== undefined) return process.env[key];
  if (ENV_FILE[key] !== undefined) return ENV_FILE[key];
  return def;
}
const bool = (v) => /^(1|true|yes|on)$/i.test(String(v));

const CFG = {
  internalEndpoint: opt('--internal-endpoint', cfg('S3_INTERNAL_ENDPOINT', '127.0.0.1')),
  internalPort: Number(opt('--internal-port', cfg('S3_INTERNAL_PORT', '8333'))),
  internalUseSSL: bool(cfg('S3_INTERNAL_USE_SSL', cfg('MINIO_USE_SSL', 'false'))),
  publicEndpoint: opt('--public-endpoint', cfg('S3_PUBLIC_ENDPOINT', '')),
  publicPort: Number(opt('--public-port', cfg('S3_PUBLIC_PORT', cfg('SEAWEEDFS_S3_EXPOSED_PORT', '8333')))),
  publicUseSSL: bool(opt('--public-ssl', cfg('S3_PUBLIC_USE_SSL', 'false'))),
  accessKey: cfg('S3_ACCESS_KEY', cfg('MINIO_ACCESS_KEY', '')),
  secretKey: cfg('S3_SECRET_KEY', cfg('MINIO_SECRET_KEY', '')),
  buckets: {
    original: cfg('S3_BUCKET_ORIGINAL', cfg('MINIO_BUCKET_ORIGINAL', 'archive-original')),
    preview: cfg('S3_BUCKET_PREVIEW', cfg('MINIO_BUCKET_PREVIEW', 'archive-preview')),
    thumb: cfg('S3_BUCKET_THUMB', cfg('MINIO_BUCKET_THUMB', 'archive-thumb')),
    backup: cfg('S3_BUCKET_BACKUP', cfg('MINIO_BUCKET_BACKUP', 'archive-backup')),
  },
  origin: ORIGIN_OPT || String(cfg('CORS_ORIGINS', 'http://localhost:8080')).split(',')[0].trim(),
};
const BUCKETS = Object.values(CFG.buckets);
const RUN_ID = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
const PREFIX = `qa-pipeline/${RUN_ID}`;
const STAMP = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
const LOG_PATH = path.join(RUNS_DIR, `qa-file-pipeline-${String(TAG).replace(/[^a-zA-Z0-9_-]/g, '_')}-${STAMP}.log`);
const relLog = () => path.relative(REPO_ROOT, LOG_PATH).split(path.sep).join('/');

const internalBase = `${CFG.internalUseSSL ? 'https' : 'http'}://${CFG.internalEndpoint}:${CFG.internalPort}`;
const publicBase = `${CFG.publicUseSSL ? 'https' : 'http'}://${CFG.publicEndpoint}:${CFG.publicPort}`;

// ---------------------------------------------------------------- 日志（脱敏）

let LOG_LINES = [];
function redact(s) {
  let t = String(s);
  for (const secret of [CFG.secretKey, CFG.accessKey]) {
    if (secret && secret.length >= 4) t = t.split(secret).join('***REDACTED***');
  }
  return t;
}
function out(line) {
  const safe = redact(line);
  LOG_LINES.push(safe);
  try { process.stdout.write(safe + '\n'); } catch { /* stdout 关闭不阻断 */ }
}
function flushLog() {
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    // 显式 '\n'；Node fs.writeFileSync 不做 CRLF 翻转（对比 Python io.open 的已知陷阱）
    fs.writeFileSync(LOG_PATH, LOG_LINES.join('\n') + '\n', { encoding: 'utf8' });
    return true;
  } catch (e) {
    try { process.stderr.write(`LOG_WRITE_FAILED: ${redact(e.message)}\n`); } catch { /* noop */ }
    return false;
  }
}

// ---------------------------------------------------------------- 判据引擎（纯函数，生产路径）

const CAUSE_PRIORITY = [
  'SERVICE_DOWN', 'BAD_CREDENTIALS', 'CONFIG_MISSING', 'TOOL_ERROR',
  'INCOMPATIBLE', 'ASSERTION_FAILED',
];
/**
 * 唯一裁决函数。--self-test 直接调用本函数（不另写一套），确保测的是生产判据。
 * 空清单必须判 NO —— 反假绿元断言。
 */
function computeVerdict(checks) {
  const total = Array.isArray(checks) ? checks.length : 0;
  const passed = checks.filter((c) => c && c.status === 'PASS').length;
  const bad = checks.filter((c) => !c || c.status !== 'PASS');
  const isPass = total > 0 && bad.length === 0;
  let primaryCause = null;
  if (!isPass) {
    for (const cause of CAUSE_PRIORITY) {
      if (bad.some((c) => c && c.cause === cause)) { primaryCause = cause; break; }
    }
    if (!primaryCause) primaryCause = 'ASSERTION_FAILED';
  }
  const byStatus = {};
  for (const c of checks) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  return {
    isPass, total, passed, failed: bad.length, primaryCause, byStatus,
    incomplete: bad.map((c) => `${c.id}:${c.status}${c.cause ? '/' + c.cause : ''}`),
  };
}

// ---------------------------------------------------------------- C08 效果判据（纯函数 + 静态守卫）

/**
 * C08 判据：`Access-Control-Expose-Headers` 是否让「浏览器能读到 ETag」这一**效果**成立。
 * 两种合法形态（2026-11-09 架构师对 SeaweedFS 3.79 的 6 组容器内只读实测，镜像 21425305e04b）：
 *   1) '*'         —— 3.79 内置全局 CORS middleware 零配置返回通配；按 CORS 规范，
 *                      credentials mode=omit 时 '*' 通配所有响应头（含 ETag）；
 *                      显式 credentials:include 时 '*' 被当作字面量，不暴露 ETag（见 C08_WILDCARD_PREMISE）。
 *   2) 显式 ETag   —— 逗号分隔列表中含 etag 字面项（大小写不敏感），任何 credentials mode 下都有效。
 * 3.79 无法配置成单列 ETag（PutBucketCors 501 / s3.json cors 段被忽略 / 无 exposeHeaders flag），
 * 故原实现只认字面量 etag 会**必然假红**，把正确实现误判为 INCOMPATIBLE。现改为效果判据。
 * 纯函数；--self-test 直接调用本函数（与 computeVerdict 同源，不另写一套），覆盖四形态。
 */
function exposesEtag(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === '*' || /(^|,)\s*etag\s*(,|$)/i.test(s);
}

// 声明式边界（复用 §2.5 D4_SCOPE=WIRE_ONLY 那套静态断言机制）：'*' 通配不得默认成立。
const C08_WILDCARD_PREMISE = 'C08_WILDCARD_PREMISE=CREDENTIALS_OMIT_REQUIRED'
  + '（\'*\' 通配仅在 credentials mode=omit 时成立；显式 credentials:include 时 \'*\' 被当字面量；静态源码核对不替代前端运行时配置验证）';

/** 纯函数：返回命中的 credentials 反例模式（带标签，便于定向核对可追溯）。self-test 直接调用做零 I/O 变异验证。 */
const C08_CREDENTIALS_PATTERNS = [
  { label: 'globalDefaults', re: /axios\.defaults\.withCredentials\s*=\s*true/i },
  { label: 'withCredentialsTrue', re: /\bwithCredentials\s*:\s*true/i },
  { label: 'credentialsInclude', re: /\bcredentials\s*:\s*['"`]include['"`]/i },
];
function credentialsPatternsHit(src) {
  return C08_CREDENTIALS_PATTERNS.filter((p) => p.re.test(String(src || '')));
}

/** 轻量括号配对：提取 `axios.create(` / `axios.put(` 的调用参数文本；找不到返回 null。 */
function callArgsText(src, expr) {
  const i = src.indexOf(expr);
  if (i < 0) return null;
  const open = src.indexOf('(', i + expr.length);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '(') depth += 1;
    else if (src[j] === ')') { depth -= 1; if (depth === 0) return src.slice(open + 1, j); }
  }
  return null;
}

/**
 * '*' 通配前提的静态源码守卫（主理人 2026-11-09 硬约束）：
 *   [兜底] 全目录扫描 axios.defaults.withCredentials=true / withCredentials:true / credentials:'include'；
 *   [定向] 三处可追溯核对 —— ① globalDefaults（axios.defaults 全局赋值）
 *          ② axiosCreateConfig（axios.create({...}) 配置对象，全局 defaults 的另一来源）
 *          ③ fileUploaderPut（FileUploader.tsx:104-108 的 axios.put(...) 参数块）。
 * 三态 CLEAN / HIT / N/A；找不到 create/put 记 N/A 而非 fail（前端可合法改用 fetch，兜底扫描仍覆盖）。
 * fail-closed：目录不可读 / 文件读不到 / FileUploader.tsx 缺失 / 任一处 HIT，一律 pass=false。
 * 边界：静态断言只证明「源码里没写」，不等价于运行时未设；C08 detail 仍声明
 *       「未独立验证前端运行时配置」并列入阶段二报告未验证项，**绝不默认成立**。
 * audit 保留结构化详情供 self-test 断言与阶段二复核；note 保持精简，避免被 emit 的 600 字截断。
 */
function credentialsOmitGuard(rootDir) {
  const root = rootDir || path.join(REPO_ROOT, 'apps', 'web', 'src');
  const files = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!walk(p)) return false; }
      else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) files.push(p);
    }
    return true;
  };
  const fail = (note) => ({ pass: false, scanned: files.length, hits: [], audit: null, note });
  const readable = fs.existsSync(root) && walk(root);
  if (!readable || files.length === 0) return fail(`前端源码不可读或无 .ts/.tsx 文件：${root}（fail-closed，不默认成立）`);
  const uploader = files.find((f) => /FileUploader\.tsx$/i.test(f));
  if (!uploader) return fail('FileUploader.tsx 未扫到，无法确认其 axios.put 未设 withCredentials（fail-closed）');

  const hits = [];
  const srcByFile = new Map();
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); }
    catch { return fail(`读取失败：${f}（fail-closed，不默认成立）`); }
    srcByFile.set(f, src);
    for (const p of credentialsPatternsHit(src)) hits.push(`${path.relative(root, f)} ~ [${p.label}] ${p.re.source}`);
  }

  // 定向核对三处：从「全目录隐式覆盖」升级为「可追溯定点证据」
  const audit = {
    globalDefaults: { status: 'CLEAN', evidence: `全目录 ${files.length} 文件未见 axios.defaults.withCredentials=true` },
    axiosCreateConfig: { status: 'N/A', evidence: '未发现 axios.create( 调用' },
    fileUploaderPut: { status: 'N/A', evidence: '未发现 axios.put( 调用（可合法改用 fetch，兜底扫描仍覆盖）' },
  };
  const globalDefHits = hits.filter((h) => h.includes('[globalDefaults]'));
  if (globalDefHits.length) audit.globalDefaults = { status: 'HIT', evidence: globalDefHits.join(' | ') };
  for (const [f, src] of srcByFile) {
    const args = callArgsText(src, 'axios.create');
    if (args === null) continue;
    const hit = credentialsPatternsHit(args);
    audit.axiosCreateConfig = hit.length
      ? { status: 'HIT', evidence: `${path.relative(root, f)} axios.create({...}) 命中 ${hit.map((p) => p.label).join(',')}` }
      : { status: 'CLEAN', evidence: `${path.relative(root, f)} axios.create({...}) 配置块未见 withCredentials:true / credentials:include` };
  }
  const putArgs = callArgsText(srcByFile.get(uploader) || '', 'axios.put');
  if (putArgs !== null) {
    const hit = credentialsPatternsHit(putArgs);
    audit.fileUploaderPut = hit.length
      ? { status: 'HIT', evidence: `FileUploader.tsx axios.put(...) 参数块命中 ${hit.map((p) => p.label).join(',')}` }
      : { status: 'CLEAN', evidence: 'FileUploader.tsx:104-108 axios.put(...) 参数块未见 withCredentials:true / credentials:include' };
  }

  const auditHits = Object.entries(audit).filter(([, v]) => v.status === 'HIT');
  const pass = hits.length === 0 && auditHits.length === 0;
  const brief = Object.entries(audit).map(([k, v]) => `${k}=${v.status}`).join('/');
  return {
    pass,
    scanned: files.length,
    hits,
    audit,
    note: pass
      ? `已扫 ${files.length} 个前端源码文件（含 FileUploader.tsx）；定向核对 ${brief}`
      : `命中 credentials 写法（'*' 前提被证伪）：${(hits.length ? hits : auditHits.map(([k, v]) => `${k}=${v.evidence}`)).join(' | ')}`,
  };
}

function classifyFailure(err, resp, group) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)
      || /timeout|socket hang up|连接超时/i.test(msg)) return 'SERVICE_DOWN';
  const status = resp && resp.statusCode;
  const body = String((resp && resp.bodyText) || msg);
  if (group === 'gate' || status === 403
      || /InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|InvalidSecurity|RequestTimeTooSkewed|Forbidden/i.test(body)) {
    if (/InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|InvalidSecurity|RequestTimeTooSkewed|Forbidden|403/i.test(body + ' ' + status)) {
      return 'BAD_CREDENTIALS';
    }
  }
  if (status === 501 || status === 405 || /NotImplemented|Not Implemented|Unsupported|MethodNotAllowed/i.test(body)) {
    return 'INCOMPATIBLE';
  }
  if (/MODULE_NOT_FOUND|SDK_LOAD|工具|工具异常/i.test(msg)) return 'TOOL_ERROR';
  return 'INCOMPATIBLE'; // 门禁通过后的兜底：唯一原因收敛到兼容层
}

// ---------------------------------------------------------------- 检查点清单（与方案 §3/§4/§5 一一对应）

const CHECK_DEFS = [
  { id: 'G0', group: 'gate', wire: '—', title: '服务可达（S3 网关 TCP + HTTP 200/403）' },
  { id: 'G1', group: 'gate', wire: '§4 #1', title: '凭据正确且鉴权生效（错误凭据 403 / 非 Allow-All）' },
  { id: 'G2', group: 'gate', wire: '§4 #1', title: '四桶存在（HeadBucket 全 200）' },
  { id: 'C01', group: 'wire', wire: '§4 #2', title: 'CreateBucket 幂等' },
  { id: 'C02', group: 'wire', wire: '§4 #3/#5', title: 'PutObject 自定义 meta + Content-Type 回读一致' },
  { id: 'C03', group: 'wire', wire: '§4 #4', title: 'GetObject 全量 + Range 206' },
  { id: 'C04', group: 'wire', wire: '§4 #5', title: 'statObject 大小与 computeSha256 一致' },
  { id: 'C05', group: 'wire', wire: '§4 #6', title: '整对象预签名 PUT（host 浏览器可达 + SigV4 + 过期 403）' },
  { id: 'C06', group: 'wire', wire: '§4 #7/#6', title: 'CreateMultipartUpload + ≥3 片预签名 PUT + ETag 回读' },
  { id: 'C07', group: 'wire', wire: '§4 #9', title: 'CompleteMultipartUpload + 合并后 SHA-256 比对 + 错 ETag 负向对照' },
  { id: 'C08', group: 'wire', wire: '§4 #9', title: 'CORS preflight + 浏览器可读 ETag（效果判据：Expose-Headers 为 * 或显式 ETag）' },
  { id: 'C09', group: 'wire', wire: '§4 #8', title: 'listParts 返回结构 {part,etag,size} 升序且数量匹配' },
  { id: 'C10', group: 'wire', wire: '§4 #10', title: 'AbortMultipartUpload（2 片后 abort → GET 404）' },
  { id: 'C11', group: 'wire', wire: '§4 #11', title: 'RemoveObject（删除后不存在）' },
  { id: 'C12', group: 'wire', wire: '§4 #12', title: 'CopyObject 跨桶 + 内容一致' },
  { id: 'C13', group: 'wire', wire: '§4 #13', title: 'ListObjectsV2 prefix 列举完整' },
  { id: 'C14', group: 'wire', wire: '§4 #14', title: 'Put/GetBucketLifecycleConfiguration（tmp/ 1 天规则回读）' },
  { id: 'C15', group: 'wire', wire: '§4 #6/#4', title: '预签名 GET + Range 206' },
  { id: 'C16', group: 'wire', wire: '§4 #3/#4/#5', title: '50MB 流式对象 SHA-256 重算比对' },
  { id: 'C18', group: 'wire', wire: 'D-4 / §4 #6', title: 'D-4 下载技术链路：presignGet 生产调用形态 + 浏览器可达 host + SHA-256 + Range（wire 层）' },
  { id: 'C17', group: 'wire', wire: '用例⑧', title: '2GB / 5MB 分片（410 片）边界（仅 full）' },
];
const checks = CHECK_DEFS
  .filter((d) => SUITE === 'full' || d.id !== 'C17')
  .map((d) => ({ ...d, status: 'NOT_RUN', cause: null, detail: '', ms: 0 }));
const C = (id) => checks.find((c) => c.id === id);

function emit(c) {
  out(JSON.stringify({
    type: 'check', id: c.id, group: c.group, wire: c.wire, title: c.title,
    status: c.status, cause: c.cause, detail: String(c.detail || '').slice(0, 600), ms: c.ms,
  }));
}
async function runCheck(id, fn) {
  const c = C(id);
  if (!c) return false;
  const t0 = Date.now();
  try {
    const r = await fn();
    c.status = r && r.ok ? 'PASS' : 'FAIL';
    c.cause = r && r.ok ? null : ((r && r.cause) || 'INCOMPATIBLE');
    c.detail = (r && r.detail) || '';
  } catch (e) {
    c.status = 'ERROR';
    c.cause = classifyFailure(e, null, c.group);
    c.detail = String((e && e.stack) || e);
  }
  c.ms = Date.now() - t0;
  emit(c);
  return c.status === 'PASS';
}
function markRemainingBlocked(cause, detail) {
  for (const c of checks) {
    if (c.status !== 'NOT_RUN') continue;
    c.status = 'BLOCKED';
    c.cause = cause;
    c.detail = detail;
    emit(c);
  }
}

// ---------------------------------------------------------------- 原生 HTTP / SigV4

function rawRequest(method, urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(Object.assign(new Error('BAD_URL:' + urlStr), { code: 'TOOL_ERROR' })); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({ host: u.host }, options.headers || {});
    const body = options.body || null;
    if (body && !headers['content-length'] && !headers['Content-Length']) {
      headers['content-length'] = String(body.length);
    }
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method, path: u.pathname + u.search, headers, timeout: options.timeoutMs || TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(Buffer.from(d)));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode, headers: res.headers,
          body: buf, bodyText: buf.toString('utf8'),
        });
      });
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('REQUEST_TIMEOUT'), { code: 'ETIMEDOUT' })); });
    req.on('error', (e) => reject(e));
    if (body) req.write(body);
    req.end();
  });
}

function uriEncode(str, encodeSlash = true) {
  return String(str).split('').map((ch) => {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) return ch;
    if (ch === '/' && !encodeSlash) return '/';
    return '%' + Buffer.from(ch, 'utf8').toString('hex').toUpperCase();
  }).join('');
}
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(String(data)).digest();

/** 构造 SigV4 Authorization header；date 可注入以便 self-test 做确定性验证 */
function buildAuthorization(opts) {
  const {
    method, urlStr, headers: extraHeaders = {}, body = Buffer.alloc(0),
    accessKey, secretKey, region = 'us-east-1', service = 's3', date,
  } = opts;
  const u = new URL(urlStr);
  const amzDate = date || new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  const canonicalQuery = Array.from(u.searchParams.entries())
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)))
    .map(([k, v]) => `${k}=${v}`).join('&');

  const signHeaders = { host: u.host.trim(), 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (extraHeaders['content-type']) signHeaders['content-type'] = String(extraHeaders['content-type']).trim();
  const signedKeys = Object.keys(signHeaders).sort();
  const canonicalHeaders = signedKeys.map((k) => `${k}:${String(signHeaders[k]).replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = signedKeys.join(';');

  const canonicalUri = u.pathname.split('/').map((seg, i) => (i === 0 ? '' : uriEncode(seg, false))).join('/') || '/';
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
  const kDate = hmac('AWS4' + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    headers: Object.assign({}, extraHeaders, {
      host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    }),
    canonicalRequest, stringToSign, scope,
  };
}

/** 带 SigV4 Authorization 的原生请求（内部端点；预签名 URL 不使用本函数） */
async function awsRequest(method, urlStr, options = {}) {
  const body = options.body || Buffer.alloc(0);
  const signed = buildAuthorization({
    method, urlStr, headers: options.headers || {}, body,
    accessKey: options.accessKey || CFG.accessKey,
    secretKey: options.secretKey || CFG.secretKey,
  });
  return rawRequest(method, urlStr, { headers: signed.headers, body: body.length ? body : null, timeoutMs: options.timeoutMs });
}

function tcpReachable(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
    sock.connect(Number(port), host);
  });
}

// ---------------------------------------------------------------- 共享工具 / 上下文

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const bucketUrl = (bucket, extra = '') => `${internalBase}/${bucket}${extra}`;
const objectUrl = (bucket, key) => `${internalBase}/${bucket}/${key}`;
const CTX = {
  Minio: null, internal: null, public: null,
  tempBucket: null, smallKey: null, smallBuf: null,
  partResponses: [], mergedKey: null, mergedBuf: null,
  listKeys: [], copyKey: null, streamKey: null, lifecycleBucket: null,
  createdKeys: [],
};
function key(name) { return `${PREFIX}/${name}`; }
function track(k) { CTX.createdKeys.push(k); return k; }

function makeClient(Minio, endpoint, port, useSSL, accessKey, secretKey) {
  return new Minio.Client({
    endPoint: endpoint, port: Number(port), useSSL: !!useSSL,
    accessKey, secretKey, region: 'us-east-1', pathStyle: true,
  });
}
async function sdkGetBuffer(client, bucket, k) {
  const stream = await client.getObject(bucket, k);
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}
async function sdkStreamSha256(client, bucket, k) {
  const stream = await client.getObject(bucket, k);
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const c of stream) { hash.update(c); size += c.length; }
  return { sha256: hash.digest('hex'), size };
}
/** 确定性分块生成：块首写入块序号以便检测错序；不整体驻留内存 */
async function* genChunks(total, chunkSize, seed) {
  let off = 0, idx = 0;
  while (off < total) {
    const n = Math.min(chunkSize, total - off);
    const buf = Buffer.allocUnsafe(n);
    buf.fill((seed + idx) & 0xff);
    if (n >= 4) buf.writeUInt32BE(idx & 0xffffffff, 0);
    yield buf;
    off += n; idx += 1;
  }
}
function makePartBuf(idx, size, seed) {
  const buf = Buffer.allocUnsafe(size);
  buf.fill((seed + idx) & 0xff);
  buf.writeUInt32BE(idx, 0);
  return buf;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function validateConfig() {
  const missing = [];
  if (!CFG.publicEndpoint) missing.push('S3_PUBLIC_ENDPOINT（预签名 URL 的浏览器可达 host，必需；缺失即双端点未落地）');
  if (!CFG.accessKey) missing.push('S3_ACCESS_KEY / MINIO_ACCESS_KEY');
  if (!CFG.secretKey) missing.push('S3_SECRET_KEY / MINIO_SECRET_KEY');
  if (!CFG.internalEndpoint) missing.push('S3_INTERNAL_ENDPOINT');
  if (!['core', 'full'].includes(SUITE)) missing.push(`--suite 非法: ${SUITE}`);
  for (const [k, v] of Object.entries(CFG.buckets)) if (!v) missing.push(`桶名 ${k}`);
  return missing;
}

// ---------------------------------------------------------------- 检查点实现

const IMPL = {
  G0: async () => {
    // 服务没起来：TCP + HTTP 双证据；200/403 与 docker-compose.yml:142 healthcheck 同口径
    const tcp = await tcpReachable(CFG.internalEndpoint, CFG.internalPort, TIMEOUT_MS);
    if (!tcp) return { ok: false, cause: 'SERVICE_DOWN', detail: `TCP 不可达 ${CFG.internalEndpoint}:${CFG.internalPort}` };
    const r = await rawRequest('GET', `${internalBase}/`, { timeoutMs: TIMEOUT_MS });
    const ok = [200, 403].includes(r.statusCode);
    return { ok, cause: ok ? null : 'SERVICE_DOWN', detail: `GET / → ${r.statusCode}; TCP=ok` };
  },

  G1: async () => {
    // 正向：合法凭据非 403；负向：错误凭据必须 403（或 S3 错误码），防 Allow-All
    const url = bucketUrl(BUCKETS[0]);
    const good = await awsRequest('HEAD', url);
    if (good.statusCode === 403) {
      return { ok: false, cause: 'BAD_CREDENTIALS', detail: `合法凭据收到 403；body=${good.bodyText.slice(0, 200)}` };
    }
    const bad = await awsRequest('HEAD', url, { secretKey: CFG.secretKey + '__QA_WRONG__' });
    const badBody = String(bad.headers['x-amz-error-code'] || '') + ' ' + bad.bodyText;
    const rejected = bad.statusCode === 403 || /InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|InvalidSecurity/i.test(badBody);
    if (!rejected) {
      return {
        ok: false, cause: 'BAD_CREDENTIALS',
        detail: `错误凭据未被拒绝（status=${bad.statusCode}）→ 疑似 Allow-All 模式（架构 §2.1 安全红线，必须注入 identity）`,
      };
    }
    return { ok: true, detail: `合法凭据 status=${good.statusCode}（非 403）；错误凭据 status=${bad.statusCode} 被拒` };
  },

  G2: async () => {
    const statuses = [];
    for (const b of BUCKETS) {
      const r = await awsRequest('HEAD', bucketUrl(b));
      statuses.push(`${b}=${r.statusCode}`);
      if (r.statusCode !== 200) {
        return { ok: false, cause: 'CONFIG_MISSING', detail: `四桶未齐：[${statuses.join(', ')}]；建桶责任未闭环（架构 §3.2）` };
      }
    }
    return { ok: true, detail: `四桶均 200：[${statuses.join(', ')}]` };
  },

  C01: async () => {
    const name = `qa-pipe-${RUN_ID.slice(-10).toLowerCase()}`;
    CTX.tempBucket = name;
    try { await CTX.internal.makeBucket(name, 'us-east-1'); }
    catch (e) { return { ok: false, cause: 'INCOMPATIBLE', detail: `首次 CreateBucket 失败：${e.message}` }; }
    let second = 'ok';
    try { await CTX.internal.makeBucket(name, 'us-east-1'); }
    catch (e) {
      if (/BucketAlreadyOwnedByYou|BucketAlreadyExists|ResourceConflict|already exists/i.test(e.message)) second = 'idempotent-error';
      else return { ok: false, cause: 'INCOMPATIBLE', detail: `重复 CreateBucket 非幂等：${e.message}` };
    }
    const exists = await CTX.internal.bucketExists(name).catch(() => false);
    if (!exists) return { ok: false, cause: 'INCOMPATIBLE', detail: '建桶后 HeadBucket 未命中' };
    return { ok: true, detail: `临时桶 ${name} 创建成功；二次调用=${second}；HeadBucket=true` };
  },

  C02: async () => {
    const k = track(key('C02-small.bin'));
    CTX.smallKey = k;
    const src = Buffer.from('QA-C02-海玑档案-' + 'x'.repeat(2048), 'utf8');
    CTX.smallBuf = src;
    const meta = { 'Content-Type': 'application/pdf', 'x-amz-meta-qa-case': 'C02' };
    await CTX.internal.putObject(BUCKETS[0], k, src, src.length, meta);
    const got = await sdkGetBuffer(CTX.internal, BUCKETS[0], k);
    if (!got.equals(src)) return { ok: false, cause: 'INCOMPATIBLE', detail: 'PUT 后 GET 字节不一致' };
    const stat = await CTX.internal.statObject(BUCKETS[0], k);
    if (stat.size !== src.length) return { ok: false, cause: 'INCOMPATIBLE', detail: `stat.size=${stat.size} 期望 ${src.length}` };
    const md = stat.metaData || {};
    const find = (needle) => Object.entries(md).find(([kk]) => kk.toLowerCase() === needle);
    const ct = find('content-type');
    const mv = find('x-amz-meta-qa-case');
    if (!ct || !String(ct[1]).includes('application/pdf')) {
      return { ok: false, cause: 'INCOMPATIBLE', detail: `Content-Type 回读异常：${JSON.stringify(md).slice(0, 300)}` };
    }
    if (!mv || String(mv[1]) !== 'C02') {
      return { ok: false, cause: 'INCOMPATIBLE', detail: `自定义 meta 回读异常：${JSON.stringify(md).slice(0, 300)}` };
    }
    return { ok: true, detail: `sha256=${sha256(src).slice(0, 16)}…；size=${stat.size}；Content-Type 与 x-amz-meta 回读一致` };
  },

  C03: async () => {
    const full = await sdkGetBuffer(CTX.internal, BUCKETS[0], CTX.smallKey);
    if (!full.equals(CTX.smallBuf)) return { ok: false, cause: 'INCOMPATIBLE', detail: '全量 GET 不一致' };
    const r = await awsRequest('GET', objectUrl(BUCKETS[0], CTX.smallKey), { headers: { range: 'bytes=0-1023' } });
    const expect = CTX.smallBuf.slice(0, 1024);
    const ok = r.statusCode === 206 && r.body.length === expect.length && r.body.equals(expect)
      && /bytes 0-1023\//.test(String(r.headers['content-range'] || ''));
    return {
      ok, cause: ok ? null : 'INCOMPATIBLE',
      detail: `Range → status=${r.statusCode}, len=${r.body.length}, content-range=${r.headers['content-range'] || '(缺失)'}`,
    };
  },

  C04: async () => {
    const stat = await CTX.internal.statObject(BUCKETS[0], CTX.smallKey);
    const s = await sdkStreamSha256(CTX.internal, BUCKETS[0], CTX.smallKey);
    const expect = sha256(CTX.smallBuf);
    const ok = stat.size === CTX.smallBuf.length && s.size === CTX.smallBuf.length && s.sha256 === expect;
    return {
      ok, cause: ok ? null : 'INCOMPATIBLE',
      detail: `stat.size=${stat.size}, stream.size=${s.size}, sha256=${s.sha256.slice(0, 16)}… / ${expect.slice(0, 16)}…`,
    };
  },

  C05: async () => {
    if (!CTX.public) return { ok: false, cause: 'TOOL_ERROR', detail: 'publicClient 未构造' };
    const k = track(key('C05-presign-put.bin'));
    const src = Buffer.from('QA-C05-presigned-put-' + 'y'.repeat(4096), 'utf8');
    const mime = 'application/octet-stream';
    const url = await CTX.public.presignedUrl('PUT', BUCKETS[0], k, 3600, { 'Content-Type': mime });
    const u = new URL(url);

    // 重点①：host 必须是浏览器可达的 S3_PUBLIC_ENDPOINT，不能是容器 DNS
    const hostOk = u.hostname === CFG.publicEndpoint && Number(u.port || (CFG.publicUseSSL ? 443 : 80)) === Number(CFG.publicPort);
    let reachable = false;
    try { await dns.lookup(u.hostname); reachable = await tcpReachable(u.hostname, u.port || (CFG.publicUseSSL ? 443 : 80), TIMEOUT_MS); }
    catch { reachable = false; }
    const containerDns = /^(seaweedfs|minio|s3|postgres|redis|elasticsearch)$/i.test(u.hostname) || (!u.hostname.includes('.') && u.hostname !== 'localhost');
    if (!hostOk || !reachable || containerDns) {
      return {
        ok: false, cause: containerDns || !hostOk ? 'CONFIG_MISSING' : 'INCOMPATIBLE',
        detail: `预签名 URL host 不可达：url.host=${u.host}, 期望=${CFG.publicEndpoint}:${CFG.publicPort}, hostOk=${hostOk}, reachable=${reachable}, 容器DNS=${containerDns}（架构 §1.2 双端点未落地/浏览器不可解析）`,
      };
    }

    const put = await rawRequest('PUT', url, { headers: { 'content-type': mime }, body: src });
    if (![200, 204].includes(put.statusCode)) {
      return { ok: false, cause: 'INCOMPATIBLE', detail: `预签名 PUT → ${put.statusCode}；body=${put.bodyText.slice(0, 200)}` };
    }
    const got = await sdkGetBuffer(CTX.internal, BUCKETS[0], k);
    if (!got.equals(src)) return { ok: false, cause: 'INCOMPATIBLE', detail: '预签名 PUT 后 GET 字节不一致' };

    // 过期语义：expires=1，等待 2s 后应 403
    const expK = track(key('C05-expired.bin'));
    const expUrl = await CTX.public.presignedUrl('PUT', BUCKETS[0], expK, 1);
    await sleep(2000);
    const expired = await rawRequest('PUT', expUrl, { headers: { 'content-type': mime }, body: Buffer.from('expired') });
    if (expired.statusCode !== 403) {
      return { ok: false, cause: 'INCOMPATIBLE', detail: `过期预签名 URL 未拒绝：status=${expired.statusCode}（期望 403）` };
    }
    return { ok: true, detail: `host=${u.host} 可达；PUT=${put.statusCode}；GET 一致；过期 URL=${expired.statusCode}` };
  },

  C06: async () => {
    if (!CTX.public) return { ok: false, cause: 'TOOL_ERROR', detail: 'publicClient 未构造' };
    const k = track(key('C06-multipart.bin'));
    const PART_COUNT = 3; // 重点②：硬断言 ≥3 片
    const uploadId = await CTX.internal.initiateNewMultipartUpload(BUCKETS[0], k, { 'Content-Type': 'application/octet-stream' });
    if (!uploadId) return { ok: false, cause: 'INCOMPATIBLE', detail: 'initiateNewMultipartUpload 返回空 uploadId' };
    const parts = [];
    const responses = [];
    const buffers = [];
    for (let i = 1; i <= PART_COUNT; i += 1) {
      const buf = makePartBuf(i, PART_SIZE, 17);
      buffers.push(buf);
      const url = await CTX.public.presignedUrl('PUT', BUCKETS[0], k, 3600, { uploadId, partNumber: String(i) });
      const u = new URL(url);
      if (u.hostname !== CFG.publicEndpoint) {
        return { ok: false, cause: 'CONFIG_MISSING', detail: `分片预签名 URL host=${u.host} 非 S3_PUBLIC_ENDPOINT` };
      }
      const res = await rawRequest('PUT', url, { headers: { 'content-type': 'application/octet-stream' }, body: buf, timeoutMs: 60000 });
      responses.push(res);
      if (![200, 204].includes(res.statusCode)) {
        return { ok: false, cause: 'INCOMPATIBLE', detail: `第 ${i} 片 PUT → ${res.statusCode}（uploadId/partNumber 的 SigV4 规范化可能不被接受）；body=${res.bodyText.slice(0, 200)}` };
      }
      // 重点③：复现 FileUploader.tsx:108 的 res.headers.etag 读取 + 去引号
      const raw = String(res.headers.etag || '').replace(/"/g, '');
      if (!raw) return { ok: false, cause: 'INCOMPATIBLE', detail: `第 ${i} 片响应无 ETag（浏览器读不到）` };
      parts.push({ part: i, etag: raw });
    }
    CTX.partResponses = responses;
    CTX.mergedKey = k;
    CTX.multipart = { uploadId, parts, buffers };
    CTX.mergedBuf = Buffer.concat(buffers);
    const ok = PART_COUNT >= 3 && parts.length === PART_COUNT;
    return {
      ok, cause: ok ? null : 'INCOMPATIBLE',
      detail: `PART_COUNT=${PART_COUNT}（要求 ≥3）；uploadId=${String(uploadId).slice(0, 16)}…；ETags=[${parts.map((p) => p.etag).join(',')}]`,
    };
  },

  C07: async () => {
    if (!CTX.multipart) return { ok: false, cause: 'INCOMPATIBLE', detail: 'C06 未提供 multipart 上下文' };
    const { uploadId, parts } = CTX.multipart;
    await CTX.internal.completeMultipartUpload(BUCKETS[0], CTX.mergedKey, uploadId, parts);
    const got = await sdkGetBuffer(CTX.internal, BUCKETS[0], CTX.mergedKey);
    const expect = sha256(CTX.mergedBuf);
    const actual = sha256(got);
    const stat = await CTX.internal.statObject(BUCKETS[0], CTX.mergedKey);
    if (actual !== expect || got.length !== CTX.mergedBuf.length || stat.size !== CTX.mergedBuf.length) {
      return {
        ok: false, cause: 'INCOMPATIBLE',
        detail: `合并后 SHA-256 不一致：${actual.slice(0, 16)}… / ${expect.slice(0, 16)}…；size=${got.length}/${stat.size}`,
      };
    }
    // L5 负向对照：错误 ETag 必须被拒绝，防「合并恒成功」假绿
    const badK = track(key('C07-bad-etag.bin'));
    const badUpload = await CTX.internal.initiateNewMultipartUpload(BUCKETS[0], badK, { 'Content-Type': 'application/octet-stream' });
    const badUrl = await CTX.public.presignedUrl('PUT', BUCKETS[0], badK, 3600, { uploadId: badUpload, partNumber: '1' });
    await rawRequest('PUT', badUrl, { headers: { 'content-type': 'application/octet-stream' }, body: makePartBuf(1, PART_SIZE, 31), timeoutMs: 60000 });
    let rejected = false, badDetail = '';
    try {
      await CTX.internal.completeMultipartUpload(BUCKETS[0], badK, badUpload, [{ part: 1, etag: '00000000000000000000000000000000' }]);
      badDetail = '错误 ETag 竟合并成功';
    } catch (e) { rejected = true; badDetail = e.message; }
    await CTX.internal.abortMultipartUpload(BUCKETS[0], badK, badUpload).catch(() => {});
    if (!rejected) return { ok: false, cause: 'INCOMPATIBLE', detail: badDetail };
    return { ok: true, detail: `sha256=${actual}（64 位全等）；size=${stat.size}；错 ETag 被拒：${badDetail.slice(0, 120)}` };
  },

  C08: async () => {
    // 重点④：preflight + 实际 PUT 响应，验「浏览器能否读到 ETag」这一**效果**，不验响应头字面值。
    // 3.79 零配置返回 Access-Control-Expose-Headers: *（通配），显式单列 ETag 反而做不到；
    // 旧版只认字面量 etag 会必然假红，把正确实现误判成 INCOMPATIBLE（详见 exposesEtag 注释）。
    const target = `${publicBase}/${BUCKETS[0]}/${CTX.mergedKey || CTX.smallKey}`;
    const pre = await rawRequest('OPTIONS', target, {
      headers: {
        origin: CFG.origin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });
    const h = pre.headers || {};
    const allowOrigin = String(h['access-control-allow-origin'] || '');
    const allowMethods = String(h['access-control-allow-methods'] || '');
    const allowHeaders = String(h['access-control-allow-headers'] || '');
    const expose = String(h['access-control-expose-headers'] || '');
    // 实际分片 PUT 响应也应暴露（若服务端只在实际响应给头）
    const actualExpose = CTX.partResponses.map((r) => String(r.headers['access-control-expose-headers'] || ''));
    const originOk = allowOrigin === '*' || allowOrigin.includes(CFG.origin);
    const methodsOk = /PUT/i.test(allowMethods);
    const headersOk = /content-type/i.test(allowHeaders);
    const exposeOk = exposesEtag(expose);
    const actualOk = actualExpose.length > 0 && actualExpose.every(exposesEtag);
    const exposeLegal = exposeOk || actualOk;

    // 归因纪律（主理人 2026-11-09 裁定）：CORS 头是**条件性**的，不带 Origin 时 3.79 不返回任何
    // CORS 头。若四头全空，先按三查排查请求/环境，不得直接判「SeaweedFS 与 SigV4 不兼容」。
    // ① 请求是否带 Origin ② 是否被反代收敛到与 Web 同域（同域浏览器不带 Origin）
    // ③ 是否设 withCredentials=true / credentials:include（Allow-Origin:* + Allow-Credentials:true 会被浏览器拒）。
    const anyCorsHeader = [allowOrigin, allowMethods, allowHeaders, expose]
      .concat(actualExpose).some((v) => String(v).length > 0);

    // '*' 通配成立前提：credentials mode=omit。静态源码守卫不默认成立；
    // detail 始终显式写出前提与「运行时前端配置未独立验证」，列入阶段二报告未验证项。
    const wildcardUsed = exposeLegal
      && [expose].concat(actualExpose).some((v) => exposesEtag(v) && String(v).includes('*'));
    const guard = wildcardUsed ? credentialsOmitGuard() : null;
    let premiseText;
    if (!anyCorsHeader) premiseText = '响应无任何 CORS 头，通配/显式前提均不适用（归因三查）';
    else if (!exposeLegal) premiseText = '暴露头既非 * 也非显式 ETag，前提不适用';
    else if (wildcardUsed) {
      premiseText = `${C08_WILDCARD_PREMISE}；静态源码守卫=${guard.pass ? 'PASS' : 'FAIL'}(${guard.note})；`
        + '本脚本未独立验证前端运行时配置，列入阶段二报告未验证项';
    } else premiseText = '暴露头为显式 ETag（无通配前提）';

    const problems = [];
    if (!originOk) problems.push(`allow-origin=${allowOrigin || '(缺失)'}`);
    if (!methodsOk) problems.push(`allow-methods=${allowMethods || '(缺失)'}`);
    if (!headersOk) problems.push(`allow-headers=${allowHeaders || '(缺失)'}`);
    if (!exposeLegal) problems.push(`expose-headers=${expose || '(缺失)'}；实际PUT响应=${JSON.stringify(actualExpose)}`);

    // fail-closed：'*' 前提守卫不过 → 不判 PASS，也不判 INCOMPATIBLE（不是 SeaweedFS 不兼容，
    // 是「没验成」：前端 credentials 配置与通配前提冲突或源码不可读，需整改后重跑）。
    let cause = null;
    let ok = originOk && methodsOk && headersOk && exposeLegal;
    if (!anyCorsHeader) {
      ok = false;
      cause = 'TOOL_ERROR';
      problems.push('响应无任何 CORS 头：按归因三查先核 Origin / 同域反代 / credentials，不判 INCOMPATIBLE');
    } else if (guard && !guard.pass) {
      ok = false;
      cause = 'CONFIG_MISSING';
      problems.push(`'*' 通配前提未成立：${guard.note}`);
    } else if (!ok) {
      // 带了 Origin、非同域前提成立、且 CORS middleware 已响应，仍未返回合法暴露头 → 才是兼容结论
      cause = 'INCOMPATIBLE';
    }
    return {
      ok, cause,
      detail: ok
        ? `preflight=${pre.statusCode}；origin/methods/headers/expose-headers 四头齐全（浏览器可读 ETag，效果判据）；${premiseText}`
        : `CORS 未让浏览器读到 ETag：${problems.join('；')}；${premiseText}`,
    };
  },

  C09: async () => {
    const k = track(key('C09-listparts.bin'));
    const uploadId = await CTX.internal.initiateNewMultipartUpload(BUCKETS[0], k, { 'Content-Type': 'application/octet-stream' });
    for (let i = 1; i <= 2; i += 1) {
      const url = await CTX.public.presignedUrl('PUT', BUCKETS[0], k, 3600, { uploadId, partNumber: String(i) });
      const res = await rawRequest('PUT', url, { headers: { 'content-type': 'application/octet-stream' }, body: makePartBuf(i, PART_SIZE, 53), timeoutMs: 60000 });
      if (![200, 204].includes(res.statusCode)) return { ok: false, cause: 'INCOMPATIBLE', detail: `C09 第 ${i} 片 PUT → ${res.statusCode}` };
    }
    if (typeof CTX.internal.listParts !== 'function') {
      return { ok: false, cause: 'INCOMPATIBLE', detail: 'minio@8 客户端无 listParts 内部方法（版本敏感，架构 §4 #8）' };
    }
    const raw = await CTX.internal.listParts(BUCKETS[0], k, uploadId);
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.parts) ? raw.parts : null);
    if (!arr) return { ok: false, cause: 'INCOMPATIBLE', detail: `listParts 返回形态异常：${JSON.stringify(raw).slice(0, 300)}` };
    const ok = arr.length === 2
      && arr.every((p) => Number.isInteger(p.part) && typeof p.etag === 'string' && p.etag.length > 0 && Number.isInteger(p.size))
      && arr[0].part < arr[1].part;
    await CTX.internal.abortMultipartUpload(BUCKETS[0], k, uploadId).catch(() => {});
    return {
      ok, cause: ok ? null : 'INCOMPATIBLE',
      detail: ok ? `返回 2 项 {part,etag,size} 且升序：${JSON.stringify(arr).slice(0, 240)}` : `结构/数量/升序不符：${JSON.stringify(arr).slice(0, 300)}`,
    };
  },

  C10: async () => {
    const k = track(key('C10-abort.bin'));
    const uploadId = await CTX.internal.initiateNewMultipartUpload(BUCKETS[0], k, { 'Content-Type': 'application/octet-stream' });
    for (let i = 1; i <= 2; i += 1) {
      const url = await CTX.public.presignedUrl('PUT', BUCKETS[0], k, 3600, { uploadId, partNumber: String(i) });
      await rawRequest('PUT', url, { headers: { 'content-type': 'application/octet-stream' }, body: makePartBuf(i, PART_SIZE, 71), timeoutMs: 60000 });
    }
    let threw = null;
    try { await CTX.internal.abortMultipartUpload(BUCKETS[0], k, uploadId); }
    catch (e) { threw = e.message; }
    if (threw) return { ok: false, cause: 'INCOMPATIBLE', detail: `abort 抛错：${threw}` };
    const exists = await CTX.internal.statObject(BUCKETS[0], k).then(() => true).catch(() => false);
    const ok = !exists;
    return { ok, cause: ok ? null : 'INCOMPATIBLE', detail: `abort 成功；objectExists=${exists}（期望 false）` };
  },

  C11: async () => {
    const k = CTX.smallKey;
    let threw = null;
    try { await CTX.internal.removeObject(BUCKETS[0], k); } catch (e) { threw = e.message; }
    if (threw) return { ok: false, cause: 'INCOMPATIBLE', detail: `removeObject 抛错：${threw}` };
    const exists = await CTX.internal.statObject(BUCKETS[0], k).then(() => true).catch(() => false);
    return {
      ok: !exists, cause: exists ? 'INCOMPATIBLE' : null,
      detail: `removeObject 成功；objectExists=${exists}（期望 false；删脏对象路径依赖此语义）`,
    };
  },

  C12: async () => {
    const src = CTX.mergedKey;
    const dst = track(key('C12-copy.bin'));
    CTX.copyKey = dst;
    await CTX.internal.copyObject(BUCKETS[3], dst, `/${BUCKETS[0]}/${src}`, undefined);
    const stat = await CTX.internal.statObject(BUCKETS[3], dst);
    const got = await sdkGetBuffer(CTX.internal, BUCKETS[3], dst);
    const expect = sha256(CTX.mergedBuf);
    const ok = stat.size === CTX.mergedBuf.length && sha256(got) === expect;
    return {
      ok, cause: ok ? null : 'INCOMPATIBLE',
      detail: `目标桶=${BUCKETS[3]}；size=${stat.size}/${CTX.mergedBuf.length}；sha256=${sha256(got).slice(0, 16)}…/${expect.slice(0, 16)}…`,
    };
  },

  C13: async () => {
    const prefix = `${PREFIX}/C13/`;
    const expected = [];
    for (let i = 1; i <= 3; i += 1) {
      const k = track(`${prefix}obj-${i}.bin`);
      const buf = Buffer.from(`C13-${i}-` + 'z'.repeat(100 * i));
      await CTX.internal.putObject(BUCKETS[0], k, buf, buf.length, { 'Content-Type': 'text/plain' });
      expected.push({ k, size: buf.length });
      CTX.listKeys.push(k);
    }
    const found = [];
    await new Promise((resolve, reject) => {
      const stream = CTX.internal.listObjectsV2(BUCKETS[0], prefix, true);
      stream.on('data', (o) => { if (o.name) found.push({ k: o.name, size: o.size }); });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const set = new Set(found.map((f) => f.k));
    const allPresent = expected.every((e) => set.has(e.k));
    const sizeOk = expected.every((e) => found.some((f) => f.k === e.k && f.size === e.size));
    const ok = allPresent && sizeOk && found.length === expected.length;
    return {
      ok, cause: ok ? null : 'INCOMPATIBLE',
      detail: `预期 3 项，实得 ${found.length} 项；keys=${JSON.stringify(found.map((f) => f.k).slice(0, 5))}`,
    };
  },

  C14: async () => {
    const b = BUCKETS[0];
    CTX.lifecycleBucket = b;
    const xml = [
      '<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      '<Rule><ID>qa-pipeline-tmp</ID><Prefix>tmp/</Prefix><Status>Enabled</Status>',
      '<Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>',
    ].join('');
    const url = `${bucketUrl(b)}?lifecycle=`;
    const put = await awsRequest('PUT', url, { headers: { 'content-type': 'application/xml' }, body: Buffer.from(xml, 'utf8') });
    if (![200, 204].includes(put.statusCode)) {
      return { ok: false, cause: 'INCOMPATIBLE', detail: `PutBucketLifecycle → ${put.statusCode}；body=${put.bodyText.slice(0, 200)}` };
    }
    const get = await awsRequest('GET', url);
    if (get.statusCode !== 200) return { ok: false, cause: 'INCOMPATIBLE', detail: `GetBucketLifecycle → ${get.statusCode}` };
    const rule = /<Rule>([\s\S]*?)<\/Rule>/.exec(get.bodyText);
    const r = rule ? rule[1] : '';
    const hasPrefix = /<Prefix>\s*tmp\/\s*<\/Prefix>/.test(r);
    const hasDays = /<Days>\s*1\s*<\/Days>/.test(r);
    const hasStatus = /<Status>\s*Enabled\s*<\/Status>/.test(r);
    const ok = !!rule && hasPrefix && hasDays && hasStatus;
    return {
      ok, cause: ok ? null : 'INCOMPATIBLE',
      detail: ok ? 'Put/Get 生命周期回读含 Rule + Prefix=tmp/ + Status=Enabled + Days=1'
        : `回读规则字段不齐：rule=${!!rule}, prefix=${hasPrefix}, days=${hasDays}, status=${hasStatus}；xml=${get.bodyText.slice(0, 240)}`,
    };
  },

  C15: async () => {
    if (!CTX.public) return { ok: false, cause: 'TOOL_ERROR', detail: 'publicClient 未构造' };
    const k = CTX.mergedKey;
    const url = await CTX.public.presignedGetObject(BUCKETS[0], k, 3600);
    const u = new URL(url);
    if (u.hostname !== CFG.publicEndpoint) {
      return { ok: false, cause: 'CONFIG_MISSING', detail: `预签名 GET host=${u.host} 非 S3_PUBLIC_ENDPOINT` };
    }
    const full = await rawRequest('GET', url, { timeoutMs: 60000 });
    if (full.statusCode !== 200 || sha256(full.body) !== sha256(CTX.mergedBuf)) {
      return { ok: false, cause: 'INCOMPATIBLE', detail: `预签名 GET → ${full.statusCode}；内容比对失败` };
    }
    const ranged = await rawRequest('GET', url, { headers: { range: 'bytes=0-1023' }, timeoutMs: 60000 });
    const ok = ranged.statusCode === 206 && ranged.body.length === 1024
      && ranged.body.equals(CTX.mergedBuf.slice(0, 1024));
    return {
      ok, cause: ok ? null : 'INCOMPATIBLE',
      detail: `host=${u.host}；全量 GET=${full.statusCode} 一致；Range GET=${ranged.statusCode}, len=${ranged.body.length}`,
    };
  },

  C16: async () => {
    const total = Math.max(1, Math.floor(STREAM_MB)) * 1024 * 1024;
    const k = track(key('C16-stream.bin'));
    CTX.streamKey = k;
    const expected = crypto.createHash('sha256');
    const stream = Readable.from((async function* () {
      for await (const buf of genChunks(total, 1024 * 1024, 97)) { expected.update(buf); yield buf; }
    })());
    await CTX.internal.putObject(BUCKETS[0], k, stream, total, { 'Content-Type': 'application/octet-stream' });
    const expectHex = expected.digest('hex');
    const s = await sdkStreamSha256(CTX.internal, BUCKETS[0], k);
    const stat = await CTX.internal.statObject(BUCKETS[0], k);
    const ok = s.sha256 === expectHex && s.size === total && stat.size === total;
    return {
      ok, cause: ok ? null : 'INCOMPATIBLE',
      detail: `${STREAM_MB}MB 流式：size=${s.size}/${stat.size}/${total}；sha256=${s.sha256.slice(0, 16)}…/${expectHex.slice(0, 16)}…`,
    };
  },

  C18: async () => {
    // D-4 技术层：证明 SeaweedFS 侧 presignGet 下载 wire 链路可用。
    // 复现生产下载调用形态 file.service.ts:418-420（presignGet + response-content-disposition，300s）。
    // 纪律：只走 S3 wire，不经过 file.service.download() 鉴权、不构造带 DOWNLOAD 授权的用户快照、
    //       不调用 /api 业务端点、不演示业务放行（docs/QA-FILE-PIPELINE-PLAN.md §2.5）。
    if (!CTX.public) return { ok: false, cause: 'TOOL_ERROR', detail: 'publicClient 未构造' };
    const k = track(key('C18-download-source.pdf'));
    const src = Buffer.from('%PDF-1.4\nQA-D4-DOWNLOAD-WIRE-' + 'd'.repeat(8192) + '\n%%EOF\n', 'utf8');
    const sourceSha = sha256(src);
    await CTX.internal.putObject(BUCKETS[0], k, src, src.length, { 'Content-Type': 'application/pdf' });

    const disposition = "attachment; filename*=UTF-8''qa-d4-download.pdf";
    const url = await CTX.public.presignedGetObject(BUCKETS[0], k, 300, {
      'response-content-disposition': disposition,
    });
    const u = new URL(url);
    const port = u.port || (CFG.publicUseSSL ? 443 : 80);
    const hostOk = u.hostname === CFG.publicEndpoint && Number(port) === Number(CFG.publicPort);
    let reachable = false;
    try { await dns.lookup(u.hostname); reachable = await tcpReachable(u.hostname, port, TIMEOUT_MS); }
    catch { reachable = false; }
    const containerDns = /^(seaweedfs|minio|s3|postgres|redis|elasticsearch)$/i.test(u.hostname)
      || (!u.hostname.includes('.') && u.hostname !== 'localhost');
    if (!hostOk || !reachable || containerDns) {
      return {
        ok: false, cause: (containerDns || !hostOk) ? 'CONFIG_MISSING' : 'INCOMPATIBLE',
        detail: `下载预签名 URL host 不可达：url.host=${u.host}, 期望=${CFG.publicEndpoint}:${CFG.publicPort}, hostOk=${hostOk}, reachable=${reachable}, 容器DNS=${containerDns}`,
      };
    }

    const full = await rawRequest('GET', url, { timeoutMs: 60000 });
    if (full.statusCode !== 200 || sha256(full.body) !== sourceSha) {
      return {
        ok: false, cause: 'INCOMPATIBLE',
        detail: `下载 GET → ${full.statusCode} 或内容不符；sha256=${sha256(full.body).slice(0, 16)}…/${sourceSha.slice(0, 16)}…`,
      };
    }
    // 生产下载文件名依赖 response-content-disposition 回显（file.service.ts:419）
    const cd = String(full.headers['content-disposition'] || '');
    if (!/attachment/i.test(cd)) {
      return { ok: false, cause: 'INCOMPATIBLE', detail: `response-content-disposition 未回显：${cd || '(缺失)'}` };
    }
    const ranged = await rawRequest('GET', url, { headers: { range: 'bytes=0-1023' }, timeoutMs: 60000 });
    const rangeOk = ranged.statusCode === 206 && ranged.body.length === 1024 && ranged.body.equals(src.slice(0, 1024));
    if (!rangeOk) {
      return { ok: false, cause: 'INCOMPATIBLE', detail: `下载 Range GET → ${ranged.statusCode}, len=${ranged.body.length}` };
    }
    return {
      ok: true,
      detail: `host=${u.host} 浏览器可达；全量 GET=200 且 sha256=${sourceSha.slice(0, 16)}… 与源文件一致；content-disposition=${cd.slice(0, 80)}；Range=206/1024B。`
        + ' | D4_SCOPE=WIRE_ONLY（未调用 file.service.download / 未构造 PermissionSnapshot / 未写入 grants 授权 / 未请求 /api 端点 / 未演示业务放行）',
    };
  },

  C17: async () => {
    // 仅 full：2GB / 5MB 分片（约 410 片）。demo 范围外，core 的 YES 不覆盖本项。
    const total = Math.max(1, Math.floor(LARGE_MB)) * 1024 * 1024;
    const partCount = Math.ceil(total / PART_SIZE);
    const k = track(key('C17-large.bin'));
    const uploadId = await CTX.internal.initiateNewMultipartUpload(BUCKETS[0], k, { 'Content-Type': 'application/octet-stream' });
    const expected = crypto.createHash('sha256');
    const parts = [];
    for (let i = 1; i <= partCount; i += 1) {
      const size = Math.min(PART_SIZE, total - (i - 1) * PART_SIZE);
      const buf = makePartBuf(i, size, 113);
      expected.update(buf);
      const url = await CTX.public.presignedUrl('PUT', BUCKETS[0], k, 3600, { uploadId, partNumber: String(i) });
      const res = await rawRequest('PUT', url, { headers: { 'content-type': 'application/octet-stream' }, body: buf, timeoutMs: 120000 });
      if (![200, 204].includes(res.statusCode)) {
        return { ok: false, cause: 'INCOMPATIBLE', detail: `第 ${i}/${partCount} 片 → ${res.statusCode}` };
      }
      const etag = String(res.headers.etag || '').replace(/"/g, '');
      if (!etag) return { ok: false, cause: 'INCOMPATIBLE', detail: `第 ${i} 片无 ETag` };
      parts.push({ part: i, etag });
    }
    const expectHex = expected.digest('hex');
    await CTX.internal.completeMultipartUpload(BUCKETS[0], k, uploadId, parts);
    const s = await sdkStreamSha256(CTX.internal, BUCKETS[0], k);
    const ok = partCount >= 410 && s.sha256 === expectHex && s.size === total;
    return {
      ok, cause: ok ? null : 'INCOMPATIBLE',
      detail: `partCount=${partCount}（2GB 期望 410）；size=${s.size}/${total}；sha256=${s.sha256.slice(0, 16)}…/${expectHex.slice(0, 16)}…`,
    };
  },
};

// ---------------------------------------------------------------- self-test（不联网，测生产判据）

function doSelfTest() {
  const cases = [];
  const chk = (name, cond, extra = '') => { cases.push({ name, ok: !!cond, extra }); };
  const mk = (arr) => arr.map(([id, status, cause]) => ({ id, status, cause: cause || null }));

  const ok1 = computeVerdict(mk([['G0', 'PASS'], ['G1', 'PASS'], ['C01', 'PASS']]));
  chk('全 PASS → YES', ok1.isPass === true && ok1.passed === 3);
  chk('注入 FAIL → NO', computeVerdict(mk([['G0', 'PASS'], ['C01', 'FAIL', 'INCOMPATIBLE']])).isPass === false);
  chk('注入 NOT_RUN → NO', computeVerdict(mk([['G0', 'PASS'], ['C01', 'NOT_RUN']])).isPass === false);
  chk('注入 BLOCKED → NO', computeVerdict(mk([['G0', 'PASS'], ['C01', 'BLOCKED', 'SERVICE_DOWN']])).isPass === false);
  chk('注入 ERROR/TOOL_ERROR → NO', computeVerdict(mk([['G0', 'ERROR', 'TOOL_ERROR']])).isPass === false);
  chk('空清单 → NO（反假绿元断言）', computeVerdict([]).isPass === false, '空清单不得判通过');
  chk('归因优先级 SERVICE_DOWN > INCOMPATIBLE',
    computeVerdict(mk([['G0', 'PASS'], ['C01', 'FAIL', 'INCOMPATIBLE'], ['C02', 'FAIL', 'SERVICE_DOWN']])).primaryCause === 'SERVICE_DOWN');
  chk('三类归因可分辨',
    computeVerdict(mk([['C01', 'FAIL', 'BAD_CREDENTIALS']])).primaryCause === 'BAD_CREDENTIALS'
    && computeVerdict(mk([['C01', 'FAIL', 'CONFIG_MISSING']])).primaryCause === 'CONFIG_MISSING'
    && computeVerdict(mk([['C01', 'FAIL', 'INCOMPATIBLE']])).primaryCause === 'INCOMPATIBLE');
  chk('incomplete 列表逐条列出', computeVerdict(mk([['C01', 'NOT_RUN'], ['C02', 'BLOCKED']])).incomplete.length === 2);

  // SigV4 构造的结构不变量 + 确定性（不联网，验证工具自身可信）
  const fixed = {
    method: 'GET', urlStr: 'http://127.0.0.1:8333/archive-original?lifecycle=',
    headers: { 'content-type': 'application/xml' }, body: Buffer.alloc(0),
    accessKey: 'AKEXAMPLE', secretKey: 'SKEXAMPLE', date: '20260101T000000Z',
  };
  const a = buildAuthorization(fixed);
  const b = buildAuthorization(fixed);
  // 注意字符类必须含 0-9：SignedHeaders 里有 x-amz-content-sha256（含数字 256）
  chk('SigV4 Authorization 结构',
    /^AWS4-HMAC-SHA256 Credential=AKEXAMPLE\/20260101\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(a.authorization),
    a.authorization);
  chk('SigV4 结果确定性（同输入同签名）', a.authorization === b.authorization);
  chk('SigV4 含 x-amz-content-sha256 与 x-amz-date',
    a.headers['x-amz-content-sha256'].length === 64 && a.headers['x-amz-date'] === '20260101T000000Z');
  chk('SigV4 canonical query 含 lifecycle=', /lifecycle=/.test(a.canonicalRequest));

  // 检查点清单完整性（core=20 / full=21，与方案 §4 一致；C18 为 D-4 技术层）
  const coreCount = CHECK_DEFS.filter((d) => d.id !== 'C17').length;
  chk('core 清单 20 项', coreCount === 20, `实际 ${coreCount}`);
  chk('full 清单 21 项', CHECK_DEFS.length === 21, `实际 ${CHECK_DEFS.length}`);
  chk('重点八项 + D-4 均有对应检查点',
    ['C05', 'C06', 'C07', 'C08', 'C09', 'C15', 'C18', 'G1'].every((id) => CHECK_DEFS.some((d) => d.id === id)));
  // D-4：技术层脚本不得经过业务鉴权路径（不构造 DOWNLOAD 授权用户快照、不请求业务 API）
  const selfSrc = fs.readFileSync(__filename, 'utf8');
  chk('D-4 技术层不经业务鉴权（无 file.service / PermissionSnapshot import，且 C18 带 WIRE_ONLY 边界声明）',
    !/require\(['"][^'"]*file\.service|\bfrom\s+['"][^'"]*file\.service|import\s+[^;]*PermissionSnapshot/.test(selfSrc)
    && /D4_SCOPE=WIRE_ONLY/.test(selfSrc));

  // ---- C08 效果判据：四形态变异（3.79 零配置返回 '*'，字面量断言会必然假红，必须守住）----
  chk("exposesEtag: '*' 通配 → PASS", exposesEtag('*') === true);
  chk("exposesEtag: 显式 ETag / 列表含 etag → PASS",
    exposesEtag('ETag') === true && exposesEtag('Content-Length, ETag') === true);
  chk("exposesEtag: 无关头 x-custom → FAIL", exposesEtag('x-custom') === false);
  chk('exposesEtag: 空 / undefined / null → FAIL',
    exposesEtag('') === false && exposesEtag(undefined) === false && exposesEtag(null) === false);
  // '*' 前提守卫：既验纯函数命中，也直接调用被测函数 credentialsOmitGuard 做三态变异。
  // 用 os.tmpdir 临时目录，不依赖真实工作区前端源码是否存在（干净克隆/离线包亦不假红）。
  let guardVariantsOk = false;
  let guardTmp = '';
  try {
    const os = require('node:os');
    guardTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-c08-guard-'));
    fs.writeFileSync(path.join(guardTmp, 'FileUploader.tsx'), 'await axios.put(url, blob);\n', 'utf8');
    const clean = credentialsOmitGuard(guardTmp);
    fs.writeFileSync(path.join(guardTmp, 'bad.ts'), 'axios.defaults.withCredentials = true;\n', 'utf8');
    const dirty = credentialsOmitGuard(guardTmp);
    const missingDir = credentialsOmitGuard(path.join(guardTmp, '__no_such_dir__'));
    const noUploader = (() => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-c08-noup-'));
      try {
        fs.writeFileSync(path.join(d, 'a.ts'), 'export const a = 1;\n', 'utf8');
        return credentialsOmitGuard(d);
      } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
    })();
    guardVariantsOk = clean.pass === true && dirty.pass === false
      && missingDir.pass === false && noUploader.pass === false;
  } catch { guardVariantsOk = false; }
  finally {
    try { if (guardTmp) fs.rmSync(guardTmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  chk("C08 '*' 前提守卫：干净源码放行 / include 命中 / 目录缺失 / 缺 FileUploader 均 fail-closed",
    credentialsPatternsHit('await axios.put(url, blob);').length === 0
    && credentialsPatternsHit('axios.defaults.withCredentials = true;').length === 1
    && credentialsPatternsHit("fetch(u, { credentials: 'include' });").length === 1
    && credentialsPatternsHit('axios.put(u, b, { withCredentials: true });').length === 1
    && guardVariantsOk,
    guardVariantsOk ? '' : 'credentialsOmitGuard 三态变异未全通过');
  // 'credentials=omit' 守卫生效（主理人第 5 点）：定向核对三处 audit + 注入 HIT 后 fail-closed。
  // 用临时目录构造「axios.create 全局配置 + FileUploader.tsx 的 axios.put 调用」，零依赖真实工作区。
  let omitGuardOk = false;
  let omitDetail = '';
  let omitTmp = '';
  try {
    const os = require('node:os');
    omitTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-c08-omit-'));
    const clientF = path.join(omitTmp, 'client.ts');
    const uploaderF = path.join(omitTmp, 'FileUploader.tsx');
    const cleanClient = "const http = axios.create({ baseURL: '/api', timeout: 60000, headers: { 'Content-Type': 'application/json' } });\n";
    const cleanUploader = "const res = await axios.put(url, blob, { headers: { 'Content-Type': 'application/octet-stream' }, timeout: 0 });\n";
    fs.writeFileSync(clientF, cleanClient, 'utf8');
    fs.writeFileSync(uploaderF, cleanUploader, 'utf8');
    const clean = credentialsOmitGuard(omitTmp);
    // 三处定向核对在干净源码下应全 CLEAN，守卫放行
    const cleanOk = clean.pass === true && clean.audit
      && clean.audit.globalDefaults.status === 'CLEAN'
      && clean.audit.axiosCreateConfig.status === 'CLEAN'
      && clean.audit.fileUploaderPut.status === 'CLEAN';
    // 注入①：axios.create 配置块含 withCredentials:true → 该处 HIT 且整体 fail-closed
    fs.writeFileSync(clientF, "const http = axios.create({ withCredentials: true, baseURL: '/api' });\n", 'utf8');
    const createHit = credentialsOmitGuard(omitTmp);
    // 注入②：FileUploader axios.put 参数块含 withCredentials:true → 该处 HIT 且整体 fail-closed
    fs.writeFileSync(clientF, cleanClient, 'utf8');
    fs.writeFileSync(uploaderF, "await axios.put(url, blob, { withCredentials: true, timeout: 0 });\n", 'utf8');
    const putHit = credentialsOmitGuard(omitTmp);
    // 注入③：全局 defaults 赋值 → globalDefaults HIT 且整体 fail-closed
    fs.writeFileSync(uploaderF, cleanUploader, 'utf8');
    fs.writeFileSync(path.join(omitTmp, 'entry.ts'), 'axios.defaults.withCredentials = true;\n', 'utf8');
    const defaultsHit = credentialsOmitGuard(omitTmp);
    const hitOk = createHit.pass === false && createHit.audit.axiosCreateConfig.status === 'HIT'
      && putHit.pass === false && putHit.audit.fileUploaderPut.status === 'HIT'
      && defaultsHit.pass === false && defaultsHit.audit.globalDefaults.status === 'HIT';
    omitGuardOk = cleanOk && hitOk;
    omitDetail = clean.audit
      ? `clean=[${Object.entries(clean.audit).map(([k, v]) => k + ':' + v.status).join(',')}]`
      : 'clean.audit 缺失';
  } catch (e) { omitDetail = String((e && e.message) || e); omitGuardOk = false; }
  finally {
    try { if (omitTmp) fs.rmSync(omitTmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
  chk("C08 'credentials=omit' 守卫生效（三处定向核对 CLEAN + 注入三处 HIT 均 fail-closed）",
    omitGuardOk, omitDetail);
  // 声明式边界守卫（复用 D4_SCOPE=WIRE_ONLY 机制）：'*' 前提不得被静默删掉、C08 不得回退成字面量断言
  chk("C08 '*' 前提守卫声明存在（CREDENTIALS_OMIT_REQUIRED，且 C08 两处均调用 exposesEtag 纯函数）",
    /C08_WILDCARD_PREMISE=CREDENTIALS_OMIT_REQUIRED/.test(selfSrc)
    && /function exposesEtag\(v\)/.test(selfSrc)
    && /const exposeOk = exposesEtag\(expose\);/.test(selfSrc)
    && /actualExpose\.every\(exposesEtag\)/.test(selfSrc));

  // 最后一条：日志落盘链路必须真实可用。self-test 早期版本曾漏调 flushLog，
  // 出现「判据 16/16 全绿但日志根本没写盘」的假绿；本用例真实写盘，专防该形态。
  let logProbeOk = false;
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.writeFileSync(LOG_PATH, 'SELFTEST_LOG_PROBE\n', { encoding: 'utf8' });
    logProbeOk = fs.existsSync(LOG_PATH);
  } catch { logProbeOk = false; }
  chk('日志目录真实可写（flushLog 落盘链路）', logProbeOk, relLog());

  for (const c of cases) {
    out(JSON.stringify({ type: 'selftest', name: c.name, result: c.ok ? 'PASS' : 'FAIL', extra: c.extra || '' }));
  }
  const passed = cases.filter((c) => c.ok).length;
  const allOk = passed === cases.length;
  out(`SELFTEST: ${allOk ? 'PASS' : 'FAIL'} (${passed}/${cases.length})`);
  out('NOTE: self-test 只证明判据引擎与日志链路不假绿，不产生任何验收结论（方案 §0 纪律 2）');
  const flushed = flushLog(); // 用完整日志覆盖 probe 文件
  if (!flushed) out('SELFTEST: LOG_WRITE_FAILED —— 工具异常，脚本不可用');
  return allOk && flushed ? 0 : 2;
}

// ---------------------------------------------------------------- 主流程

function printHeader() {
  out(`QA-FILE-PIPELINE-VERIFY | suite=${SUITE} | tag=${TAG} | runId=${RUN_ID}`);
  out(`plan=docs/QA-FILE-PIPELINE-PLAN.md | log=${relLog()}`);
  out(`internal=${CFG.internalEndpoint}:${CFG.internalPort} | public=${CFG.publicEndpoint || '(未设置)'}:${CFG.publicPort} | origin=${CFG.origin}`);
  out(`buckets=${BUCKETS.join(',')} | checks=${checks.length} | timeoutMs=${TIMEOUT_MS}`);
  out('DISCIPLINE: contract spec 全绿不作 wire 证据；脚本存在 ≠ 验证通过；self-test 全绿 ≠ 服务兼容');
  out('D-4 分层: 技术层=S3 presignGet 下载 wire 链路（C18）；业务层=下载放行链路未验证（approval 授权写入未实现，L2 上线前闭环）；禁止合并写成「下载已验证」');
  if (/^(seaweedfs|minio|s3|postgres|redis|elasticsearch)$/i.test(CFG.internalEndpoint)) {
    out(`WARN: internalEndpoint=${CFG.internalEndpoint} 是容器 DNS，宿主机脚本可能无法解析；请用 --internal-endpoint 127.0.0.1`);
  }
}

async function cleanup() {
  // 尽力清理，不进判据；失败留档
  let n = 0, err = 0;
  for (const k of CTX.createdKeys) {
    try { await CTX.internal.removeObject(BUCKETS[0], k); n += 1; } catch { err += 1; }
  }
  if (CTX.copyKey) {
    try { await CTX.internal.removeObject(BUCKETS[3], CTX.copyKey); n += 1; } catch { err += 1; }
  }
  out(JSON.stringify({ type: 'cleanup', removed: n, failed: err, note: '清理结果不进判据' }));
}

function finish() {
  let v = computeVerdict(checks);
  const logOk = flushLog();
  if (!logOk) v = { ...v, isPass: false, primaryCause: 'TOOL_ERROR' };
  out(`CHECKS_TOTAL: ${v.total} | PASSED: ${v.passed} | FAILED: ${v.failed}`);
  out(`BY_STATUS: ${JSON.stringify(v.byStatus)}`);
  if (!v.isPass) {
    out(`PRIMARY_CAUSE: ${v.primaryCause}`);
    out(`INCOMPLETE: ${v.incomplete.join(' | ') || '(none)'}`);
  }
  out(`SUITE: ${SUITE} | SCOPE: ${SUITE === 'core' ? 'CORE（未覆盖 2GB/410 片边界，不代表 full 通过）' : 'FULL'}`);
  out(`IS_PASS: ${v.isPass ? 'YES' : 'NO'}`);
  const c18 = C('C18');
  out(`D4_TECH_LAYER: S3 协议下载技术链路${c18 && c18.status === 'PASS' ? '已验证' : '未验证'}（C18 status=${c18 ? c18.status : 'N/A'}；presignGet + 浏览器可达 host + SHA-256 + Range，仅 wire 层）`);
  out('D4_BUSINESS_LAYER: 下载业务放行链路未验证（approval 模式授权写入链路未实现，L2 上线前闭环项；不在本脚本范围）');
  out('D4_CONCLUSION: 两层结论分开写，不构成下载功能已验证的结论；禁止合并成「下载已验证」');
  out(`LOG: ${relLog()}`);
  if (!logOk) out('WARN: 日志写入失败，已按 TOOL_ERROR 判 NO');
  return v.isPass ? 0 : (v.primaryCause === 'TOOL_ERROR' ? 2 : 1);
}

async function main() {
  printHeader();
  if (SELF_TEST) return doSelfTest();

  const missing = validateConfig();
  if (missing.length) {
    out(`CONFIG_MISSING: ${missing.join(' | ')}`);
    markRemainingBlocked('CONFIG_MISSING', `必需配置缺失：${missing.join(' | ')}`);
    out('NOTE: 本轮未产生兼容性结论（没验成 ≠ 验出不支持）');
    return finish();
  }

  let Minio = null;
  const candidates = [
    path.join(REPO_ROOT, 'apps', 'api', 'node_modules', 'minio'),
    path.join(REPO_ROOT, 'node_modules', 'minio'),
    'minio',
  ];
  for (const c of candidates) {
    try { Minio = require(c); if (Minio && Minio.Client) break; } catch { /* next */ }
  }
  if (!Minio || !Minio.Client) {
    out('TOOL_ERROR: 无法加载 minio@8 SDK（apps/api/node_modules/minio）');
    markRemainingBlocked('TOOL_ERROR', 'minio@8 SDK 未加载');
    return finish();
  }
  CTX.Minio = Minio;
  CTX.internal = makeClient(Minio, CFG.internalEndpoint, CFG.internalPort, CFG.internalUseSSL, CFG.accessKey, CFG.secretKey);
  CTX.public = makeClient(Minio, CFG.publicEndpoint, CFG.publicPort, CFG.publicUseSSL, CFG.accessKey, CFG.secretKey);
  out('SDK: minio@8 已加载；internalClient / publicClient 双端点已构造（镜像架构 §1.2 裁定）');

  // 门禁串联：任一失败，其后全部 BLOCKED（显式列出，不静默跳过）
  const g0 = await runCheck('G0', IMPL.G0);
  if (!g0) {
    markRemainingBlocked(C('G0').cause || 'SERVICE_DOWN', 'G0 服务不可达，后续未执行');
    out('NOTE: PRIMARY_CAUSE=SERVICE_DOWN —— 服务没起来，不构成兼容性结论');
    return finish();
  }
  const g1 = await runCheck('G1', IMPL.G1);
  if (!g1) {
    markRemainingBlocked(C('G1').cause || 'BAD_CREDENTIALS', 'G1 凭据/鉴权未通过，后续未执行');
    out('NOTE: PRIMARY_CAUSE=BAD_CREDENTIALS —— 凭据错或 Allow-All，不构成兼容性结论');
    return finish();
  }
  const g2 = await runCheck('G2', IMPL.G2);
  if (!g2) {
    markRemainingBlocked(C('G2').cause || 'CONFIG_MISSING', 'G2 四桶未齐，后续未执行');
    out('NOTE: G2 建桶责任未闭环；不得以 contract spec 全绿替代');
    return finish();
  }

  out('GATE: PASS（服务/凭据/四桶均已锁定；此后任一 wire 失败的唯一原因收敛到兼容层）');
  const wireIds = CHECK_DEFS.filter((d) => d.group === 'wire' && C(d.id)).map((d) => d.id);
  for (const id of wireIds) {
    // 前序关键依赖失败时，后续依赖用例显式 BLOCKED（不静默跳过、不默认通过）
    if (['C03', 'C04', 'C08', 'C11', 'C15'].includes(id) && !CTX.smallKey && id !== 'C11') {
      const c = C(id); c.status = 'BLOCKED'; c.cause = 'INCOMPATIBLE'; c.detail = 'C02 未产出基础对象，前置依赖未满足'; emit(c); continue;
    }
    if (['C07', 'C08', 'C12', 'C15'].includes(id) && !CTX.multipart && id !== 'C08') {
      const c = C(id); c.status = 'BLOCKED'; c.cause = 'INCOMPATIBLE'; c.detail = 'C06 未产出 multipart 上下文，前置依赖未满足'; emit(c); continue;
    }
    await runCheck(id, IMPL[id]);
  }

  await cleanup();
  return finish();
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    out(`FATAL: ${String((e && e.stack) || e)}`);
    markRemainingBlocked('TOOL_ERROR', '脚本异常中断');
    const code = finish();
    process.exitCode = code === 0 ? 2 : code;
  });
