'use strict';
/**
 * 前端渲染逻辑测试（不依赖浏览器）。
 *
 * 重点覆盖 XSS：活动名称、组织者补充内容、Markdown 与 docx 正文都可能带恶意文本，
 * 全部经由公共渲染函数输出，因此这些转义规则必须被测住。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const App = require('../public/app.js');
const OOXML = require('../public/ooxml.js');

test('esc 转义全部 HTML 敏感字符', () => {
  assert.equal(App.esc('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(App.esc('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
  assert.equal(App.esc(null), '');
  assert.equal(App.esc(undefined), '');
  assert.equal(App.esc(0), '0');
});

test('known / val：空值一律显示为「未注明」而不是空白', () => {
  for (const v of [null, undefined, '', '   ', '未注明']) {
    const k = App.known(v);
    assert.equal(k.unknown, true, `${JSON.stringify(v)} 应判定为未注明`);
    assert.equal(k.text, '未注明');
    assert.match(App.val(v), /未注明/);
  }
  assert.equal(App.known('实验楼 A402').unknown, false);
  assert.equal(App.known('实验楼 A402').text, '实验楼 A402');
});

test('val 对正常值转义后输出', () => {
  assert.equal(App.val('<b>地点</b>'), '&lt;b&gt;地点&lt;/b&gt;');
});

test('combine 拼接多个字段并跳过空值', () => {
  assert.equal(App.combine(['全校学生', null, '零基础']), '全校学生　·　零基础');
  assert.match(App.combine([null, undefined, '']), /未注明/);
});

test('状态徽章映射到不同样式类', () => {
  assert.match(App.badge('报名中'), /badge open/);
  assert.match(App.badge('无需报名'), /badge free/);
  assert.match(App.badge('长期'), /badge long/);
  assert.match(App.badge('已结束'), /badge closed/);
  assert.match(App.badge('报名已截止'), /badge closed/);
  assert.match(App.badge('地点待定'), /badge pending/);
  // 未知状态不应抛错，退化为普通徽章
  assert.match(App.badge('某种新状态'), /badge closed/);
});

test('fmtSize 可读化', () => {
  assert.equal(App.fmtSize(512), '512 B');
  assert.equal(App.fmtSize(2048), '2 KB');
  assert.equal(App.fmtSize(5 * 1024 * 1024), '5.0 MB');
});

// ---------------------------------------------------------------- Markdown

test('Markdown 渲染内联 HTML 不生效（XSS）', () => {
  const html = App.markdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'), '原始 script 标签被输出');
  assert.match(html, /&lt;script&gt;/);

  const img = App.markdown('<img src=x onerror=alert(1)>');
  assert.ok(!img.includes('<img'), '原始 img 标签被输出');
});

test('Markdown 拒绝 javascript: 协议的链接', () => {
  const html = App.markdown('[点我](javascript:alert(1))');
  assert.ok(!/href="javascript:/i.test(html), '生成了 javascript: 链接');
  assert.ok(!html.includes('<a '), '不应生成任何链接');
});

test('Markdown 放行 http/https 链接并加安全属性', () => {
  const html = App.markdown('参考 [说明](https://example.com/a)');
  assert.match(html, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">说明<\/a>/);
});

test('Markdown 支持标题、粗体、行内代码与列表', () => {
  assert.match(App.markdown('## 二级标题'), /<h2>二级标题<\/h2>/);
  assert.match(App.markdown('**重点**'), /<strong>重点<\/strong>/);
  assert.match(App.markdown('行内 `code` 片段'), /<code>code<\/code>/);
  assert.match(App.markdown('- 第一项\n- 第二项'), /<ul>\n?<li>第一项<\/li>/);
});

test('Markdown 代码块内容不被后续规则改写且被转义', () => {
  const html = App.markdown('```\n<b>**不解析**</b>\n```');
  assert.match(html, /<pre>/);
  assert.ok(!html.includes('<b>'), '代码块内的标签未被转义');
  assert.match(html, /&lt;b&gt;/);
  assert.ok(!html.includes('<strong>'), '代码块内不应套用粗体规则');
});

test('Markdown 引用与分隔线', () => {
  assert.match(App.markdown('> 引用内容'), /<blockquote>引用内容<\/blockquote>/);
  assert.match(App.markdown('---'), /<hr>/);
});

test('Markdown 空输入不抛错', () => {
  assert.equal(App.markdown(null), '');
  assert.equal(App.markdown(''), '');
});

test('Markdown 与 docx 提取结果组合后仍安全', () => {
  // 模拟：docx 正文里含恶意标签 -> xmlToText -> 经 esc 输出
  const text = OOXML.xmlToText('<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>');
  assert.equal(text, '<script>alert(1)</script>');
  const safe = App.esc(text);
  assert.ok(!safe.includes('<script>'));
});

test('kindOf 按扩展名分派预览方式', () => {
  const cases = {
    '.png': 'image', '.jpg': 'image', '.gif': 'image', '.webp': 'image',
    '.pdf': 'pdf', '.txt': 'text', '.md': 'markdown',
    '.docx': 'docx', '.pptx': 'pptx', '.exe': 'other', '': 'other',
  };
  for (const [ext, kind] of Object.entries(cases)) {
    assert.equal(App.kindOf({ ext }), kind, `${ext} 分派错误`);
  }
});

test('renderFields 输出全部字段行且缺失项显示未注明', () => {
  const html = App.renderFields({
    requirement: '面向全校学生', audience: '全校学生', threshold: '零基础可参加',
    commitment: null, location: null, schedule: '9月24日', deadline: null,
    signup_mode: '站内报名', quota: null, cost: null, outcome: null,
  });
  for (const label of ['要求', '面向人群', '地点', '时间', '报名截止', '报名方式', '名额', '费用', '收获']) {
    assert.ok(html.includes('<dt>' + label + '</dt>'), `缺少字段行：${label}`);
  }
  // 地点/名额/费用/收获/报名截止 均为空 -> 应各自显示未注明
  assert.ok((html.match(/未注明/g) || []).length >= 5, '缺失字段未显示为未注明');
});
