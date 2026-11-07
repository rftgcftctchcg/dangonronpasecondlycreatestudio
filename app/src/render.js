'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { ensureFont, fontSpec } = require('./text');
const { resolveProjectPath } = require('./project');

const APP_DIR = path.resolve(__dirname, '..');
const IMAGE_CACHE = new Map();
const IMAGE_CACHE_MAX = 16;

function appAsset(...p) {
  return path.join(APP_DIR, ...p);
}

function resolveAsset(projectDir, rel) {
  if (!rel) return null;
  if (path.isAbsolute(rel)) return fs.existsSync(rel) ? rel : null;
  const inProject = path.resolve(projectDir, rel);
  if (fs.existsSync(inProject)) return inProject;
  const inApp = path.resolve(APP_DIR, rel);
  if (fs.existsSync(inApp)) return inApp;
  return null;
}

async function getImage(file) {
  if (!file) return null;
  if (IMAGE_CACHE.has(file)) {
    const v = IMAGE_CACHE.get(file);
    IMAGE_CACHE.delete(file);
    IMAGE_CACHE.set(file, v);
    return v;
  }
  const img = await loadImage(file);
  IMAGE_CACHE.set(file, img);
  if (IMAGE_CACHE.size > IMAGE_CACHE_MAX) {
    const first = IMAGE_CACHE.keys().next().value;
    IMAGE_CACHE.delete(first);
  }
  return img;
}

function drawCover(ctx, img, w, h) {
  if (!img) return;
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function slotX(count, index) {
  const norm = count <= 1 ? [0.5] : count === 2 ? [0.29, 0.71] : count === 3 ? [0.2, 0.5, 0.8] : [0.16, 0.38, 0.62, 0.84];
  if (index < norm.length) return norm[index] * 1920;
  return ((index + 1) / (count + 1)) * 1920;
}

async function getBoxImage(projectDir, type) {
  if (type === 'TST') {
    return null; // TST uses the frame sequence
  }
  const p = resolveAsset(projectDir, 'assets/std.png');
  return getImage(p);
}

async function drawCharacters(ctx, projectDir, shot, count) {
  const chars = (shot.characters || []).slice();
  const n = Math.max(count, chars.length);
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    const file = resolveAsset(projectDir, c.asset || c.path || c.file);
    if (!file) continue;
    const img = await getImage(file);
    if (!img) continue;
    const scale = Number(c.scale) > 0 ? Number(c.scale) : 1;
    const targetH = 1080 * 0.88 * scale;
    const targetW = (img.width / img.height) * targetH;
    const baseX = c.x != null ? Number(c.x) * 1920 : slotX(n, i);
    const x = baseX - targetW / 2;
    const y = 1080 - targetH + (Number(c.y) || 0) * 1080;
    ctx.drawImage(img, x, y, targetW, targetH);
  }
}

async function drawVisual(ctx, project, projectDir, group, shot) {
  const { width, height } = project.settings.canvas;
  ctx.clearRect(0, 0, width, height);
  const combined = shot.combined || (group && group.type === 'TST' ? null : null);
  if (combined) {
    const img = await getImage(resolveAsset(projectDir, combined));
    if (img) drawCover(ctx, img, width, height);
    else {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, width, height);
    }
  } else {
    const bg = shot.background || (group && group.background);
    const img = await getImage(resolveAsset(projectDir, bg));
    if (img) drawCover(ctx, img, width, height);
    else {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, width, height);
    }
    await drawCharacters(ctx, projectDir, shot, (shot.characters || []).length);
  }
  if (group && group.type === 'TST') {
    return; // caller draws the animated box
  }
  const box = await getBoxImage(projectDir, 'STD');
  if (box) ctx.drawImage(box, 0, 0, width, height);
}

async function drawTstBox(ctx, project, timeSec) {
  const framesDir = appAsset('assets', 'tst');
  const files = fs.readdirSync(framesDir).filter((f) => /^frame_\d+\.png$/.test(f)).sort();
  if (!files.length) return;
  const fps = project.settings.tst.frameRate || 30;
  const total = files.length;
  let idx = Math.floor(timeSec * fps);
  if (project.settings.tst.loopMode === 'pingpong') {
    const period = total * 2 - 2;
    idx = ((idx % period) + period) % period;
    if (idx >= total) idx = period - idx;
  } else {
    idx = ((idx % total) + total) % total;
  }
  const img = await getImage(path.join(framesDir, files[idx]));
  if (img) ctx.drawImage(img, 0, 0, project.settings.canvas.width, project.settings.canvas.height);
}

function findPageAt(timelineGroup, tMs) {
  for (const shot of timelineGroup.shots) {
    for (const line of shot.lines) {
      for (const page of line.pages) {
        if (tMs >= page.startMs && tMs < page.endMs) return { shot, line, page };
      }
    }
  }
  const lastShot = timelineGroup.shots[timelineGroup.shots.length - 1];
  const lastLine = lastShot && lastShot.lines[lastShot.lines.length - 1];
  const lastPage = lastLine && lastLine.pages[lastLine.pages.length - 1];
  return lastPage ? { shot: lastShot, line: lastLine, page: lastPage } : null;
}

function drawNameTag(ctx, project, speaker) {
  if (!speaker) return;
  const s = project.settings;
  const color = (project.speakerColors && project.speakerColors[speaker]) || '#ffffff';
  const font = fontSpec(s.font.nameSize, 'bold');
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(speaker).width) + s.nameTag.paddingX * 2;
  const h = s.nameTag.height;
  const x = s.nameTag.x;
  const y = s.nameTag.y;
  ctx.save();
  ctx.fillStyle = s.nameTag.background;
  const r = s.nameTag.radius;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(speaker, x + s.nameTag.paddingX, y + h / 2 + 1);
  ctx.restore();
}

function drawDialoguePage(ctx, project, page) {
  if (!page || !page.text) return;
  const s = project.settings;
  const box = s.dialogueBox;
  drawNameTag(ctx, project, page.speaker);
  const font = fontSpec(s.font.dialogueSize);
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = 'top';
  const lineHeight = s.font.dialogueSize * s.font.lineHeight;
  const lines = String(page.text).split('\n');
  let y = box.y;
  for (const line of lines) {
    if (y + lineHeight > box.y + box.height + 2) break;
    if (s.font.outlineWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.strokeStyle = s.font.outlineColor;
      ctx.lineWidth = s.font.outlineWidth * 2;
      ctx.strokeText(line, box.x, y);
    }
    ctx.fillStyle = s.font.dialogueColor;
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 2;
    ctx.fillText(line, box.x, y);
    ctx.shadowColor = 'transparent';
    y += lineHeight;
  }
  ctx.restore();
}

async function renderShotPreview(project, projectDir, timelineGroup, timelineShot, page, outPath) {
  const { width, height } = project.settings.canvas;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const group = project.groups.find((g) => g.key === timelineGroup.key);
  const shot = group.shots.find((s) => s.key === timelineShot.key);
  await drawVisual(ctx, project, projectDir, group, shot);
  if (group.type === 'TST') {
    const contentStart = timelineGroup.contentStartMs != null ? timelineGroup.contentStartMs : timelineGroup.startMs;
    const relMs = page ? page.startMs - contentStart : 0;
    await drawTstBox(ctx, project, relMs / 1000);
  }
  drawDialoguePage(ctx, project, page);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  return outPath;
}

async function renderStdVisual(project, projectDir, timelineGroup, timelineShot, outPath) {
  const group = project.groups.find((g) => g.key === timelineGroup.key);
  const shot = group.shots.find((s) => s.key === timelineShot.key);
  const { width, height } = project.settings.canvas;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  await drawVisual(ctx, project, projectDir, group, shot);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  return outPath;
}

/**
 * Background-only plate for a STD shot. Used on its own draft track so a
 * fade-to-black transition can keep the background visible while every other
 * layer has already ended.
 */
async function renderStdBackground(project, projectDir, timelineGroup, timelineShot, outPath) {
  const group = project.groups.find((g) => g.key === timelineGroup.key);
  const shot = group.shots.find((s) => s.key === timelineShot.key);
  const { width, height } = project.settings.canvas;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const source = shot.combined || shot.background || (group && group.background);
  const img = source ? await getImage(resolveAsset(projectDir, source)) : null;
  if (img) drawCover(ctx, img, width, height);
  else {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, width, height);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  return outPath;
}

/**
 * Transparent character-only plate for a STD shot. Returns null for a
 * "character + background combined" image, which has no separable character.
 */
async function renderStdCharacters(project, projectDir, timelineGroup, timelineShot, outPath) {
  const group = project.groups.find((g) => g.key === timelineGroup.key);
  const shot = group.shots.find((s) => s.key === timelineShot.key);
  if (!shot || shot.combined || !shot.characters || !shot.characters.length) return null;
  const { width, height } = project.settings.canvas;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  await drawCharacters(ctx, projectDir, shot, shot.characters.length);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  return outPath;
}

async function renderTstVisual(project, projectDir, timelineGroup, outPath, options = {}) {
  const group = project.groups.find((g) => g.key === timelineGroup.key);
  const framesDir = path.join(path.dirname(outPath), `tst_frames_${timelineGroup.key}`);
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const fps = project.settings.tst.frameRate || 30;
  const contentStart = timelineGroup.contentStartMs != null ? timelineGroup.contentStartMs : timelineGroup.startMs;
  const contentEnd = timelineGroup.contentEndMs != null ? timelineGroup.contentEndMs : timelineGroup.endMs;
  const durationSec = Math.max(0.5, (contentEnd - contentStart) / 1000);
  const totalFrames = Math.max(1, Math.ceil(durationSec * fps));
  const { width, height } = project.settings.canvas;
  for (let i = 0; i < totalFrames; i += 1) {
    const tMs = contentStart + (i * 1000) / fps;
    const found = findPageAt(timelineGroup, Math.min(tMs, contentEnd - 1)) || { shot: timelineGroup.shots[0] };
    const shot = group.shots.find((s) => s.key === found.shot.key) || group.shots[0];
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    await drawVisual(ctx, project, projectDir, group, shot);
    await drawTstBox(ctx, project, (tMs - contentStart) / 1000);
    fs.writeFileSync(path.join(framesDir, `frame_${String(i + 1).padStart(5, '0')}.png`), canvas.toBuffer('image/png'));
  }
  const out = path.resolve(outPath);
  await encodeFrames(framesDir, 'frame_%05d.png', fps, out);
  if (!options.keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });
  return out;
}

function encodeFrames(framesDir, pattern, fps, outPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const args = [
      '-y',
      '-loglevel', 'error',
      '-framerate', String(fps),
      '-i', path.join(framesDir, pattern),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      outPath,
    ];
    // The DSH sandbox blocks piped child stdio; ignore it and check the exit code.
    // Outside the sandbox this is equally fine because ffmpeg errors are reflected
    // in a non-zero exit code and a missing output file.
    const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outPath)) reject(new Error(`ffmpeg failed with code ${code}`));
      else resolve(outPath);
    });
  });
}

async function renderGroupPreview(project, projectDir, timelineGroup, outPath) {
  const pages = [];
  for (const shot of timelineGroup.shots) for (const line of shot.lines) for (const page of line.pages) pages.push({ shot, line, page });
  const page = pages[0];
  if (!page) return null;
  return renderShotPreview(project, projectDir, timelineGroup, page.shot, page.page, outPath);
}

module.exports = {
  APP_DIR,
  resolveAsset,
  getImage,
  drawCover,
  renderShotPreview,
  renderStdVisual,
  renderStdBackground,
  renderStdCharacters,
  renderTstVisual,
  renderGroupPreview,
  drawTstBox,
  findPageAt,
  encodeFrames,
};
