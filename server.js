'use strict';
/**
 * 校园活动与机会平台 —— 单进程服务端
 *
 * 设计依据：design/技术方案.md
 * 约束：零 npm 依赖、零构建、单进程、无外部服务。
 *
 * 职责：
 *   1. 静态文件服务（public/）
 *   2. 极小的 JSON API（6 个接口）
 *   3. 补充口令校验与字段级变更留痕
 *   4. 附件上传的类型校验与落盘
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------- 配置

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// 数据目录可通过环境变量覆盖，便于测试使用临时目录而不污染真实数据
const DATA_DIR = process.env.SCHOOL_DATA_DIR
  ? path.resolve(process.env.SCHOOL_DATA_DIR)
  : path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const SEED_FILE = path.join(ROOT, 'design', 'activities.seed.json');
const ACTIVITIES_FILE = path.join(DATA_DIR, 'activities.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1'; // 只绑回环地址，不对外网暴露

const SCHEMA_VERSION = 1;
const TERM = '2026 秋季学期';
const TERM_YEAR = 2026;

const MAX_FILE_SIZE = 20 * 1024 * 1024;      // 单文件 20MB
const MAX_UPLOAD_REQUEST = 64 * 1024 * 1024; // 单次上传请求上限（内存保护）
const MAX_FILES_PER_ACTIVITY = 10;
const MAX_JSON_BODY = 1024 * 1024;           // JSON 请求体上限
const RATE_LIMIT_MAX = 30;                   // 同一口令每分钟写操作上限
const RATE_LIMIT_WINDOW = 60 * 1000;

/** 允许上传的扩展名 → MIME。含宏的 Office 格式（.docm/.pptm/.xlsm）刻意不在其中。 */
const ALLOWED_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 允许通过补充口令修改的字段 */
const EDITABLE_FIELDS = [
  'audience', 'threshold', 'commitment', 'requirement',
  'location', 'location_status',
  'schedule', 'deadline', 'deadline_status',
  'quota', 'cost', 'outcome', 'signup_mode',
];

// ---------------------------------------------------------------- 数据层

let activitiesCache = null;
let historyCache = null;
let writeChain = Promise.resolve();

/** 串行化所有写操作，避免读-改-写竞争 */
function enqueueWrite(task) {
  writeChain = writeChain.then(task, task);
  return writeChain;
}

/** 原子写入：先写临时文件，再 rename 覆盖 */
async function atomicWriteJson(file, obj) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

function nowIso() {
  return new Date().toISOString();
}

function newToken() {
  return crypto.randomBytes(12).toString('hex');
}

/** 把种子数据的一条记录映射为运行时结构 */
function mapSeedEntry(entry, token) {
  return {
    id: entry.id,
    name: entry.name,
    editToken: token,
    fields: {
      audience: entry.audience ?? null,
      threshold: entry.threshold ?? null,
      commitment: entry.commitment ?? null,
      requirement: entry.requirement ?? null,
      location: entry.location ?? null,
      location_status: entry.location_status ?? '未注明',
      schedule: entry.schedule ?? null,
      deadline: entry.deadline ?? null,
      deadline_status: entry.deadline_status ?? '未注明',
      quota: entry.quota ?? null,
      cost: entry.cost ?? null,
      outcome: entry.outcome ?? null,
      signup_mode: entry.signup_mode ?? '未注明',
    },
    raw: entry.raw ?? '',
    publisherType: entry.publisher_type ?? '未注明',
    category: entry.category ?? '',
    riskLevel: entry.risk_level ?? 'none',
    riskReasons: entry.risk_reasons ?? [],
    parentId: entry.parent_id ?? null,
    merged: Boolean(entry.merged),
    flags: entry.flags ?? [],
    notes: entry.notes ?? '',
    updatedAt: null,
  };
}

/**
 * 由种子数据建立初始运行时数据。
 * 合并条目（09、20）不单独出卡，其余字段回填父活动并生成初始变更记录。
 */
function buildInitialState(seed) {
  const activities = seed.entries.map((e) => mapSeedEntry(e, newToken()));
  const byId = new Map(activities.map((a) => [a.id, a]));
  const records = [];

  for (const entry of seed.entries) {
    if (!entry.merged || !entry.parent_id) continue;
    const parent = byId.get(entry.parent_id);
    if (!parent) continue;

    // 1) 把补充通知里的变更写成父活动的初始变更记录
    const coveredLabels = new Set();
    for (const ch of entry.changes || []) {
      // 「不变」不是变更，跳过以免留下无意义记录
      if (!ch.to || ch.to === '不变' || ch.from === ch.to) {
        if (ch.field) coveredLabels.add(ch.field);
        continue;
      }
      coveredLabels.add(ch.field);
      records.push({
        activityId: parent.id,
        field: ch.field,
        fieldLabel: ch.field,
        oldValue: ch.from ?? null,
        newValue: ch.to ?? null,
        changedAt: `${TERM_YEAR}-09-19T00:00:00.000Z`,
        reason: `数据源补充通知 ${entry.id}`,
        source: 'seed',
      });
    }

    // 2) 父活动缺失的地点等字段，用补充通知里的值回填（数据源明确「地点以 09 为准」）
    //    若补充通知的 changes 已就该字段记过一条，则不再重复记录
    for (const key of ['location', 'location_status']) {
      const childVal = entry[key];
      const parentVal = parent.fields[key];
      const parentEmpty = parentVal === null || parentVal === undefined || parentVal === '未注明';
      // 子条目也没有有效值时不回填，避免产生「未注明 -> 未注明」这类空操作记录
      if (!childVal || childVal === '未注明' || !parentEmpty) continue;
      const label = KEY_LABELS[key] || key;
      if (!coveredLabels.has(label)) {
        records.push({
          activityId: parent.id,
          field: key,
          fieldLabel: label,
          oldValue: parentVal ?? null,
          newValue: childVal,
          changedAt: `${TERM_YEAR}-09-19T00:00:00.000Z`,
          reason: `数据源补充通知 ${entry.id}`,
          source: 'seed',
        });
      }
      parent.fields[key] = childVal;
    }
  }

  return {
    state: {
      schemaVersion: SCHEMA_VERSION,
      term: TERM,
      generatedAt: nowIso(),
      activities,
    },
    records,
  };
}

async function loadState() {
  if (activitiesCache && historyCache) return;
  const seed = JSON.parse(await fsp.readFile(SEED_FILE, 'utf8'));
  let state = null;
  let records = null;

  try {
    state = JSON.parse(await fsp.readFile(ACTIVITIES_FILE, 'utf8'));
  } catch {
    state = null;
  }

  if (!state || !Array.isArray(state.activities) || state.activities.length === 0) {
    const built = buildInitialState(seed);
    state = built.state;
    records = built.records;
    console.log(`[init] 已由种子数据生成 ${state.activities.length} 条活动`);
  }

  // 补齐缺失的补充口令（这样删除某个活动的 editToken 后重启即可重置）
  let tokenAdded = 0;
  for (const a of state.activities) {
    if (!a.editToken) { a.editToken = newToken(); tokenAdded++; }
  }
  if (tokenAdded) console.log(`[init] 已为 ${tokenAdded} 条活动生成补充口令`);

  if (!state.term) state.term = TERM;

  try {
    historyCache = JSON.parse(await fsp.readFile(HISTORY_FILE, 'utf8'));
    if (!Array.isArray(historyCache.records)) historyCache = { records: [] };
  } catch {
    historyCache = { records: records || [] };
  }
  activitiesCache = state;

  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await enqueueWrite(async () => {
    await atomicWriteJson(ACTIVITIES_FILE, activitiesCache);
    await atomicWriteJson(HISTORY_FILE, historyCache);
  });
}

function findActivity(id) {
  return activitiesCache.activities.find((a) => a.id === id) || null;
}

/** 去除补充口令后的对外视图——这是本服务最需要小心的一处 */
function publicView(activity) {
  const { editToken, ...rest } = activity;
  return rest;
}

// ---------------------------------------------------------------- 状态与日期

const KEY_LABELS = {
  audience: '面向人群', threshold: '参与门槛', commitment: '投入要求', requirement: '要求',
  location: '地点', location_status: '地点状态', schedule: '时间',
  deadline: '报名截止', deadline_status: '截止状态', quota: '名额',
  cost: '费用', outcome: '收获', signup_mode: '报名方式',
};

const DATE_RE = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
const TIME_RE = /(\d{1,2}):(\d{2})/g;

/**
 * 从形如「9月24日 22:00」「9月27日 8:30—17:00」的文本中解析时间点。
 * 规则：取最后一个「M月D日」，配合该日期之后（或全串最后一个）时间；无时间则按当日 23:59。
 * 数据源中的日期没有年份，按学期年份补全（8–12 月为学期年，1–7 月为次年）。
 */
function parseWhen(text) {
  if (!text || typeof text !== 'string') return null;
  const dates = [];
  let m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(text))) dates.push({ month: +m[1], day: +m[2], index: m.index });
  if (!dates.length) return null;
  const last = dates[dates.length - 1];

  const times = [];
  TIME_RE.lastIndex = 0;
  while ((m = TIME_RE.exec(text))) times.push({ h: +m[1], mi: +m[2], index: m.index });
  const after = times.filter((t) => t.index > last.index);
  const use = after.length ? after[after.length - 1] : (times.length ? times[times.length - 1] : null);

  const year = last.month >= 8 ? TERM_YEAR : TERM_YEAR + 1;
  const d = new Date(year, last.month - 1, last.day, use ? use.h : 23, use ? use.mi : 59, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 计算时效状态。不落库，每次请求实时计算，避免数据随时间失真。
 * 优先级：已结束 > 报名已截止 > 长期 > 无需报名 > 地点待定 > 报名中
 */
function computeStatus(activity, now) {
  const f = activity.fields || {};

  const when = parseWhen(f.schedule);
  if (when && when < now) return '已结束';

  if (f.deadline_status === '已截止') return '报名已截止';
  const dl = parseWhen(f.deadline);
  if (dl && f.deadline_status === '明确' && dl < now) return '报名已截止';

  if (f.deadline_status === '长期') return '长期';
  if (f.deadline_status === '无需报名') return '无需报名';
  if (f.location_status === '待确认') return '地点待定';
  return '报名中';
}

/** 卡片上必须显式呈现的缺失项（"未注明" ≠ "没有"） */
function missingFields(activity) {
  const f = activity.fields || {};
  const out = [];
  if (!f.location) out.push('location');
  if (!f.deadline) out.push('deadline');
  if (!f.quota) out.push('quota');
  if (!f.cost) out.push('cost');
  if (!f.outcome) out.push('outcome');
  return out;
}

function listItem(activity, now, history) {
  const status = computeStatus(activity, now);
  const hasUpdates = history.some((r) => r.activityId === activity.id);
  return {
    id: activity.id,
    name: activity.name,
    status,
    category: activity.category,
    riskLevel: activity.riskLevel,
    fields: activity.fields,
    missing: missingFields(activity),
    hasUpdates,
    updatedAt: activity.updatedAt,
  };
}

// ---------------------------------------------------------------- 附件

function listFiles(id) {
  const dir = path.join(UPLOAD_DIR, id);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.endsWith('.tmp'))
    .map((n) => {
      const st = fs.statSync(path.join(dir, n));
      const ext = path.extname(n).toLowerCase();
      return {
        name: n,
        size: st.size,
        ext,
        type: ALLOWED_TYPES[ext] || 'application/octet-stream',
        uploadedAt: st.mtime.toISOString(),
        url: `/files/${id}/${encodeURIComponent(n)}`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/** 文件名安全化：去掉路径成分与控制字符 */
function safeName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop() || '';
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned || 'file';
}

function dedupeName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

const MAGIC = {
  '.png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  '.jpg': [0xff, 0xd8, 0xff],
  '.jpeg': [0xff, 0xd8, 0xff],
  '.gif': [0x47, 0x49, 0x46, 0x38],
  '.pdf': [0x25, 0x50, 0x44, 0x46],
  '.docx': [0x50, 0x4b, 0x03, 0x04],
  '.pptx': [0x50, 0x4b, 0x03, 0x04], // 与 docx 同为 ZIP 容器，无法仅凭文件头区分
};

function magicOk(ext, buf) {
  if (ext === '.txt' || ext === '.md') {
    // 无魔数：以「不含 NUL 字节」判定为文本
    const head = buf.subarray(0, Math.min(4096, buf.length));
    for (const b of head) if (b === 0) return false;
    return head.length > 0;
  }
  if (ext === '.webp') {
    return startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.length >= 12 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  }
  const sig = MAGIC[ext];
  return sig ? startsWith(buf, sig) : false;
}

/** 校验上传文件：扩展名白名单 + 大小上限 + 文件头 */
function validateFile(name, buf) {
  const ext = path.extname(name || '').toLowerCase();
  if (!ALLOWED_TYPES[ext]) {
    return {
      ok: false, code: 'unsupported_type',
      message: `不支持的格式「${ext || '无扩展名'}」，仅支持 ${Object.keys(ALLOWED_TYPES).join(' ')}`,
    };
  }
  if (buf.length === 0) {
    return { ok: false, code: 'bad_request', message: '文件内容为空' };
  }
  if (buf.length > MAX_FILE_SIZE) {
    return { ok: false, code: 'too_large', message: `文件超过 ${MAX_FILE_SIZE / 1024 / 1024}MB 上限` };
  }
  if (!magicOk(ext, buf)) {
    return {
      ok: false, code: 'unsupported_type',
      message: `文件内容与扩展名「${ext}」不符（已做文件头校验）`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- HTTP 工具

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function fail(res, code, error, message) {
  sendJson(res, code, { error, message });
}

function readBody(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  // 阻断路径穿越：解析后必须仍在 public/ 之内
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return fail(res, 404, 'not_found', '资源不存在');
  }
  let data;
  try {
    data = await fsp.readFile(target);
  } catch {
    return fail(res, 404, 'not_found', '资源不存在');
  }
  const type = STATIC_MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  res.end(data);
}

async function serveUpload(res, urlPath) {
  const parts = urlPath.split('/').filter(Boolean); // ['files', id, name]
  if (parts.length < 3) return fail(res, 404, 'not_found', '附件不存在');
  const id = parts[1];
  if (!/^\d{2}$/.test(id)) return fail(res, 404, 'not_found', '附件不存在');
  const name = decodeURIComponent(parts.slice(2).join('/'));
  const dir = path.join(UPLOAD_DIR, id);
  const target = path.resolve(dir, name);
  if (!target.startsWith(dir + path.sep)) return fail(res, 404, 'not_found', '附件不存在');
  let data;
  try {
    data = await fsp.readFile(target);
  } catch {
    return fail(res, 404, 'not_found', '附件不存在');
  }
  const ext = path.extname(target).toLowerCase();
  const type = ALLOWED_TYPES[ext] || 'application/octet-stream';
  const download = ext === '.pptx' ? '; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(target)) : '';
  res.writeHead(200, {
    'content-type': type,
    'content-length': data.length,
    'content-disposition': 'inline' + download,
    'cache-control': 'no-cache',
  });
  res.end(data);
}

// ---------------------------------------------------------------- 口令与限流

function tokenOk(activity, supplied) {
  if (!activity.editToken || typeof supplied !== 'string' || !supplied) return false;
  const a = Buffer.from(activity.editToken, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const rateBuckets = new Map();
function rateLimited(key) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW);
  if (arr.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(key, arr);
    return true;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return false;
}

// ---------------------------------------------------------------- API

function applyFields(activity, patch, reason) {
  const changed = [];
  const records = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (!EDITABLE_FIELDS.includes(key)) continue;
    let value = raw;
    if (typeof value === 'string') {
      value = value.trim();
      if (value === '') value = null;
    }
    if (value !== null && typeof value !== 'string') continue; // 只接受字符串或 null

    const oldValue = activity.fields[key] ?? null;
    if (oldValue === value) continue;
    activity.fields[key] = value;
    changed.push(key);
    records.push({
      activityId: activity.id,
      field: key,
      fieldLabel: KEY_LABELS[key] || key,
      oldValue,
      newValue: value,
      changedAt: nowIso(),
      reason: reason || '',
      source: 'organizer',
    });
  }
  return { changed, records };
}

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const now = new Date();

  // GET /api/activities
  if (seg.length === 2 && seg[1] === 'activities' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const threshold = url.searchParams.get('threshold') || '';
    const status = url.searchParams.get('status') || '';
    const includeClosed = url.searchParams.get('includeClosed') === '1';
    const includeRisk = url.searchParams.get('includeRisk') !== '0';

    let items = activitiesCache.activities.filter((a) => !a.merged);
    if (!includeRisk) items = items.filter((a) => a.riskLevel !== 'high');

    let mapped = items.map((a) => listItem(a, now, historyCache.records));

    if (!includeClosed) {
      mapped = mapped.filter((it) => it.status !== '已结束' && it.status !== '报名已截止');
    }
    if (status) mapped = mapped.filter((it) => it.status === status);
    if (threshold) {
      mapped = mapped.filter((it) => {
        const t = it.fields.threshold || '';
        return threshold === '零基础' ? /零基础|不限基础/.test(t) : t.includes(threshold);
      });
    }
    if (q) {
      mapped = mapped.filter((it) => {
        const hay = [
          it.id, it.name, it.category, it.fields.location, it.fields.schedule,
          it.fields.deadline, it.fields.threshold, it.fields.audience,
          it.fields.requirement, it.fields.cost, it.fields.outcome,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }

    return sendJson(res, 200, { total: mapped.length, term: activitiesCache.term, items: mapped });
  }

  // /api/activities/:id...
  if (seg.length >= 3 && seg[1] === 'activities') {
    const id = seg[2];
    const activity = findActivity(id);
    if (!activity) return fail(res, 404, 'not_found', `活动 ${id} 不存在`);

    // GET /api/activities/:id
    if (seg.length === 3 && req.method === 'GET') {
      const history = historyCache.records
        .filter((r) => r.activityId === id)
        .sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt)));
      const mergedFrom = activitiesCache.activities
        .filter((a) => a.merged && a.parentId === id)
        .map((a) => a.id);
      return sendJson(res, 200, {
        activity: {
          ...publicView(activity),
          status: computeStatus(activity, now),
          missing: missingFields(activity),
        },
        files: listFiles(id),
        history,
        mergedFrom,
      });
    }

    // GET /api/activities/:id/verify
    if (seg.length === 4 && seg[3] === 'verify' && req.method === 'GET') {
      const token = url.searchParams.get('token') || '';
      if (!tokenOk(activity, token)) {
        return fail(res, 403, 'invalid_token', '补充口令无效或已重置');
      }
      return sendJson(res, 200, { ok: true, id: activity.id, name: activity.name });
    }

    // PUT /api/activities/:id
    if (seg.length === 3 && req.method === 'PUT') {
      const token = url.searchParams.get('token') || '';
      if (!tokenOk(activity, token)) {
        return fail(res, 403, 'invalid_token', '补充口令无效或已重置');
      }
      if (rateLimited(token)) {
        return fail(res, 429, 'rate_limited', '提交过于频繁，请稍后再试');
      }
      let patch;
      try {
        const raw = await readBody(req);
        patch = JSON.parse(raw.toString('utf8') || '{}');
      } catch (e) {
        if (e.code === 'too_large') return fail(res, 413, 'too_large', '请求体过大');
        return fail(res, 400, 'bad_request', '请求体不是合法 JSON');
      }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return fail(res, 400, 'bad_request', '请求体应为 JSON 对象');
      }
      const reason = typeof patch.reason === 'string' ? patch.reason.trim() : '';
      if (reason && reason.length > 200) return fail(res, 400, 'bad_request', '变更原因过长');

      const { changed, records } = applyFields(activity, patch, reason);
      if (changed.length === 0) {
        return sendJson(res, 200, { ok: true, changed: [], updatedAt: activity.updatedAt });
      }
      activity.updatedAt = nowIso();
      historyCache.records.push(...records);
      await enqueueWrite(async () => {
        await atomicWriteJson(ACTIVITIES_FILE, activitiesCache);
        await atomicWriteJson(HISTORY_FILE, historyCache);
      });
      console.log(`[update] ${id} 变更字段: ${changed.join(', ')}`);
      return sendJson(res, 200, { ok: true, changed, updatedAt: activity.updatedAt });
    }

    // POST /api/activities/:id/files
    if (seg.length === 4 && seg[3] === 'files' && req.method === 'POST') {
      const token = url.searchParams.get('token') || '';
      if (!tokenOk(activity, token)) {
        return fail(res, 403, 'invalid_token', '补充口令无效或已重置');
      }
      if (rateLimited(token)) {
        return fail(res, 429, 'rate_limited', '提交过于频繁，请稍后再试');
      }

      // 前置保护：避免超大请求把整个 body 读进内存后才拒绝
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_UPLOAD_REQUEST) {
        return fail(res, 413, 'too_large',
          `上传请求超过 ${MAX_UPLOAD_REQUEST / 1024 / 1024}MB 上限，请减少文件数量或大小`);
      }

      let form;
      try {
        const r = new Request('http://localhost' + url.pathname + url.search, {
          method: 'POST',
          headers: req.headers,
          body: req,
          duplex: 'half',
        });
        form = await r.formData();
      } catch (e) {
        return fail(res, 400, 'bad_request', '无法解析上传内容：' + e.message);
      }

      const dir = path.join(UPLOAD_DIR, id);
      await fsp.mkdir(dir, { recursive: true });
      const existing = listFiles(id);
      const accepted = [];
      const rejected = [];

      for (const [, value] of form.entries()) {
        if (typeof value === 'string') continue;
        const buf = Buffer.from(await value.arrayBuffer());
        const original = value.name || 'file';
        const check = validateFile(original, buf);
        if (!check.ok) {
          rejected.push({ name: original, error: check.code, message: check.message });
          continue;
        }
        if (existing.length + accepted.length >= MAX_FILES_PER_ACTIVITY) {
          rejected.push({
            name: original, error: 'too_many_files',
            message: `单个活动最多 ${MAX_FILES_PER_ACTIVITY} 个附件`,
          });
          continue;
        }
        const finalName = dedupeName(dir, safeName(original));
        await fsp.writeFile(path.join(dir, finalName), buf);
        accepted.push(finalName);
      }

      if (accepted.length) {
        activity.updatedAt = nowIso();
        historyCache.records.push({
          activityId: id,
          field: 'files',
          fieldLabel: '活动资料',
          oldValue: null,
          newValue: accepted.join('、'),
          changedAt: nowIso(),
          reason: '上传活动资料',
          source: 'organizer',
        });
        await enqueueWrite(async () => {
          await atomicWriteJson(ACTIVITIES_FILE, activitiesCache);
          await atomicWriteJson(HISTORY_FILE, historyCache);
        });
        console.log(`[upload] ${id} 接收 ${accepted.length} 个文件: ${accepted.join(', ')}`);
      }

      if (!accepted.length && rejected.length) {
        const first = rejected[0];
        const STATUS_BY_ERROR = {
          bad_request: 400,
          too_many_files: 400,
          too_large: 413,
          unsupported_type: 415,
        };
        return fail(res, STATUS_BY_ERROR[first.error] || 415, first.error, first.message);
      }
      return sendJson(res, 200, { ok: true, accepted, rejected, files: listFiles(id) });
    }
  }

  return fail(res, 404, 'not_found', '接口不存在');
}

// ---------------------------------------------------------------- 启动

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/files/')) return await serveUpload(res, url.pathname);
    return await serveStatic(res, url.pathname);
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) fail(res, 500, 'internal', '服务器内部错误：' + err.message);
    else res.end();
  }
});

async function startServer(port = PORT, host = HOST) {
  await loadState();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server.address().port;
}

function serverUrl(port) {
  return `http://localhost:${port}`;
}

async function main() {
  if (process.argv.includes('--reset')) {
    // 重新由种子数据初始化（会丢弃全部补充与变更记录）
    await fsp.rm(DATA_DIR, { recursive: true, force: true });
    console.log('[reset] 已清空 data/，将从种子数据重新生成');
  }
  const port = await startServer();
  const n = activitiesCache.activities.filter((a) => !a.merged).length;
  console.log(`校园活动与机会平台 已启动: ${serverUrl(port)}`);
  console.log(`活动 ${n} 条 · 学期 ${activitiesCache.term} · 数据目录 ${DATA_DIR}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('启动失败:', e.message);
    process.exit(1);
  });
}

module.exports = {
  server, main, startServer, loadState,
  parseWhen, computeStatus, missingFields, safeName, validateFile, magicOk,
  statusOf: computeStatus,
  get paths() {
    return { ROOT, PUBLIC_DIR, DATA_DIR, UPLOAD_DIR, ACTIVITIES_FILE, HISTORY_FILE };
  },
  get state() { return activitiesCache; },
  get history() { return historyCache; },
  publicView,
  _internal: {
    buildInitialState, applyFields, atomicWriteJson, enqueueWrite, listFiles,
    ALLOWED_TYPES, EDITABLE_FIELDS, TERM, TERM_YEAR, MAX_FILE_SIZE, MAX_FILES_PER_ACTIVITY,
  },
};
