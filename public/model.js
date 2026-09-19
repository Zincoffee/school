/**
 * model.js —— 领域模型（无 I/O，浏览器与 Node 通用）
 *
 * 这些逻辑同时被两处使用，因此必须只有一份实现：
 *   - `server.js`：服务版（多用户、补充口令、落盘持久化）
 *   - 离线单文件版：由 tools/build-standalone.js 内联
 *
 * 内容：种子数据 → 运行时结构的映射、合并条目（09/20）的变更记录与回填、
 *       时效状态计算、日期解析、缺失字段、字段补充应用。
 *
 * 与 app.js / ooxml.js 一样采用「浏览器挂全局 / Node 可 require」的写法。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Model = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const TERM = '2026 秋季学期';
  const TERM_YEAR = 2026;

  /** 允许修改的字段 */
  const EDITABLE_FIELDS = [
    'audience', 'threshold', 'commitment', 'requirement',
    'location', 'location_status',
    'schedule', 'deadline', 'deadline_status',
    'quota', 'cost', 'outcome', 'signup_mode',
  ];

  const KEY_LABELS = {
    audience: '面向人群', threshold: '参与门槛', commitment: '投入要求', requirement: '要求',
    location: '地点', location_status: '地点状态', schedule: '时间',
    deadline: '报名截止', deadline_status: '截止状态', quota: '名额',
    cost: '费用', outcome: '收获', signup_mode: '报名方式',
    files: '活动资料',
  };

  /** 详情页字段展示顺序 */
  const DETAIL_FIELDS = [
    'audience', 'threshold', 'commitment', 'location', 'schedule',
    'deadline', 'signup_mode', 'quota', 'cost', 'outcome',
  ];

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
   * 计算时效状态。不落库，每次实时计算，避免数据随时间失真。
   * 优先级：已结束 > 报名已截止 > 长期 > 无需报名 > 地点待定 > 报名中
   */
  function computeStatus(activity, now) {
    const f = (activity && activity.fields) || {};
    const ref = now instanceof Date ? now : new Date();

    const when = parseWhen(f.schedule);
    if (when && when < ref) return '已结束';

    if (f.deadline_status === '已截止') return '报名已截止';
    const dl = parseWhen(f.deadline);
    if (dl && f.deadline_status === '明确' && dl < ref) return '报名已截止';

    if (f.deadline_status === '长期') return '长期';
    if (f.deadline_status === '无需报名') return '无需报名';
    if (f.location_status === '待确认') return '地点待定';
    return '报名中';
  }

  /** 卡片上必须显式呈现的缺失项（"未注明" ≠ "没有"） */
  function missingFields(activity) {
    const f = (activity && activity.fields) || {};
    const out = [];
    if (!f.location) out.push('location');
    if (!f.deadline) out.push('deadline');
    if (!f.quota) out.push('quota');
    if (!f.cost) out.push('cost');
    if (!f.outcome) out.push('outcome');
    return out;
  }

  /** 卡片墙的一项 */
  function listItem(activity, now, history) {
    const records = history || [];
    return {
      id: activity.id,
      name: activity.name,
      status: computeStatus(activity, now),
      category: activity.category,
      riskLevel: activity.riskLevel,
      fields: activity.fields,
      missing: missingFields(activity),
      hasUpdates: records.some((r) => r.activityId === activity.id),
      updatedAt: activity.updatedAt,
    };
  }

  /** 把种子数据的一条记录映射为运行时结构 */
  function mapSeedEntry(entry, token) {
    return {
      id: entry.id,
      name: entry.name,
      editToken: token === undefined ? null : token,
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
   * 合并条目（09、20）不单独出卡：其变更写入父活动的变更记录，
   * 并把子条目有效的地点字段回填给父活动（数据源明确「地点以 09 为准」）。
   *
   * @param {object} seed  种子数据
   * @param {object} clock { newToken?: () => string, now?: () => string }
   */
  function buildInitialState(seed, clock) {
    const opts = clock || {};
    const now = opts.now || (() => new Date().toISOString());
    const newToken = opts.newToken || (() => null);
    const stamp = `${TERM_YEAR}-09-19T00:00:00.000Z`;

    const activities = seed.entries.map((e) => mapSeedEntry(e, newToken()));
    const byId = new Map(activities.map((a) => [a.id, a]));
    const records = [];

    for (const entry of seed.entries) {
      if (!entry.merged || !entry.parent_id) continue;
      const parent = byId.get(entry.parent_id);
      if (!parent) continue;

      // 1) 补充通知里的变更 → 父活动的初始变更记录
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
          changedAt: stamp,
          reason: `数据源补充通知 ${entry.id}`,
          source: 'seed',
        });
      }

      // 2) 回填地点；若 changes 已就该字段记过一条，则不重复记录
      for (const key of ['location', 'location_status']) {
        const childVal = entry[key];
        const parentVal = parent.fields[key];
        const parentEmpty = parentVal === null || parentVal === undefined || parentVal === '未注明';
        if (!childVal || childVal === '未注明' || !parentEmpty) continue;
        const label = KEY_LABELS[key] || key;
        if (!coveredLabels.has(label)) {
          records.push({
            activityId: parent.id,
            field: key,
            fieldLabel: label,
            oldValue: parentVal ?? null,
            newValue: childVal,
            changedAt: stamp,
            reason: `数据源补充通知 ${entry.id}`,
            source: 'seed',
          });
        }
        parent.fields[key] = childVal;
      }
    }

    return {
      state: { schemaVersion: SCHEMA_VERSION, term: TERM, generatedAt: now(), activities },
      records,
    };
  }

  /**
   * 应用一次字段补充，返回改动字段与被修改的活动。
   * 只接受字符串或 null（空字符串视为清空）；不可编辑字段一律忽略。
   */
  function applyFields(activity, patch, reason, clock) {
    const opts = clock || {};
    const now = opts.now || (() => new Date().toISOString());
    const changed = [];
    const records = [];

    for (const [key, raw] of Object.entries(patch || {})) {
      if (!EDITABLE_FIELDS.includes(key)) continue;
      let value = raw;
      if (typeof value === 'string') {
        value = value.trim();
        if (value === '') value = null;
      }
      if (value !== null && typeof value !== 'string') continue;

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
        changedAt: now(),
        reason: reason || '',
        source: opts.source || 'organizer',
      });
    }
    return { changed, records };
  }

  /** 非合并条目（会出现在卡片墙上的活动） */
  function visibleActivities(state) {
    return (state.activities || []).filter((a) => !a.merged);
  }

  /** 某个活动的补充通知编号 */
  function mergedFrom(state, id) {
    return (state.activities || []).filter((a) => a.merged && a.parentId === id).map((a) => a.id);
  }

  /** 某活动的变更记录，按时间倒序 */
  function historyOf(records, id) {
    return (records || [])
      .filter((r) => r.activityId === id)
      .slice()
      .sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt)));
  }

  return {
    SCHEMA_VERSION, TERM, TERM_YEAR,
    EDITABLE_FIELDS, KEY_LABELS, DETAIL_FIELDS,
    parseWhen, computeStatus, missingFields, listItem,
    mapSeedEntry, buildInitialState, applyFields,
    visibleActivities, mergedFrom, historyOf,
  };
});
