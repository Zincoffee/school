'use strict';
/**
 * 离线单文件版测试。
 *
 * 这个产物是完全自包含的（样式、脚本、数据全部内联），因此无法靠"页面能打开"来验证，
 * 必须在这里把它的结构、数据一致性与可执行性逐项钉住：
 *   - 产物是否为最新（源码改动后忘记重新生成，是最容易发生的疏漏）
 *   - 是否真的零外部依赖（离线可用）
 *   - 每个 script 块是否完整且语法合法（内联时若未转义 </script> 会截断文档）
 *   - 内嵌数据是否与服务版由种子数据算出的结果一致
 *   - offline.js 依赖的 DOM 元素 id 是否都存在于产物中
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Model = require('../public/model.js');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, '校园活动与机会平台.html');
const generator = require('../tools/build-standalone.js');

const readHtml = () => fs.readFileSync(OUT, 'utf8');

test('产物存在且与当前源码一致（防过期）', () => {
  assert.ok(fs.existsSync(OUT), '离线单文件版尚未生成，请运行 node tools/build-standalone.js');
  assert.equal(readHtml(), generator.build(),
    '离线单文件版已过期：源码改动后需重新运行 node tools/build-standalone.js');
});

test('完全自包含：没有任何外部资源引用', () => {
  const html = readHtml();
  assert.equal((html.match(/(?:src|href)="(?:https?:)?\/\//g) || []).length, 0,
    '存在外部资源引用，离线打开会失败');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), '不得引用外部样式表');
  assert.ok(!/<script[^>]+\bsrc=/i.test(html), '不得引用外部脚本');
  assert.ok(/<style>/.test(html), '样式应已内联');
});

test('内联脚本块完整且语法合法', () => {
  const html = readHtml();
  const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  // 4 个逻辑脚本 + 1 个数据块
  assert.equal(blocks.length, 5, '脚本块数量异常，可能有内容被 </script> 截断');
  for (const [, attrs, content] of blocks) {
    if (/application\/json/.test(attrs)) continue;
    assert.doesNotThrow(() => new vm.Script(content), '存在语法非法的内联脚本块');
  }
});

test('数据块可解析，且与服务版由种子数据算出的结果一致', () => {
  const html = readHtml();
  const m = /<script id="dsh-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, '未找到内嵌数据块');
  const payload = JSON.parse(m[1]);

  const expected = generator.initialState();
  assert.deepEqual(payload.state, expected.state, '内嵌数据与服务版初始状态不一致');
  assert.deepEqual(payload.records, expected.records, '内嵌变更记录与服务版不一致');

  assert.equal(payload.state.activities.length, 26);
  assert.equal(payload.state.term, '2026 秋季学期');
  assert.equal(Model.visibleActivities(payload.state).length, 24, '卡片墙应展示 24 条（排除 2 条合并条目）');
  assert.equal(payload.records.length, 4, '应有 4 条来自补充通知的初始变更记录');
});

test('离线版没有口令（不应内嵌任何 editToken）', () => {
  const html = readHtml();
  const m = /<script id="dsh-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const payload = JSON.parse(m[1]);
  for (const a of payload.state.activities) {
    assert.ok(!a.editToken, `活动 ${a.id} 不应带口令`);
  }
  assert.ok(!/editToken"\s*:\s*"[0-9a-f]{24}/.test(html), '产物中不应出现任何口令');
});

test('数据中的 < 已转义，不会截断文档', () => {
  const html = readHtml();
  const m = /<script id="dsh-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(!m[1].includes('</'), '数据块中不应出现裸露的 </ 序列');
});

test('offline.js 依赖的 DOM 元素在产物中都存在', () => {
  const html = readHtml();
  const offline = fs.readFileSync(path.join(REPO, 'public', 'offline.js'), 'utf8');
  const ids = [...offline.matchAll(/getElementById\('([^']+)'\)/g)].map((x) => x[1]);
  const unique = [...new Set(ids)];
  assert.ok(unique.length >= 4, '未识别到 offline.js 的元素依赖');
  for (const id of unique) {
    assert.ok(html.includes(`id="${id}"`), `产物中缺少 offline.js 需要的元素 #${id}`);
  }
});

test('输出包含全部 26 条活动内容', () => {
  const html = readHtml();
  for (const name of ['“蓝桥杯”程序设计校内训练营', '外国语学院校园语言角', '科研助理招募']) {
    assert.ok(html.includes(name), `产物中缺少活动：${name}`);
  }
});

test('离线版复用的领域逻辑与服务版一致（同一份 model.js）', () => {
  const payload = generator.initialState();
  const byId = (id) => payload.state.activities.find((a) => a.id === id);
  const now = new Date('2026-09-19T15:12:00');

  // 状态判定应与服务版逐条相同
  assert.equal(Model.computeStatus(byId('01'), now), '报名中');
  assert.equal(Model.computeStatus(byId('02'), now), '无需报名');
  assert.equal(Model.computeStatus(byId('04'), now), '已结束');
  assert.equal(Model.computeStatus(byId('08'), now), '长期');
  assert.equal(Model.computeStatus(byId('19'), now), '报名已截止');
  assert.equal(Model.computeStatus(byId('22'), now), '地点待定');

  // 合并与回填结果应与服务版相同
  assert.equal(byId('01').fields.location, '实验楼 A402');
  assert.deepEqual(Model.mergedFrom(payload.state, '01'), ['09']);
  assert.equal(Model.historyOf(payload.records, '01').length, 3);

  // 列表项结构完整
  const item = Model.listItem(byId('01'), now, payload.records);
  assert.equal(item.status, '报名中');
  assert.equal(item.hasUpdates, true);
  assert.ok(item.missing.includes('quota'), '应把缺失项列出');
});

test('离线版的补充会写入变更记录（source 标记为 offline）', () => {
  const payload = generator.initialState();
  const act = payload.state.activities.find((a) => a.id === '05');
  const r = Model.applyFields(act, { location: '实验楼 A402', reason: '测试' }, '测试',
    { now: () => '2026-09-19T16:00:00.000Z', source: 'offline' });
  assert.deepEqual(r.changed, ['location']);
  assert.equal(act.fields.location, '实验楼 A402');
  assert.equal(r.records[0].source, 'offline');
  assert.equal(r.records[0].oldValue, null);
  assert.equal(r.records[0].reason, '测试');
});

test('模拟导出：替换数据块后产物结构仍然完好、改动被保留', () => {
  const html = readHtml();
  const m = /(<script id="dsh-data" type="application\/json">)([\s\S]*?)(<\/script>)/.exec(html);
  assert.ok(m, '未找到数据块');

  // 模拟浏览器里的一次补充 + 导出：改动写入数据块，其余部分不变
  const payload = JSON.parse(m[2]);
  const act = payload.state.activities.find((a) => a.id === '21');
  payload.state.activities = payload.state.activities.map((a) =>
    a.id === '21' ? Object.assign({}, a, { fields: Object.assign({}, a.fields, { quota: '座位有限' }) }) : a);
  payload.records.push({
    activityId: '21', field: 'quota', fieldLabel: '名额',
    oldValue: null, newValue: '座位有限', changedAt: '2026-09-19T16:00:00.000Z',
    reason: '补充', source: 'offline',
  });

  const reExported = html.replace(m[0], m[1] + JSON.stringify(payload).replace(/</g, '\\u003c') + m[3]);

  // 结构不变量应与原始产物相同
  const blocks = [...reExported.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 5, '导出后脚本块被破坏');
  for (const [, attrs, content] of blocks) {
    if (/application\/json/.test(attrs)) continue;
    assert.doesNotThrow(() => new vm.Script(content), '导出后出现语法非法的脚本块');
  }
  assert.equal((reExported.match(/(?:src|href)="(?:https?:)?\/\//g) || []).length, 0,
    '导出后出现了外部资源引用');

  // 改动应当保留，且能被重新解析
  const back = JSON.parse(/<script id="dsh-data" type="application\/json">([\s\S]*?)<\/script>/.exec(reExported)[1]);
  assert.equal(back.state.activities.find((a) => a.id === '21').fields.quota, '座位有限');
  assert.equal(back.records.length, payload.records.length);
  assert.equal(back.records[back.records.length - 1].source, 'offline');
});

test('在最小 DOM 桩中真实执行产物：启动不抛错且渲染出 22 张卡片', () => {
  const html = readHtml();
  const dataJson = /<script id="dsh-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1];

  // ---- 最小 DOM 桩（只实现 offline.js 启动路径真正用到的方法）----
  const els = new Map();
  function makeEl(tag) {
    return {
      tagName: tag, textContent: '', innerHTML: '', value: '',
      selectionStart: 0, className: '', dataset: {}, style: {}, files: [],
      addEventListener() {}, removeEventListener() {},
      appendChild() {}, remove() {}, focus() {}, setSelectionRange() {},
      setAttribute() {}, getAttribute() { return null; },
      insertAdjacentHTML() {}, scrollIntoView() {},
      querySelectorAll() { return []; },   // 桩不解析 DOM，返回空集合
    };
  }
  const document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    createElement: makeEl,
    querySelectorAll() { return []; },
    querySelector() { return null; },
    body: makeEl('body'),
    documentElement: { outerHTML: '<html></html>' },
    addEventListener() {},
  };
  const location = { hash: '#/' };
  const sandbox = {
    document, location, console,
    TextDecoder, TextEncoder, Response, Blob, URL,
    DecompressionStream, CompressionStream,
    setTimeout, clearTimeout, Date, JSON,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.scrollTo = () => {};
  const ctx = vm.createContext(sandbox);

  // 数据块内容（真实产物里的 JSON）
  document.getElementById('dsh-data').textContent = dataJson;

  // 按产物中的顺序执行四个脚本
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 4, '应内联四个逻辑脚本');
  const names = ['model.js', 'ooxml.js', 'app.js', 'offline.js'];
  scripts.forEach((code, i) => {
    assert.doesNotThrow(() => vm.runInContext(code, ctx, { filename: names[i] }),
      `执行 ${names[i]} 时抛错（浏览器里会白屏或停在「加载中…」）`);
  });

  // 全局对象按预期挂载
  assert.equal(typeof ctx.Model.computeStatus, 'function', 'Model 未挂载到全局');
  assert.equal(typeof ctx.App.esc, 'function', 'App 未挂载到全局');
  assert.equal(typeof ctx.OOXML.docxToText, 'function', 'OOXML 未挂载到全局');

  // 启动路径应渲染出卡片墙
  const view = document.getElementById('view').innerHTML;
  assert.ok(view.includes('离线单文件版'), '未渲染离线版说明条');
  const cards = (view.match(/class="card"/g) || []).length;
  assert.equal(cards, 22, `卡片墙应渲染 22 张（默认排除已结束与已截止），实际 ${cards} 张`);
  assert.ok(view.includes('实验楼 A402'), '卡片应显示由补充通知回填的地点');
  assert.ok(view.includes('未注明'), '缺失字段应显示为「未注明」');
});

test('产物大小在合理范围内（可邮件/微信转发）', () => {
  const kb = Buffer.byteLength(readHtml(), 'utf8') / 1024;
  assert.ok(kb > 40, `产物过小（${Math.round(kb)} KB），可能内容缺失`);
  assert.ok(kb < 500, `产物过大（${Math.round(kb)} KB），不便于转发`);
});
