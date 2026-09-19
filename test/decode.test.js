'use strict';
/**
 * 中文编码与 OOXML 文本提取测试。
 *
 * 这两块都是「不测就会静默出错」的逻辑：
 *   - 中文 txt 大量是 GBK，按 UTF-8 读会乱码；
 *   - docx/pptx 的 ZIP 解析与 XML 文本抽取是自研代码，必须用真实容器验证。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const App = require('../public/app.js');
const OOXML = require('../public/ooxml.js');
const { makeDocx, makePptx, makeZip, UTF8_TEXT, GBK_TEXT } = require('./helpers');

test('decodeText 正确判定 UTF-8', () => {
  assert.equal(App.decodeText(UTF8_TEXT), '中文文本，UTF-8 编码。\n');
});

test('decodeText 正确判定并解码 GBK', () => {
  // “你好” 的 GBK 字节无法通过 UTF-8 严格模式，应回退 GBK
  assert.equal(App.decodeText(GBK_TEXT), '你好');
});

test('decodeText 处理纯 ASCII', () => {
  assert.equal(App.decodeText(Buffer.from('hello world', 'utf8')), 'hello world');
});

test('decodeText 处理空输入', () => {
  assert.equal(App.decodeText(Buffer.alloc(0)), '');
});

test('decodeText 接受 ArrayBuffer 与 Uint8Array', () => {
  const bytes = new Uint8Array(UTF8_TEXT);
  assert.equal(App.decodeText(bytes), '中文文本，UTF-8 编码。\n');
  assert.equal(App.decodeText(bytes.buffer), '中文文本，UTF-8 编码。\n');
});

test('xmlToText 按段落断行、折叠空行、还原实体', () => {
  const xml = '<w:p><w:r><w:t>第一段</w:t></w:r></w:p>' +
    '<w:p/>' +
    '<w:p><w:r><w:t>第二段 &amp; 符号 &lt;标签&gt;</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>第三段</w:t></w:r></w:p>';
  const text = OOXML.xmlToText(xml);
  assert.deepEqual(text.split('\n'), ['第一段', '第二段 & 符号 <标签>', '第三段']);
});

test('xmlToText 数字实体与制表符', () => {
  const text = OOXML.xmlToText('<w:p><w:r><w:t>&#x4e2d;&#25991;</w:t><w:tab/><w:t>缩进</w:t></w:r></w:p>');
  assert.equal(text, '中文\t缩进');
});

test('xmlToText 断行标记 <w:br/> 生效', () => {
  const text = OOXML.xmlToText('<w:p><w:r><w:t>上行</w:t><w:br/><w:t>下行</w:t></w:r></w:p>');
  assert.deepEqual(text.split('\n'), ['上行', '下行']);
});

test('docxToText 从真实 ZIP 容器中提取正文', async () => {
  const docx = await makeDocx(
    '<w:p><w:r><w:t>活动名称：测试活动</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>01</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>9月24日报名截止</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
  );
  const r = await OOXML.docxToText(docx);
  assert.equal(r.truncated, false);
  assert.match(r.text, /活动名称：测试活动/);
  assert.match(r.text, /01/);
  assert.match(r.text, /9月24日报名截止/);
});

test('docxToText 对非 OOXML 内容给出明确错误', async () => {
  await assert.rejects(() => OOXML.docxToText(Buffer.from('这不是 ZIP', 'utf8')), /ZIP/);
  const zipWithoutDoc = await makeZip({ 'foo.txt': 'hello' });
  await assert.rejects(() => OOXML.docxToText(zipWithoutDoc), /document\.xml/);
});

test('pptxSlides 按页顺序提取文字', async () => {
  const pptx = await makePptx(['封面标题', '第二页要点', '第三页总结']);
  const slides = await OOXML.pptxSlides(pptx);
  assert.equal(slides.length, 3);
  assert.deepEqual(slides.map((s) => s.slide), [1, 2, 3]);
  assert.equal(slides[0].text, '封面标题');
  assert.equal(slides[2].text, '第三页总结');
});

test('pptxSlides 对不含幻灯片的 ZIP 报错', async () => {
  const zip = await makeZip({ 'word/document.xml': '<x/>' });
  await assert.rejects(() => OOXML.pptxSlides(zip), /幻灯片/);
});

test('centralDirectory 解析出条目并识别压缩方式', async () => {
  const zip = await makeZip({ 'a.txt': '内容 A', 'b/c.txt': '内容 B' });
  const entries = OOXML.centralDirectory(zip);
  assert.deepEqual(entries.map((e) => e.name).sort(), ['a.txt', 'b/c.txt']);
  for (const e of entries) assert.equal(e.method, 8, '应为 deflate 压缩');
});

test('超长文档被截断并给出标记', async () => {
  const long = '<w:p><w:r><w:t>' + '很长的内容'.repeat(5000) + '</w:t></w:r></w:p>';
  const docx = await makeDocx(long);
  const r = await OOXML.docxToText(docx);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= OOXML.MAX_TEXT + 64, '未按上限截断');
  assert.match(r.text, /已截断/);
});

test('校验工具：合成容器确实以 ZIP 魔数开头', async () => {
  const docx = await makeDocx();
  assert.deepEqual([...docx.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
});
