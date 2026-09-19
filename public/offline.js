/**
 * offline.js —— 离线单文件版的页面逻辑
 *
 * 由 tools/build-standalone.js 内联进生成的 HTML，不单独部署。
 *
 * 与「服务版」的区别：
 *   - 数据来自页内内嵌的 <script id="dsh-data">，不请求任何接口（file:// 下 fetch 被浏览器拦截）
 *   - 补充内容保存在内存 + 同步回数据块；「导出」会下载一个新的单文件 HTML，替换旧的那份即可
 *   - 不使用 localStorage / IndexedDB —— 这两种存储在 file:// 下各家浏览器行为不一致，不能依赖
 *   - 无补充口令、无多人共享：任何拿到该文件的人都能改
 */
(function () {
  'use strict';

  const App = window.App;
  const Model = window.Model;

  const dataEl = document.getElementById('dsh-data');
  const viewEl = document.getElementById('view');
  const statusEl = document.getElementById('save-state');

  let state = null;
  let records = [];
  let dirty = false;

  // ---------------------------------------------------------------- 数据

  function load() {
    const parsed = JSON.parse(dataEl.textContent);
    state = parsed.state;
    records = parsed.records || [];
  }

  /** 把当前数据同步回数据块，使「导出」总能得到最新状态 */
  function syncDataBlock() {
    const json = JSON.stringify({ state, records });
    // 转义 < 以杜绝数据中出现 </script> 截断文档
    dataEl.textContent = json.replace(/</g, '\\u003c');
    dirty = true;
    statusEl.textContent = '有未导出的改动';
    statusEl.className = 'msg warn inline';
  }

  function markClean() {
    dirty = false;
    statusEl.textContent = '';
    statusEl.className = '';
  }

  // ---------------------------------------------------------------- 工具

  const esc = App.esc;

  function activityById(id) {
    return state.activities.find((a) => a.id === id) || null;
  }

  function visible() {
    return Model.visibleActivities(state).map((a) => Model.listItem(a, new Date(), records));
  }

  function go(hash) {
    location.hash = hash;
  }

  // ---------------------------------------------------------------- 卡片墙

  let filterState = { filter: 'all', q: '' };

  function matchesFilter(it) {
    const f = filterState.filter;
    if (f === 'closed') return true;
    if (it.status === '已结束' || it.status === '报名已截止') return false;
    if (f === '零基础') return /零基础|不限基础/.test(it.fields.threshold || '');
    if (f === '无需报名') return it.status === '无需报名';
    if (f === '长期') return it.status === '长期';
    return true;
  }

  function matchesQuery(it) {
    const q = filterState.q.trim().toLowerCase();
    if (!q) return true;
    return [it.id, it.name, it.category, it.fields.location, it.fields.schedule,
      it.fields.deadline, it.fields.threshold, it.fields.audience, it.fields.requirement,
      it.fields.cost, it.fields.outcome].filter(Boolean).join(' ').toLowerCase().includes(q);
  }

  function cardHtml(it) {
    const f = it.fields;
    let badges = App.badge(it.status);
    if (it.riskLevel === 'high') badges += '<span class="badge risk">信息存疑</span>';
    else if (it.riskLevel === 'medium') badges += '<span class="badge pending">疑似推广</span>';

    const rows = [
      ['时间', App.val(f.schedule)],
      ['地点', App.val(f.location)],
      ['门槛', App.combine([f.audience, f.threshold])],
      ['截止', App.val(f.deadline)],
      ['报名', App.val(f.signup_mode)],
    ].map((r) => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('');

    const note = it.hasUpdates ? '<div class="card-note">时间或地点已有变更，见详情</div>' : '';

    return '<article class="card" data-id="' + esc(it.id) + '">' +
      '<div class="card-head"><div class="card-title"><span class="card-id">' + esc(it.id) + '</span>' +
        esc(it.name) + '</div><div class="badges">' + badges + '</div></div>' +
      '<dl class="card-fields">' + rows + '</dl>' + note +
      '<div class="card-foot"><span class="owner-link">查看详情 →</span></div>' +
      '</article>';
  }

  function renderList() {
    const items = visible().filter(matchesFilter).filter(matchesQuery);
    const chips = [['all', '全部'], ['零基础', '零基础可参加'], ['无需报名', '无需报名'],
      ['长期', '长期招募'], ['closed', '含已结束']]
      .map(([k, label]) =>
        '<button class="chip" data-filter="' + k + '" aria-pressed="' +
        (filterState.filter === k) + '">' + label + '</button>').join('');

    viewEl.innerHTML =
      '<div class="offline-banner">' +
        '<b>离线单文件版</b>　26 条活动已内嵌在本文件中，双击即可查看，无需安装任何东西。' +
        '补充内容保存在本页内存里，请点右上角<b>「导出」</b>下载新的 HTML 替换本文件；' +
        '若需要多人各自补充、汇总到同一份数据，请使用服务版（<code>start.bat</code>）。' +
      '</div>' +
      '<div class="filters">' + chips +
        '<input class="search" id="q" type="search" placeholder="搜索活动名称、地点、门槛…" value="' + esc(filterState.q) + '">' +
        '<span class="count">' + items.length + ' 条 · ' + esc(state.term || '') + '</span>' +
      '</div>' +
      (items.length ? '<div class="cards">' + items.map(cardHtml).join('') + '</div>'
                    : '<div class="empty">没有匹配的活动</div>');

    viewEl.querySelectorAll('.chip').forEach((c) => {
      c.addEventListener('click', () => { filterState.filter = c.dataset.filter; renderList(); });
    });
    const q = document.getElementById('q');
    q.addEventListener('input', () => {
      filterState.q = q.value;
      const pos = q.selectionStart;
      renderList();
      const nq = document.getElementById('q');
      nq.focus();
      nq.setSelectionRange(pos, pos);
    });
    viewEl.querySelectorAll('.card').forEach((c) => {
      c.addEventListener('click', () => go('#/a/' + c.dataset.id));
    });
  }

  // ---------------------------------------------------------------- 详情

  function historyHtml(id) {
    const list = Model.historyOf(records, id);
    if (!list.length) return '<div class="preview-note">暂无变更记录。</div>';
    return '<ul class="history">' + list.map((h) => {
      const from = h.oldValue == null || h.oldValue === '' ? '（空）' : h.oldValue;
      return '<li><span class="when">' + esc(App.fmtWhen(h.changedAt)) + '</span>' +
        '<b>' + esc(h.fieldLabel || h.field) + '</b>：' +
        '<span class="from">' + esc(from) + '</span> → ' +
        '<span class="to">' + esc(h.newValue == null ? '（清空）' : h.newValue) + '</span>' +
        (h.reason ? '　<span class="when">' + esc(h.reason) + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function riskMsg(level) {
    if (level === 'high') {
      return '<div class="msg err"><b>信息存疑：</b>该条目缺少主办方与地点等关键信息，并存在站外引流或夸大承诺的特征。请谨慎对待，不要向对方转账或提供个人敏感信息。</div>';
    }
    if (level === 'medium') {
      return '<div class="msg warn"><b>疑似商业推广：</b>该条目标题与实际内容可能不一致，请自行判断。</div>';
    }
    return '';
  }

  function renderDetail(id) {
    const a = activityById(id);
    if (!a) { viewEl.innerHTML = '<div class="empty">活动不存在</div>'; return; }

    const f = a.fields;
    let badges = App.badge(Model.computeStatus(a, new Date()));
    if (a.riskLevel === 'high') badges += '<span class="badge risk">信息存疑</span>';
    else if (a.riskLevel === 'medium') badges += '<span class="badge pending">疑似推广</span>';

    const merged = Model.mergedFrom(state, id);
    viewEl.innerHTML =
      '<p><a href="#/">← 返回全部活动</a></p>' +
      '<h1 class="detail-title">' + esc(a.name) + '</h1>' +
      '<div class="badges" style="justify-content:flex-start">' + badges + '</div>' +
      '<div class="detail-meta">编号 ' + esc(a.id) + ' · ' + esc(a.category || '未分类') +
        ' · 发布方：' + esc(a.publisherType || App.UNKNOWN) + '</div>' +
      (merged.length ? '<div class="detail-meta">已合并补充通知：' + merged.map(esc).join('、') + '</div>' : '') +
      riskMsg(a.riskLevel) +
      '<div class="panel"><h2>要求与地点</h2><dl class="fields">' + App.renderFields(f) + '</dl>' +
        (a.notes ? '<div class="preview-note">备注：' + esc(a.notes) + '</div>' : '') + '</div>' +
      '<div class="panel"><h2>📎 活动资料</h2>' +
        '<div class="preview-note">离线版不保存附件。你可以在下方选择本地文件临时预览（关闭页面即失效）；' +
        '需要把资料长期挂在活动下，请使用服务版上传。</div>' +
        '<div class="form-row"><input type="file" id="localfile" multiple ' +
          'accept=".pptx,.docx,.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md"></div>' +
        '<div id="preview"></div></div>' +
      '<div class="panel"><h2>🕘 更新记录</h2>' + historyHtml(id) + '</div>' +
      '<div class="panel"><div class="card-foot" style="border:0;margin:0">' +
        '<a class="btn" href="#/a/' + esc(id) + '/edit">补充 / 修正信息</a></div></div>';

    const input = document.getElementById('localfile');
    const previewBox = document.getElementById('preview');
    input.addEventListener('change', async () => {
      previewBox.innerHTML = '';
      for (const file of input.files) {
        const ext = ('.' + file.name.split('.').pop()).toLowerCase();
        const url = URL.createObjectURL(file);
        const box = document.createElement('div');
        box.className = 'preview-box';
        const title = document.createElement('div');
        title.className = 'preview-note';
        title.textContent = file.name + '（' + App.fmtSize(file.size) + '）';
        box.appendChild(title);
        previewBox.appendChild(box);
        const msg = await App.previewFile({ url, ext, name: file.name }, box);
        if (msg) {
          const n = document.createElement('div');
          n.className = 'preview-note';
          n.textContent = msg;
          box.appendChild(n);
        }
      }
    });
  }

  // ---------------------------------------------------------------- 编辑

  const SIGNUP = ['无需报名', '站内报名', '需登记', '需审核', '站内组队', '外链', '站外私聊', '候补', '未注明'];
  const DEADLINE_STATUS = ['明确', '已截止', '长期', '未注明', '无需报名'];

  function options(list, selected) {
    return list.map((v) => '<option value="' + esc(v) + '"' +
      (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
  }

  function renderEdit(id) {
    const a = activityById(id);
    if (!a) { viewEl.innerHTML = '<div class="empty">活动不存在</div>'; return; }
    const f = a.fields;

    const textRow = (key, label, ph) =>
      '<div class="form-row"><label for="f_' + key + '">' + label + '</label>' +
      '<input type="text" id="f_' + key + '" data-field="' + key + '" placeholder="' + esc(ph) + '">' +
      '<div class="hint">当前：' + App.val(f[key]) + '　（留空表示不修改）</div></div>';

    viewEl.innerHTML =
      '<p><a href="#/a/' + esc(id) + '">← 返回活动</a></p>' +
      '<h1 class="detail-title">补充活动内容</h1>' +
      '<div class="detail-meta">编号 ' + esc(id) + ' · ' + esc(a.name) +
        '　<span style="color:var(--warn)">离线版无口令保护：任何拿到此文件的人都能修改</span></div>' +
      '<div class="panel"><h2>补充与修正</h2>' +
        '<p class="hint" style="margin-top:0">只填你能确认的内容；<b>留空表示保持原值不变</b>。每次修改都会记入更新记录并显示原值。</p>' +
        '<div class="form-grid">' +
          textRow('schedule', '活动时间', '如：9月21日 19:30—20:30') +
          textRow('deadline', '报名截止', '如：9月24日 22:00') +
        '</div>' +
        '<div class="form-row"><label for="f_deadline_status">截止状态</label>' +
          '<select id="f_deadline_status" data-field="deadline_status"><option value="">（不修改）</option>' +
          options(DEADLINE_STATUS, f.deadline_status) + '</select></div>' +
        textRow('location', '地点', '如：实验楼 A402') +
        '<div class="form-grid">' +
          textRow('quota', '名额', '如：限 30 人 / 座位有限') +
          textRow('cost', '费用', '如：免费 / AA / 30 元') +
        '</div>' +
        '<div class="form-grid">' +
          textRow('outcome', '收获', '如：第二课堂学分 0.5 / 志愿工时 4h') +
          textRow('audience', '面向人群', '如：全校学生 / 大一新生') +
        '</div>' +
        textRow('threshold', '参与门槛', '如：零基础可参加 / 需提交自我介绍') +
        '<div class="form-row"><label for="f_signup_mode">报名方式</label>' +
          '<select id="f_signup_mode" data-field="signup_mode"><option value="">（不修改）</option>' +
          options(SIGNUP, f.signup_mode) + '</select></div>' +
        '<div class="form-row"><label for="f_reason">变更原因（可选）</label>' +
          '<input type="text" id="f_reason" placeholder="如：场地调整、补充报名入口">' +
          '<div class="hint">会显示在更新记录里。</div></div>' +
        '<button class="btn" id="save">保存修改</button><div id="saveMsg"></div>' +
      '</div>';

    document.getElementById('save').addEventListener('click', () => {
      const patch = {};
      viewEl.querySelectorAll('[data-field]').forEach((el) => {
        const v = el.value.trim();
        if (!v) return;
        const old = f[el.dataset.field];
        if (v === (old == null ? '' : String(old))) return;
        patch[el.dataset.field] = v;
      });
      const reason = (document.getElementById('f_reason').value || '').trim();
      const msg = document.getElementById('saveMsg');
      if (!Object.keys(patch).length) {
        msg.innerHTML = '<div class="msg warn">没有检测到改动。</div>';
        return;
      }
      const r = Model.applyFields(a, patch, reason, { now: () => new Date().toISOString(), source: 'offline' });
      if (!r.changed.length) {
        msg.innerHTML = '<div class="msg warn">没有检测到改动。</div>';
        return;
      }
      records.push(...r.records);
      a.updatedAt = new Date().toISOString();
      syncDataBlock();
      msg.innerHTML = '<div class="msg ok">已保存 ' + r.changed.length + ' 个字段。' +
        '<a href="#/a/' + esc(id) + '">返回活动页</a>　' +
        '<b>记得点右上角「导出」保存成文件。</b></div>';
    });
  }

  // ---------------------------------------------------------------- 导出

  function exportHtml() {
    // 导出前确保数据块是最新的，再取整份文档
    syncDataBlock();
    const doctype = '<!DOCTYPE html>\n';
    const html = doctype + document.documentElement.outerHTML + '\n';
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '校园活动与机会平台.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    markClean();
    statusEl.textContent = '已导出，请用新文件替换旧文件';
    statusEl.className = 'msg ok inline';
  }

  function exportJson() {
    syncDataBlock();
    const blob = new Blob([JSON.stringify({ state, records }, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'activities-offline.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---------------------------------------------------------------- 路由

  function route() {
    const hash = location.hash || '#/';
    const m = /^#\/a\/(\d{2})(\/edit)?$/.exec(hash);
    window.scrollTo(0, 0);
    if (!m) { renderList(); return; }
    if (m[2]) renderEdit(m[1]);
    else renderDetail(m[1]);
  }

  // ---------------------------------------------------------------- 启动

  load();
  document.getElementById('export-html').addEventListener('click', exportHtml);
  document.getElementById('export-json').addEventListener('click', exportJson);
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
  route();
})();
