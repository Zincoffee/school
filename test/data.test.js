'use strict';
/**
 * 种子数据完整性测试。
 * 种子数据是整个产品的内容基础，一旦枚举被写回自由文本或条目丢失，
 * 卡片渲染与筛选会静默出错，因此这里对它做严格校验。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./helpers');

const SEED_PATH = path.join(REPO, 'design', 'activities.seed.json');
const MD_PATH = path.join(REPO, 'design', '已知校园活动汇总.md');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const entries = seed.entries;

test('种子数据：26 条活动', () => {
  assert.equal(entries.length, 26);
  assert.equal(seed._meta.entry_count, 26);
});

test('编号唯一、连续且为两位数字', () => {
  const ids = entries.map((e) => e.id);
  assert.equal(new Set(ids).size, 26, '编号存在重复');
  const expected = Array.from({ length: 26 }, (_, i) => String(i + 1).padStart(2, '0'));
  assert.deepEqual([...ids].sort(), expected);
  for (const id of ids) assert.match(id, /^\d{2}$/);
});

test('每条活动都有名称与原始描述', () => {
  for (const e of entries) {
    assert.ok(e.name && e.name.trim(), `${e.id} 缺少名称`);
    assert.ok(e.raw && e.raw.trim(), `${e.id} 缺少原始描述`);
  }
});

test('枚举字段取值合法（防止被写回自由文本）', () => {
  const enums = {
    location_status: ['明确', '线上', '待确认', '未注明'],
    deadline_status: ['明确', '已截止', '长期', '未注明', '无需报名', '继承父活动'],
    signup_mode: ['无需报名', '站内报名', '需登记', '需审核', '站内组队', '外链', '站外私聊', '候补', '未注明', null],
    risk_level: ['none', 'low', 'medium', 'high'],
  };
  for (const [field, allowed] of Object.entries(enums)) {
    for (const e of entries) {
      assert.ok(allowed.includes(e[field]),
        `${e.id} 的 ${field} 取值非法: ${JSON.stringify(e[field])}`);
    }
  }
});

test('合并条目（09、20）指向存在的父活动且不单独成卡', () => {
  const merged = entries.filter((e) => e.merged);
  assert.deepEqual(merged.map((e) => e.id).sort(), ['09', '20']);
  for (const e of merged) {
    assert.ok(e.parent_id, `${e.id} 缺 parent_id`);
    const parent = entries.find((x) => x.id === e.parent_id);
    assert.ok(parent, `${e.id} 的父活动 ${e.parent_id} 不存在`);
    assert.ok(!parent.merged, `${e.parent_id} 本身也是合并条目`);
    assert.ok(Array.isArray(e.changes) && e.changes.length > 0, `${e.id} 缺变更明细`);
  }
});

test('补充通知的 changes 字段结构完整', () => {
  for (const e of entries.filter((x) => x.merged)) {
    for (const ch of e.changes) {
      assert.ok(ch.field, `${e.id} 的变更缺 field`);
      assert.ok('from' in ch && 'to' in ch, `${e.id} 的变更缺 from/to`);
    }
  }
});

test('种子数据与 已知校园活动汇总.md 逐条一致', () => {
  const md = fs.readFileSync(MD_PATH, 'utf8');
  const rows = md.split(/\r?\n/)
    .filter((l) => /^\|\s*\d{2}\s*\|/.test(l))
    .map((l) => l.replace(/^\|\s*/, '').replace(/\s*\|\s*$/, '').split(/\s*\|\s*/));
  assert.equal(rows.length, 26, 'Markdown 表格应有 26 条数据行');
  for (let i = 0; i < 26; i++) {
    const [id, name, raw] = rows[i];
    const e = entries[i];
    assert.equal(e.id, id, `第 ${i + 1} 行编号不符`);
    assert.equal(e.name, name, `编号 ${id} 名称与 Markdown 不一致`);
    assert.equal(e.raw, raw, `编号 ${id} 主要内容与 Markdown 不一致`);
  }
});

test('_meta.coverage 与实际统计一致', () => {
  const c = seed._meta.coverage;
  const count = (fn) => entries.filter(fn).length;
  assert.equal(c['线下明确地点'], count((e) => e.location_status === '明确'));
  assert.equal(c['线上无需地点'], count((e) => e.location_status === '线上'));
  assert.equal(c['地点待确认'], count((e) => e.location_status === '待确认'));
  assert.equal(c['地点未注明'], count((e) => e.location_status === '未注明'));
  assert.equal(c['面向人群'], count((e) => e.audience != null));
  assert.equal(c['参与门槛'], count((e) => e.threshold != null));
  assert.equal(c['投入要求'], count((e) => e.commitment != null));
  assert.equal(c['具体时间'], count((e) => e.schedule != null));
  assert.equal(c['名额'], count((e) => e.quota != null));
  assert.equal(c['费用'], count((e) => e.cost != null));
  assert.equal(c['收获'], count((e) => e.outcome != null));
});

test('覆盖率的关键结论未变（产品承诺边界的依据）', () => {
  const c = seed._meta.coverage;
  // 这三个数字是设计方案 §7.1 的结论依据，若数据被改动需同步修订文档
  assert.equal(c['线下明确地点'], 4, '线下明确地点数量变化，需同步修订设计方案 §7.1');
  assert.equal(c['收获'], 0, '收获字段出现了数据，需同步修订设计方案 §7.1');
  assert.equal(c['地点未注明'], 18, '地点未注明数量变化，需同步修订设计方案 §7.1');
});

test('枚举定义已在 _meta 中登记', () => {
  for (const k of ['location_status', 'signup_mode', 'deadline_status', 'risk_level']) {
    assert.ok(seed._meta.enums && seed._meta.enums[k], `_meta.enums 缺少 ${k}`);
  }
});
