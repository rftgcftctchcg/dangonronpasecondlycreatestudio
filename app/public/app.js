'use strict';

let S = null;
let selected = { groupKey: null, shotKey: null, lineIndex: 0, pageIndex: 0 };
let activeTab = 'script';
let busy = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(ms) {
  const sec = Math.max(0, Math.round(ms / 100) / 10);
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return m > 0 ? `${m}:${String(s).padStart(4, '0')}` : `${s}s`;
}

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || '请求失败'), { data });
    return data;
  }
  if (!res.ok) throw new Error(await res.text());
  return res;
}

async function loadState() {
  S = await api('/api/state');
  if (!selected.groupKey || !S.timeline.groups.some((g) => g.key === selected.groupKey)) {
    selected = { groupKey: S.timeline.groups[0]?.key || null, shotKey: S.timeline.groups[0]?.shots[0]?.key || null, lineIndex: 0, pageIndex: 0 };
  }
  $('#draftRoot').textContent = S.draftRoot || '未找到 CapCut 草稿目录';
  if ($('#scriptText') && !$('#scriptText').dataset.dirty) $('#scriptText').value = S.project.script || '';
  renderAll();
}

function currentGroup() {
  if (!S) return null;
  return S.timeline.groups.find((g) => g.key === selected.groupKey) || S.timeline.groups[0] || null;
}
function currentShot() {
  const g = currentGroup();
  if (!g) return null;
  return g.shots.find((s) => s.key === selected.shotKey) || g.shots[0] || null;
}
function projectGroup(key) {
  return S.project.groups.find((g) => g.key === key);
}
function projectShot(gkey, skey) {
  const g = projectGroup(gkey);
  return g ? g.shots.find((s) => s.key === skey) : null;
}

function renderAll() {
  renderTree();
  renderDetail();
  renderPreview();
  renderBgm();
  renderExport();
  renderMissing();
  $('#stats').textContent = `${S.project.groups.length} 组 / ${S.timeline.groups.reduce((n, g) => n + g.shots.length, 0)} 分镜 / ${fmt(S.timeline.durationMs)}`;
}

function renderTree() {
  const root = $('#tree');
  const missingSet = new Set(S.missing.map((m) => `${m.groupKey}:${m.shotKey || ''}`));
  root.innerHTML = '';
  for (const g of S.timeline.groups) {
    const pg = projectGroup(g.key);
    const box = document.createElement('div');
    box.className = 'tree-group';
    box.innerHTML = `
      <div class="tree-group-head">
        <span>${escapeHtml(g.label)}</span>
        <span class="tag ${g.type === 'TST' ? 'tst' : ''}">${g.type} · ${fmt(g.durationMs)}</span>
      </div>`;
    for (const s of g.shots) {
      const btn = document.createElement('div');
      const active = s.key === selected.shotKey && g.key === selected.groupKey;
      const miss = missingSet.has(`${g.key}:${s.key}`);
      const bg = (projectShot(g.key, s.key)?.combined || projectShot(g.key, s.key)?.background || pg.background);
      btn.className = `tree-shot ${active ? 'active' : ''}`;
      btn.innerHTML = `<span>${escapeHtml(s.label)}</span><span class="badge ${miss ? '' : 'ok'}">${miss ? '缺' : 'OK'}</span>`;
      btn.onclick = () => {
        selected = { groupKey: g.key, shotKey: s.key, lineIndex: 0, pageIndex: 0 };
        renderTree();
        renderDetail();
        renderPreview();
      };
      box.appendChild(btn);
    }
    root.appendChild(box);
  }
}

function assetUrl(rel) {
  return rel ? `/files/${rel.split('\\').join('/')}` : '';
}

function renderDetail() {
  const g = currentGroup();
  const s = currentShot();
  const el = $('#detail');
  if (!g || !s) {
    el.innerHTML = '<p class="muted">还没有分镜。请先在“剧本”里解析。</p>';
    return;
  }
  const pg = projectGroup(g.key);
  const ps = projectShot(g.key, s.key);
  const bg = ps.background || pg.background || (pg.type === 'TST' ? 'assets/trial_bg.jpg' : 'assets/sample_bg.png');
  const combined = ps.combined;
  const chars = ps.characters || [];
  el.innerHTML = `
    <div class="detail-head">
      <div>
        <h3>${escapeHtml(pg.label)} · ${escapeHtml(s.label)}</h3>
        <p class="muted">${pg.type === 'TST' ? '学级裁判组（共享背景 + 动态对话框）' : '普通组'} · ${fmt(s.durationMs)} · ${s.lines.length} 行台词</p>
      </div>
      <button class="btn ghost small" id="detailPreview">刷新预览</button>
    </div>

    <div class="asset-block">
      <h4>背景 <span class="muted">${escapeHtml((bg || '').split('/').pop())}</span></h4>
      <div class="asset-row">
        <img class="thumb" src="${escapeHtml(assetUrl(bg))}" onerror="this.style.opacity=.25" />
        <div>
          <button class="btn small" id="uploadBg">上传背景</button>
          ${pg.type === 'TST' ? '<button class="btn small ghost" id="useTrialBg">使用内置学级裁判背景</button>' : ''}
        </div>
      </div>
    </div>

    <div class="asset-block">
      <h4>人物与背景合一图 <span class="muted">勾选后跳过角色合成</span></h4>
      <label class="check"><input type="checkbox" id="combinedChk" ${combined ? 'checked' : ''}/> 使用合一图</label>
      <div class="asset-row" style="margin-top:10px">
        ${combined ? `<img class="thumb" src="${escapeHtml(assetUrl(combined))}" onerror="this.style.opacity=.25" />` : '<span class="muted">未启用</span>'}
        <button class="btn small" id="uploadCombined">上传合一图</button>
        ${combined ? '<button class="btn small ghost" id="clearCombined">清除</button>' : ''}
      </div>
    </div>

    <div class="asset-block">
      <h4>角色 <span class="muted">${chars.length} 个</span></h4>
      <div class="char-list" id="charList"></div>
      <div style="margin-top:10px"><button class="btn small" id="uploadChar">上传角色图（可多选）</button></div>
    </div>

    <div class="asset-block">
      <h4>台词与时长 <span class="muted">每行可单独覆盖时长</span></h4>
      <div class="line-list" id="lineList"></div>
    </div>
  `;
  $('#uploadBg').onclick = () => uploadTo('background');
  const trial = $('#useTrialBg');
  if (trial) trial.onclick = async () => {
    await api('/api/assign', { method: 'POST', body: JSON.stringify({ scope: 'group', groupKey: g.key, patch: { background: 'assets/trial_bg.jpg' } }) });
    await loadState();
  };
  $('#combinedChk').onchange = async (e) => {
    await api('/api/assign', { method: 'POST', body: JSON.stringify({ scope: 'shot', groupKey: g.key, shotKey: s.key, patch: { combined: e.target.checked ? (combined || 'assets/sample_bg.png') : null } }) });
    await loadState();
  };
  $('#uploadCombined').onclick = () => uploadTo('combined');
  const clearCombined = $('#clearCombined');
  if (clearCombined) clearCombined.onclick = async () => {
    await api('/api/assign', { method: 'POST', body: JSON.stringify({ scope: 'shot', groupKey: g.key, shotKey: s.key, patch: { combined: null } }) });
    await loadState();
  };
  $('#uploadChar').onclick = () => uploadCharacters();
  $('#detailPreview').onclick = renderPreview;
  renderCharacters(chars);
  renderLines(s);
}

function renderCharacters(chars) {
  const g = currentGroup();
  const s = currentShot();
  const box = $('#charList');
  if (!box) return;
  if (!chars.length) {
    box.innerHTML = '<span class="muted">未上传角色；也可以直接上传合一图。</span>';
    return;
  }
  box.innerHTML = '';
  chars.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'char-card';
    card.innerHTML = `
      <img class="thumb square" src="${escapeHtml(assetUrl(c.asset))}" />
      <div class="name">${escapeHtml(c.name || c.asset.split('/').pop())}</div>
      <div class="row">
        <button class="btn small" data-act="out">缩小</button>
        <button class="btn small" data-act="in">放大</button>
      </div>
      <div class="row" style="margin-top:4px">
        <button class="btn small" data-act="left">左移</button>
        <button class="btn small" data-act="right">右移</button>
      </div>
      <div class="row" style="margin-top:4px">
        <button class="btn small" data-act="del">移除</button>
      </div>`;
    card.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        const next = chars.map((x) => ({ ...x }));
        const cur = next[i];
        const act = b.dataset.act;
        if (act === 'del') next.splice(i, 1);
        else if (act === 'in') cur.scale = Math.min(1.6, (cur.scale || 1) + 0.1);
        else if (act === 'out') cur.scale = Math.max(0.35, (cur.scale || 1) - 0.1);
        else if (act === 'left') cur.x = (cur.x || 0) - 0.03;
        else if (act === 'right') cur.x = (cur.x || 0) + 0.03;
        await api('/api/assign', { method: 'POST', body: JSON.stringify({ scope: 'shot', groupKey: g.key, shotKey: s.key, patch: { characters: next } }) });
        await loadState();
      };
    });
    box.appendChild(card);
  });
}

function renderLines(s) {
  const g = currentGroup();
  const pg = projectShot(g.key, s.key);
  const box = $('#lineList');
  if (!box) return;
  if (!s.lines.length) {
    box.innerHTML = '<span class="muted">这个分镜没有台词。</span>';
    return;
  }
  box.innerHTML = '';
  s.lines.forEach((line, i) => {
    const override = pg.lineDurations && pg.lineDurations[line.key];
    const row = document.createElement('div');
    row.className = 'line-row';
    row.innerHTML = `
      <span class="spk">${escapeHtml(line.speaker || '旁白')}</span>
      <span class="txt" title="${escapeHtml(line.text)}">${escapeHtml(line.text)}</span>
      <input type="number" min="0.3" step="0.1" value="${override != null ? override : (line.durationMs / 1000).toFixed(1)}" title="秒" />`;
    const input = row.querySelector('input');
    input.onchange = async () => {
      const val = Math.max(0.3, Number(input.value) || 1);
      const durations = { ...(pg.lineDurations || {}) };
      durations[line.key] = val;
      await api('/api/assign', { method: 'POST', body: JSON.stringify({ scope: 'shot', groupKey: g.key, shotKey: s.key, patch: { lineDurations: durations } }) });
      await loadState();
    };
    row.onclick = (e) => {
      if (e.target.tagName === 'INPUT') return;
      selected.lineIndex = i;
      selected.pageIndex = 0;
      renderPreview();
    };
    box.appendChild(row);
  });
}

function currentPage() {
  const g = currentGroup();
  const s = currentShot();
  if (!g || !s) return null;
  const line = s.lines[selected.lineIndex] || s.lines[0];
  if (!line) return null;
  return { g, s, line, page: line.pages[selected.pageIndex] || line.pages[0] };
}

function renderPreview() {
  const wrap = $('#previewWrap');
  const cur = currentPage();
  if (!cur) {
    wrap.innerHTML = '<p class="muted">没有可预览的内容。</p>';
    return;
  }
  const { g, s, line, page } = cur;
  if (!line) {
    wrap.innerHTML = '<p class="muted">这个分镜没有台词。</p>';
    return;
  }
  const q = `group=${encodeURIComponent(g.key)}&shot=${encodeURIComponent(s.key)}&line=${selected.lineIndex}&page=${selected.pageIndex}&t=${Date.now()}`;
  const img = `<img src="/api/preview?${q}" alt="preview" />`;
  const video = g.type === 'TST' ? `<div style="margin-top:8px"><button class="btn small" id="tstVideoBtn">生成/播放本组动态预览</button><div id="tstVideo"></div></div>` : '';
  wrap.innerHTML = `${img}<div class="caption">${escapeHtml(line.speaker || '旁白')} · 第 ${selected.pageIndex + 1}/${line.pages.length} 页 · ${fmt(page?.durationMs || line.durationMs)}</div>${video}`;
  const tstBtn = $('#tstVideoBtn');
  if (tstBtn) tstBtn.onclick = async () => {
    tstBtn.disabled = true;
    tstBtn.textContent = '生成中…';
    const box = $('#tstVideo');
    const v = document.createElement('video');
    v.controls = true;
    v.autoplay = true;
    v.src = `/api/preview-video?group=${encodeURIComponent(g.key)}&t=${Date.now()}`;
    v.onloadeddata = () => { tstBtn.textContent = '重新生成'; tstBtn.disabled = false; };
    v.onerror = () => { tstBtn.textContent = '生成失败，重试'; tstBtn.disabled = false; };
    box.innerHTML = '';
    box.appendChild(v);
  };
}

function renderMissing() {
  const box = $('#missingBox');
  if (!box) return;
  if (!S.missing.length) {
    box.innerHTML = '<div class="item" style="color:#9ce3b0;background:#14241a;border-color:#2d4a35">素材齐全，可以导出</div>';
    return;
  }
  box.innerHTML = S.missing.map((m) => `<div class="item">${escapeHtml(m.message)}</div>`).join('');
}

function renderBgm() {
  const box = $('#bgmList');
  if (!box) return;
  box.innerHTML = '';
  for (const g of S.timeline.groups) {
    const pg = projectGroup(g.key);
    const has = !!pg.bgm;
    const card = document.createElement('div');
    card.className = `bgm-card ${has ? '' : 'blank'}`;
    card.innerHTML = `
      <h4><span>${escapeHtml(pg.label)} <span class="muted">${g.type}</span></span><span class="muted">${fmt(g.durationMs)}</span></h4>
      <div class="meta">${has ? `已上传：${escapeHtml(pg.bgm.split('/').pop())}` : '留空（该组静音）'}</div>
      ${has ? `<audio controls src="${escapeHtml(assetUrl(pg.bgm))}"></audio>` : ''}
      <div class="actions">
        <button class="btn small" data-act="up">${has ? '替换 BGM' : '上传 BGM'}</button>
        ${has ? '<button class="btn small ghost" data-act="del">移除</button>' : ''}
      </div>`;
    card.querySelector('[data-act="up"]').onclick = () => uploadBgm(g.key);
    const del = card.querySelector('[data-act="del"]');
    if (del) del.onclick = async () => {
      await api('/api/assign', { method: 'POST', body: JSON.stringify({ scope: 'group', groupKey: g.key, patch: { bgm: null, bgmDuration: null } }) });
      await loadState();
    };
    box.appendChild(card);
  }
}

function renderExport() {
  const hint = $('#exportHint');
  if (hint) hint.textContent = S.draftRoot ? `草稿目录：${S.draftRoot}` : '未自动找到 CapCut 草稿目录';
  const list = $('#outputList');
  if (!list) return;
  if (!S.outputs.length) {
    list.innerHTML = '<p class="muted">还没有导出记录。</p>';
    return;
  }
  list.innerHTML = S.outputs
    .slice()
    .reverse()
    .map((o) => `<div class="output-item"><img src="${escapeHtml(o.url)}" onerror="this.style.opacity=.2" /><div class="grow"><b>${escapeHtml(o.name)}</b><div class="path">${escapeHtml(o.folder)}</div></div></div>`)
    .join('');
}

async function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(multiple ? Array.from(input.files) : input.files[0]);
    input.click();
  });
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function audioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => { const d = a.duration; URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 30); };
    a.onerror = () => { URL.revokeObjectURL(url); resolve(30); };
    a.src = url;
  });
}

async function uploadTo(kind) {
  const file = await pickFile('image/png,image/jpeg,image/webp,image/*');
  if (!file) return;
  const data = await readBase64(file);
  const info = await api('/api/upload', { method: 'POST', body: JSON.stringify({ kind, name: file.name, data }) });
  const g = currentGroup();
  const s = currentShot();
  const pg = projectShot(g.key, s.key);
  if (kind === 'combined') {
    await api('/api/assign', { method: 'POST', body: JSON.stringify({ scope: 'shot', groupKey: g.key, shotKey: s.key, patch: { combined: info.rel } }) });
  } else {
    await api('/api/assign', { method: 'POST', body: JSON.stringify({ scope: 'shot', groupKey: g.key, shotKey: s.key, patch: { background: info.rel } }) });
  }
  await loadState();
  toast('已更新背景');
}

async function uploadCharacters() {
  const files = await pickFile('image/png,image/jpeg,image/webp,image/*', true);
  if (!files || !files.length) return;
  const g = currentGroup();
  const s = currentShot();
  const pg = projectShot(g.key, s.key);
  const chars = [...(pg.characters || [])];
  for (const file of files) {
    const data = await readBase64(file);
    const info = await api('/api/upload', { method: 'POST', body: JSON.stringify({ kind: 'character', name: file.name, data }) });
    chars.push({ asset: info.rel, name: file.name.replace(/\.[^.]+$/, ''), scale: 1, x: 0 });
  }
  await api('/api/assign', { method: 'POST', body: JSON.stringify({ scope: 'shot', groupKey: g.key, shotKey: s.key, patch: { characters: chars } }) });
  await loadState();
  toast(`已添加 ${files.length} 个角色`);
}

async function uploadBgm(groupKey) {
  const file = await pickFile('audio/mpeg,audio/wav,audio/mp4,audio/ogg,audio/*');
  if (!file) return;
  const data = await readBase64(file);
  const duration = await audioDuration(file);
  const info = await api('/api/upload', { method: 'POST', body: JSON.stringify({ kind: 'bgm', name: file.name, data, duration }) });
  await api('/api/assign', { method: 'POST', body: JSON.stringify({ scope: 'group', groupKey, patch: { bgm: info.rel, bgmDuration: duration } }) });
  await loadState();
  toast('已上传 BGM');
}

async function parseScript() {
  const btn = $('#parseBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>解析中';
  try {
    const script = $('#scriptText').value;
    const res = await api('/api/parse', { method: 'POST', body: JSON.stringify({ script }) });
    S = res;
    const p = res.parse;
    const box = $('#parseReport');
    const rows = [];
    rows.push(`<div class="row ok">解析完成：${p.stats.groups} 组 / ${p.stats.shots} 分镜 / ${p.stats.lines} 行</div>`);
    for (const e of p.errors) rows.push(`<div class="row err"><span class="ln">第 ${e.line} 行</span>${escapeHtml(e.message)}</div>`);
    for (const w of p.warnings) rows.push(`<div class="row warn"><span class="ln">第 ${w.line} 行</span>${escapeHtml(w.message)}</div>`);
    box.innerHTML = `<div class="report">${rows.join('')}</div>`;
    if (S.timeline.groups[0]) selected = { groupKey: S.timeline.groups[0].key, shotKey: S.timeline.groups[0].shots[0]?.key, lineIndex: 0, pageIndex: 0 };
    $('#scriptText').dataset.dirty = '';
    renderAll();
    showTab('shots');
  } catch (e) {
    $('#parseReport').innerHTML = `<div class="report"><div class="row err">${escapeHtml(e.message)}</div></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '解析并保存';
  }
}

async function doExport() {
  if (busy) return;
  busy = true;
  const btn = $('#exportBtn');
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>生成中';
  const box = $('#exportResult');
  box.innerHTML = '<div class="result">正在渲染画面并生成 CapCut 草稿。首次生成 TST 视频需要逐帧渲染，21 秒示例约需 3~5 分钟，请保持页面打开…</div>';
  try {
    const res = await api('/api/export', { method: 'POST', body: JSON.stringify({ install: $('#installChk').checked }) });
    const install = res.install || {};
    box.innerHTML = `<div class="result">
      <b>草稿已生成</b><br/>
      <span class="path">${escapeHtml(res.draftFolder)}</span><br/>
      <span class="muted">${res.trackCounts.map((t) => `${t.name}:${t.segments}`).join(' · ')}</span>
      ${install.installed ? `<br/><span style="color:#9ce3b0">已安装到：${escapeHtml(install.dest)}</span>` : (install.reason ? `<br/><span style="color:#ffe08a">未自动安装：${escapeHtml(install.reason)}</span>` : '')}
    </div>`;
    toast('草稿生成完成');
    await loadState();
  } catch (e) {
    const miss = e.data && e.data.missing ? `<div class="report">${e.data.missing.map((m) => `<div class="row err">${escapeHtml(m.message)}</div>`).join('')}</div>` : '';
    box.innerHTML = `<div class="result error">${escapeHtml(e.message)}${miss}</div>`;
  } finally {
    busy = false;
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

function showTab(name) {
  activeTab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  $$('.step').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'shots') { renderTree(); renderDetail(); renderPreview(); renderMissing(); }
  if (name === 'bgm') renderBgm();
  if (name === 'export') renderExport();
}

function bind() {
  $$('.step').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $('#parseBtn').onclick = parseScript;
  $('#importBtn').onclick = async () => {
    const file = await pickFile('.txt,text/plain');
    if (!file) return;
    const buf = await file.arrayBuffer();
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      text = new TextDecoder('gb18030').decode(buf);
    }
    $('#scriptText').value = text;
    $('#scriptText').dataset.dirty = '1';
    toast(`已导入 ${file.name}，点“解析并保存”`);
  };
  $('#sampleBtn').onclick = () => {
    $('#scriptText').value = S.project.script || '';
    $('#scriptText').dataset.dirty = '';
    toast('已恢复为当前项目剧本');
  };
  $('#scriptText').oninput = () => { $('#scriptText').dataset.dirty = '1'; };
  $('#refreshBtn').onclick = () => loadState().then(() => toast('已刷新'));
  $('#exportBtn').onclick = doExport;
  $('#previewBtn').onclick = renderPreview;
}

bind();
loadState().then(() => showTab('script')).catch((e) => toast('加载失败：' + e.message, 5000));
