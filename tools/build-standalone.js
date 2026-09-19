'use strict';
/**
 * build-standalone.js —— 生成离线单文件版
 *
 * 把样式、共享脚本（model / ooxml / app / offline）与 26 条活动数据
 * 全部内联进一个 HTML，产出可以直接双击打开、也可以单独转发的文件。
 *
 * 为什么要生成而不是手写一份：渲染、编码探测、docx 提取这些逻辑必须只有一份实现，
 * 否则离线版与服务版会逐渐不一致。这里只做"打包"，不改写任何逻辑。
 *
 * 用法：
 *   node tools/build-standalone.js            # 生成 / 覆盖产物
 *   node tools/build-standalone.js --check    # 只校验产物是否为最新（供测试使用）
 */
const fs = require('node:fs');
const path = require('node:path');
const Model = require('../public/model.js');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SEED_FILE = path.join(ROOT, 'design', 'activities.seed.json');
const OUT_FILE = path.join(ROOT, '校园活动与机会平台.html');

const TITLE = '校园活动与机会平台 · 离线版';

function read(rel) {
  return fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
}

/** 内联脚本时防止内容里的 </script> 提前截断文档 */
function safeScript(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

/** 内联 JSON 时把 < 转义，防止数据中出现 </script> */
function safeJson(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

/**
 * 由种子数据构造初始状态（与 server.js 首次启动完全相同的逻辑）。
 *
 * 注意 generatedAt 使用种子数据的基准时间而不是"当前时间"：
 * 这样产物是**可复现**的——同样的源码一定生成同样的文件，
 * 否则「产物是否为最新」的校验永远失败，提交也会产生无意义的 diff。
 */
function initialState() {
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const built = Model.buildInitialState(seed, {
    // 离线版没有口令机制，editToken 留空
    newToken: () => null,
    now: () => `${Model.TERM_YEAR}-09-19T00:00:00.000Z`,
  });
  return { state: built.state, records: built.records };
}

/** 返回完整的单文件 HTML 文本 */
function build() {
  const css = read('style.css');
  const payload = initialState();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<style>
${css}
.offline-banner {
  background: var(--accent-soft);
  color: #1b3f86;
  border: 1px solid #cddffb;
  border-radius: var(--radius);
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.7;
  margin: 14px 0 4px;
}
.offline-banner code { background: #fff; border-radius: 4px; padding: 1px 5px; }
.msg.inline { display: inline-block; margin: 0; padding: 4px 10px; font-size: 12.5px; }
.head-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-left: auto; }
</style>
</head>
<body>

<header class="site-head">
  <div class="inner">
    <a class="site-title" href="#/">校园活动与机会平台</a>
    <span class="site-sub">离线单文件版</span>
    <span class="head-actions">
      <span id="save-state"></span>
      <button class="btn secondary" id="export-json">导出数据</button>
      <button class="btn" id="export-html">导出 HTML</button>
    </span>
  </div>
</header>

<div class="wrap">
  <div id="view"><div class="empty">加载中…</div></div>
</div>

<!-- 活动数据（导出的新文件会替换这一块的内容） -->
<script id="dsh-data" type="application/json">${safeJson(payload)}</script>

<script>
${safeScript(read('model.js'))}
</script>
<script>
${safeScript(read('ooxml.js'))}
</script>
<script>
${safeScript(read('app.js'))}
</script>
<script>
${safeScript(read('offline.js'))}
</script>
</body>
</html>
`;
}

function main() {
  const check = process.argv.includes('--check');
  const html = build();
  if (check) {
    if (!fs.existsSync(OUT_FILE)) {
      console.error('✗ 离线单文件版尚未生成，请运行: node tools/build-standalone.js');
      process.exit(1);
    }
    const current = fs.readFileSync(OUT_FILE, 'utf8');
    if (current !== html) {
      console.error('✗ 离线单文件版已过期（源码改动后未重新生成）');
      console.error('  请运行: node tools/build-standalone.js');
      process.exit(1);
    }
    console.log('✓ 离线单文件版为最新（' +
      Math.round(Buffer.byteLength(current, 'utf8') / 1024) + ' KB）');
    return;
  }
  fs.writeFileSync(OUT_FILE, html, 'utf8');
  const kb = Math.round(Buffer.byteLength(html, 'utf8') / 1024);
  console.log('已生成: ' + path.relative(ROOT, OUT_FILE) + '  (' + kb + ' KB)');
  console.log('  活动 ' + initialState().state.activities.filter((a) => !a.merged).length + ' 条，数据与脚本均已内联，可离线双击打开');
}

module.exports = { build, OUT_FILE, TITLE, initialState };

if (require.main === module) main();
