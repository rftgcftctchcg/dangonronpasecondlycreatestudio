'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

const { createProject, loadProject, saveProject, buildTimeline, resolveProjectPath } = require('./src/project');
const { renderShotPreview, renderStdVisual, renderStdBackground, renderStdCharacters, renderTstVisual, encodeFrames } = require('./src/render');
const { buildCapcutDraft } = require('./src/draft');
const { parseScript } = require('./src/parser');

const APP_DIR = __dirname;
const PROJECT_DIR = path.join(APP_DIR, 'data', 'sample');
const PORT = Number(process.env.PORT || 3210);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

function safeRel(rel) {
  const p = path.normalize(String(rel || '')).replace(/^([/\\])+/, '');
  if (p.startsWith('..') || p.includes('..' + path.sep)) return null;
  return p;
}

function fileUrl(rel) {
  return `/files/${rel.split(path.sep).join('/')}`;
}

function projectAbs(rel) {
  return rel ? path.resolve(PROJECT_DIR, rel) : null;
}

function listMissing(project, timeline) {
  const missing = [];
  for (const g of timeline.groups) {
    for (const shot of g.shots) {
      const src = shot.combined || shot.background || g.background;
      if (!src || !fs.existsSync(projectAbs(src))) {
        missing.push({ groupKey: g.key, shotKey: shot.key, kind: 'background', message: `分镜「${shot.label}」缺少背景` });
      }
      for (const c of shot.characters || []) {
        if (!c.asset || !fs.existsSync(projectAbs(c.asset))) {
          missing.push({ groupKey: g.key, shotKey: shot.key, kind: 'character', message: `分镜「${shot.label}」有角色图缺失` });
        }
      }
    }
    if (g.bgm && !fs.existsSync(projectAbs(g.bgm))) {
      missing.push({ groupKey: g.key, kind: 'bgm', message: `组「${g.label}」的 BGM 文件缺失` });
    }
  }
  return missing;
}

function getState() {
  const project = loadProject(PROJECT_DIR);
  const timeline = buildTimeline(project, PROJECT_DIR);
  const missing = listMissing(project, timeline);
  const outputs = [];
  const outRoot = path.join(PROJECT_DIR, 'output');
  if (fs.existsSync(outRoot)) {
    for (const name of fs.readdirSync(outRoot)) {
      const full = path.join(outRoot, name);
      if (fs.statSync(full).isDirectory()) {
        outputs.push({ name, folder: full, url: `/output/${name}/draft_cover.jpg` });
      }
    }
  }
  return {
    project,
    timeline,
    missing,
    outputs,
    draftRoot: detectCapcutRoot(),
    projectDir: PROJECT_DIR,
  };
}

function detectCapcutRoot() {
  const candidates = [];
  const local = process.env.LOCALAPPDATA || '';
  if (local) {
    const cfg = path.join(local, 'CapCut', 'User Data', 'Config', 'globalSetting');
    try {
      const text = fs.readFileSync(cfg, 'utf8');
      const m = text.match(/^currentCustomDraftPath=(.*)$/m);
      if (m && m[1].trim()) candidates.push(m[1].trim());
    } catch (e) {
      /* ignore */
    }
    candidates.push(path.join(local, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'));
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return candidates[0] || '';
}

function findCapcutIndex() {
  const local = process.env.LOCALAPPDATA || '';
  if (!local) return null;
  const p = path.join(local, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft', 'root_meta_info.json');
  return fs.existsSync(p) ? p : null;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function installDraft(localFolder, draftName) {
  const root = detectCapcutRoot();
  const index = findCapcutIndex();
  if (!root) return { installed: false, reason: '未找到 CapCut 草稿目录' };
  const dest = path.join(root, draftName);
  if (fs.existsSync(dest)) return { installed: false, reason: `草稿目录已存在：${dest}` };
  fs.mkdirSync(root, { recursive: true });
  // Node's native fs.cpSync has crashed on some Windows drives; a plain
  // recursive copy is slower but reliable.
  copyDirRecursive(localFolder, dest);

  // The draft was built in the project output folder. Rewrite every path to the
  // installed folder so the copied draft is truly self-contained and does not
  // depend on the original output directory.
  const oldPosix = localFolder.replace(/\\/g, '/');
  const newPosix = dest.replace(/\\/g, '/');
  let rewritten = 0;
  for (const name of ['draft_content.json', 'draft_meta_info.json']) {
    const file = path.join(dest, name);
    if (!fs.existsSync(file)) continue;
    let text = fs.readFileSync(file, 'utf8');
    const before = text;
    text = text.split(oldPosix).join(newPosix);
    text = text.split(localFolder).join(dest);
    text = text.split(oldPosix.replace(/\//g, '\\/')).join(newPosix.replace(/\//g, '\\/'));
    if (text !== before) {
      fs.writeFileSync(file, text, 'utf8');
      rewritten += 1;
    }
  }

  // draft_meta_info's root path points at the build output directory; update it
  // to CapCut's draft root so the installed copy is fully self-contained.
  const installedMetaFile = path.join(dest, 'draft_meta_info.json');
  if (fs.existsSync(installedMetaFile)) {
    try {
      const installedMeta = JSON.parse(fs.readFileSync(installedMetaFile, 'utf8'));
      installedMeta.draft_root_path = root.replace(/\\/g, '/');
      fs.writeFileSync(installedMetaFile, JSON.stringify(installedMeta, null, 1), 'utf8');
    } catch (e) {
      /* keep the path-rewritten meta */
    }
  }

  let indexUpdated = false;
  if (index) {
    try {
      const idx = JSON.parse(fs.readFileSync(index, 'utf8'));
      const list = idx.all_draft_store || [];
      const prev = list[list.length - 1] || {};
      const meta = JSON.parse(fs.readFileSync(path.join(dest, 'draft_meta_info.json'), 'utf8'));
      const entry = JSON.parse(JSON.stringify(prev));
      entry.draft_cover = `${newPosix}/draft_cover.jpg`;
      entry.draft_fold_path = newPosix;
      entry.draft_id = meta.draft_id;
      entry.draft_json_file = `${newPosix}/draft_content.json`;
      entry.draft_name = draftName;
      entry.draft_root_path = root.replace(/\\/g, '/');
      entry.draft_timeline_materials_size = meta.draft_timeline_materials_size_;
      entry.tm_draft_create = Date.now() * 1000;
      entry.tm_draft_modified = Date.now() * 1000;
      entry.tm_duration = meta.tm_duration;
      entry.tm_draft_removed = 0;
      list.push(entry);
      idx.all_draft_store = list;
      fs.copyFileSync(index, `${index}.vnbak`);
      fs.writeFileSync(`${index}.tmp`, JSON.stringify(idx), 'utf8');
      fs.renameSync(`${index}.tmp`, index);
      indexUpdated = true;
    } catch (e) {
      /* keep folder-only install */
    }
  }
  return { installed: true, dest, indexUpdated, root, rewritten };
}

function saveUpload(kind, originalName, base64, duration) {
  const ext = (path.extname(originalName || '').toLowerCase() || '.bin').replace(/[^a-z0-9.]/g, '');
  const dirName = kind === 'bgm' ? 'bgm' : kind === 'character' ? 'characters' : kind === 'combined' ? 'combined' : 'backgrounds';
  const dir = path.join(PROJECT_DIR, 'assets', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const base = (path.basename(originalName || 'file', path.extname(originalName || '')) || 'file')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 40) || 'file';
  const name = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}_${base}${ext}`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, Buffer.from(base64, 'base64'));
  return { rel: path.relative(PROJECT_DIR, full).replace(/\\/g, '/'), url: fileUrl(path.relative(PROJECT_DIR, full)), name, duration };
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/state' && req.method === 'GET') {
    return json(res, 200, getState());
  }
  if (p === '/api/parse' && req.method === 'POST') {
    const body = await readJson(req);
    const script = String(body.script || '');
    if (!script.trim()) return json(res, 400, { error: '剧本为空' });
    const old = loadProject(PROJECT_DIR);
    const oldGroups = new Map((old.groups || []).map((g) => [g.label, g]));
    const parsed = parseScript(script);
    const project = createProject(script, body.name || old.name || '示例项目');
    project.settings = old.settings || project.settings;
    project.assets = old.assets || project.assets;
    project.speakerColors = old.speakerColors || project.speakerColors;
    for (const g of project.groups) {
      const prev = oldGroups.get(g.label) || (old.groups || []).find((x) => x.key === g.key);
      if (!prev) continue;
      if (prev.bgm) g.bgm = prev.bgm;
      if (prev.bgmDuration) g.bgmDuration = prev.bgmDuration;
      for (const s of g.shots) {
        const ps = (prev.shots || []).find((x) => x.label === s.label || x.key === s.key);
        if (!ps) continue;
        s.background = ps.background;
        s.combined = ps.combined;
        s.characters = ps.characters || [];
        s.lineDurations = ps.lineDurations || {};
      }
    }
    saveProject(PROJECT_DIR, project);
    fs.writeFileSync(path.join(PROJECT_DIR, 'script.txt'), script, 'utf8');
    return json(res, 200, { ...getState(), parse: parsed });
  }
  if (p === '/api/upload' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.data) return json(res, 400, { error: '没有文件数据' });
    const info = saveUpload(body.kind || 'background', body.name || 'file', body.data, body.duration);
    return json(res, 200, info);
  }
  if (p === '/api/assign' && req.method === 'POST') {
    const body = await readJson(req);
    const project = loadProject(PROJECT_DIR);
    const group = project.groups.find((g) => g.key === body.groupKey);
    if (!group) return json(res, 404, { error: '组不存在' });
    if (body.scope === 'group') {
      if (body.patch.background !== undefined) group.background = body.patch.background;
      if (body.patch.bgm !== undefined) group.bgm = body.patch.bgm;
      if (body.patch.bgmDuration !== undefined) group.bgmDuration = body.patch.bgmDuration;
    } else {
      const shot = group.shots.find((s) => s.key === body.shotKey);
      if (!shot) return json(res, 404, { error: '分镜不存在' });
      if (body.patch.background !== undefined) shot.background = body.patch.background;
      if (body.patch.combined !== undefined) shot.combined = body.patch.combined;
      if (body.patch.characters !== undefined) shot.characters = body.patch.characters;
      if (body.patch.lineDurations !== undefined) shot.lineDurations = body.patch.lineDurations;
    }
    saveProject(PROJECT_DIR, project);
    return json(res, 200, getState());
  }
  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readJson(req);
    const project = loadProject(PROJECT_DIR);
    project.settings = { ...project.settings, ...(body.settings || {}) };
    saveProject(PROJECT_DIR, project);
    return json(res, 200, getState());
  }
  if (p === '/api/preview' && req.method === 'GET') {
    const project = loadProject(PROJECT_DIR);
    const timeline = buildTimeline(project, PROJECT_DIR);
    const g = timeline.groups.find((x) => x.key === url.searchParams.get('group')) || timeline.groups[0];
    if (!g) return json(res, 404, { error: '没有可预览的组' });
    const s = g.shots.find((x) => x.key === url.searchParams.get('shot')) || g.shots[0];
    if (!s) return json(res, 404, { error: '没有可预览的分镜' });
    const li = Number(url.searchParams.get('line') || 0);
    const pi = Number(url.searchParams.get('page') || 0);
    const line = s.lines[li] || s.lines[0];
    const page = line ? line.pages[pi] || line.pages[0] : null;
    const out = path.join(PROJECT_DIR, 'render', `preview_${g.key}_${s.key}_${li}_${pi}.png`);
    await renderShotPreview(project, PROJECT_DIR, g, s, page, out);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(out));
    return;
  }
  if (p === '/api/preview-video' && req.method === 'GET') {
    const project = loadProject(PROJECT_DIR);
    const timeline = buildTimeline(project, PROJECT_DIR);
    const g = timeline.groups.find((x) => x.key === url.searchParams.get('group'));
    if (!g) return json(res, 404, { error: '组不存在' });
    const out = path.join(PROJECT_DIR, 'render', 'preview', `${g.key}_tst.mp4`);
    if (!fs.existsSync(out)) await renderTstVisual(project, PROJECT_DIR, g, out);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(out));
    return;
  }
  if (p === '/api/export' && req.method === 'POST') {
    const body = await readJson(req);
    const project = loadProject(PROJECT_DIR);
    const timeline = buildTimeline(project, PROJECT_DIR);
    const missing = listMissing(project, timeline);
    if (missing.length) return json(res, 400, { error: '还有缺失素材', missing });
    const visuals = {};
    const visDir = path.join(PROJECT_DIR, 'render', 'vis');
    fs.mkdirSync(visDir, { recursive: true });
    for (const g of timeline.groups) {
      if (g.type === 'TST') {
        const out = path.join(visDir, `${g.key}_tst.mp4`);
        await renderTstVisual(project, PROJECT_DIR, g, out);
        visuals[g.key] = { type: 'tst', video: path.relative(PROJECT_DIR, out) };
      } else {
        const backgrounds = {};
        const characters = {};
        for (const s of g.shots) {
          const bgOut = path.join(visDir, `${g.key}_${s.key}_bg.png`);
          await renderStdBackground(project, PROJECT_DIR, g, s, bgOut);
          backgrounds[s.key] = path.relative(PROJECT_DIR, bgOut);
          const charOut = path.join(visDir, `${g.key}_${s.key}_char.png`);
          const chars = await renderStdCharacters(project, PROJECT_DIR, g, s, charOut);
          if (chars) characters[s.key] = path.relative(PROJECT_DIR, charOut);
        }
        visuals[g.key] = { type: 'std', backgrounds, characters, box: 'assets/std.png' };
      }
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const draftName = `${(project.name || '视觉小说').replace(/[\\/:*?"<>|]/g, '_')}_${stamp}`;
    const outDir = path.join(PROJECT_DIR, 'output', draftName);
    fs.rmSync(outDir, { recursive: true, force: true });
    const result = await buildCapcutDraft({
      project,
      projectDir: PROJECT_DIR,
      timeline,
      visuals,
      outDir,
      draftName,
      draftRoot: null,
    });
    let install = { installed: false };
    if (body.install) {
      try {
        install = installDraft(result.draftFolder, draftName);
      } catch (e) {
        install = { installed: false, reason: e.message };
      }
    }
    return json(res, 200, { ...result, install, draftName });
  }
  return json(res, 404, { error: '未知接口' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/files/')) {
      const rel = safeRel(decodeURIComponent(url.pathname.slice('/files/'.length)));
      if (!rel) return send(res, 400, 'bad path', 'text/plain');
      const full = path.join(PROJECT_DIR, rel);
      if (!full.startsWith(PROJECT_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return send(res, 404, 'not found', 'text/plain');
      }
      const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(full));
    }
    if (url.pathname.startsWith('/output/')) {
      const rel = safeRel(decodeURIComponent(url.pathname.slice('/output/'.length)));
      const full = path.join(PROJECT_DIR, 'output', rel || '');
      if (!full.startsWith(path.join(PROJECT_DIR, 'output')) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return send(res, 404, 'not found', 'text/plain');
      }
      const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(full));
    }
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.join(APP_DIR, 'public', safeRel(file) || 'index.html');
    if (!full.startsWith(path.join(APP_DIR, 'public')) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return send(res, 404, 'not found', 'text/plain');
    }
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(full));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`VN generator running at http://127.0.0.1:${PORT}`);
  console.log(`project: ${PROJECT_DIR}`);
  console.log(`CapCut draft root: ${detectCapcutRoot()}`);
});
