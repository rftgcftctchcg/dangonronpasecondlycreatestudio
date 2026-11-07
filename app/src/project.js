'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseScript } = require('./parser');
const { ensureFont, fontSpec, paginateText, defaultDuration } = require('./text');

const DEFAULT_SETTINGS = {
  canvas: { width: 1920, height: 1080 },
  fps: 30,
  font: {
    path: 'assets/fonts/NotoSansSC.otf',
    displayName: 'Noto Sans SC',
    dialogueSize: 44,
    nameSize: 34,
    lineHeight: 1.35,
    maxLines: 3,
    maxWidth: 1740,
    dialogueColor: '#ffffff',
    outlineColor: '#000000',
    outlineWidth: 3,
    nameColors: ['#ff6b6b', '#4dabf7', '#69db7c', '#ffa94d', '#b197fc', '#66d9e8'],
  },
  // 20 Chinese characters should land around 3.0s, not 4s+.
  reading: { speed: 0.13, min: 1.2, max: 10, base: 0.35, punctuation: 0.06 },
  nameTag: { x: 80, y: 700, height: 54, paddingX: 18, radius: 8, background: 'rgba(0,0,0,0.72)' },
  dialogueBox: { x: 90, y: 780, width: 1740, height: 260 },
  // CapCut text-layer calibration. transform.x/y are fractions of canvas W/H.
  capcut: {
    version: 2,
    // Calibrated against a real CapCut 9.0.0 draft (0828):
    // UI shows name 8 / dialogue 7, positions -1547,-391 and -349,-794.
    dialogueFontSize: 6.831579208374023,
    nameFontSize: 8.105263157894736,
    nameX: -0.8059006211180124,
    dialogueX: -0.1816415194398868,
    nameY: -0.36187845303867405,
    dialogueY: -0.7348066298342542,
    nameAlignment: 1,
    dialogueAlignment: 0,
    // CapCut's free built-in text intro animation "Typewriter" (打字机).
    typewriter: {
      enabled: true,
      resourceId: '7210980292243231233',
      name: 'Typewriter',
      ratio: 0.28,
      min: 0.3,
      max: 1.6,
    },
  },
  tst: { frameRate: 30, loopMode: 'pingpong' },
  bgm: { fadeIn: 0.3, fadeOut: 0.3, loopShort: true },
  // Simple fade-to-black between STD shots. 0.6s total = 0.3s out + 0.3s in.
  transition: { enabled: true, duration: 0.6 },
  // Full-screen opening movie inserted before every TST (class trial) group.
  trialOpening: { enabled: true, path: 'assets/trial_opening.mov', duration: 2.972 },
};

const SAMPLE_SCRIPT = `[组 1:begin][STD]
[分镜 1:begin]
足立零：XXX
王马小吉：222
[分镜 1:end]
[分镜 2:begin]
足立零：这是第二个分镜，背景和人物都可以在界面里替换。
[分镜 2:end]
[组 1:end]

[组 2:begin][TST]
[分镜 1:begin]
足立零：学级裁判，开始！
王马小吉：唔噗噗……这次一定不会输。
[分镜 1:end]
[组 2:end]

[组 3:begin][STD]
[分镜 1:begin]
旁白：这是一段较长的示例文本，用来演示自动换行与分页。真实剧本里可以继续写很多内容，生成器会按照阅读速度计算每一页的停留时间。
[分镜 1:end]
[组 3:end]
`;

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function mergeDeep(base, override) {
  const out = deepClone(base);
  if (!isPlainObject(override)) return out;
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeDeep(out[k], v);
    else out[k] = deepClone(v);
  }
  return out;
}

function hashString(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function colorForSpeaker(name, palette) {
  if (!name) return '#ffffff';
  let h = 0;
  for (const ch of Array.from(name)) h = (h * 31 + ch.codePointAt(0)) % 100000;
  return palette[h % palette.length];
}

function collateAssignments(parsed, settings, previous = null) {
  const groups = parsed.groups.map((g) => {
    const prevGroup = previous && previous.groups ? previous.groups.find((x) => x.key === g.key || x.label === g.label) : null;
    return {
      ...g,
      background: prevGroup ? prevGroup.background : (g.type === 'TST' ? 'assets/trial_bg.jpg' : 'assets/sample_bg.png'),
      bgm: prevGroup ? prevGroup.bgm : null,
      bgmDuration: prevGroup ? prevGroup.bgmDuration : null,
      shots: g.shots.map((s) => {
        const prevShot = prevGroup && prevGroup.shots ? prevGroup.shots.find((x) => x.key === s.key || x.label === s.label) : null;
        return {
          ...s,
          background: prevShot ? prevShot.background : null,
          combined: prevShot ? prevShot.combined : null,
          characters: prevShot ? prevShot.characters : [],
          lineDurations: prevShot ? prevShot.lineDurations : {},
        };
      }),
    };
  });
  return groups;
}

function createProject(scriptText = SAMPLE_SCRIPT, name = '示例项目') {
  ensureFont(path.resolve(__dirname, '..', 'assets', 'fonts', 'NotoSansSC.otf'));
  const parsed = parseScript(scriptText);
  const project = {
    schemaVersion: 1,
    name,
    script: scriptText,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: deepClone(DEFAULT_SETTINGS),
    groups: collateAssignments(parsed, DEFAULT_SETTINGS),
    assets: { backgrounds: [], characters: [], bgm: [] },
    source: { script: 'script.txt' },
  };
  assignSpeakerColors(project);
  return project;
}

function assignSpeakerColors(project) {
  const palette = project.settings.font.nameColors;
  const speakers = new Set();
  for (const g of project.groups) for (const s of g.shots) for (const l of s.lines) if (l.speaker) speakers.add(l.speaker);
  project.speakerColors = project.speakerColors || {};
  for (const sp of speakers) if (!project.speakerColors[sp]) project.speakerColors[sp] = colorForSpeaker(sp, palette);
}

function loadProject(projectDir) {
  const file = path.join(projectDir, 'project.json');
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  const oldCapcutVersion = p.settings && p.settings.capcut ? p.settings.capcut.version : undefined;
  // Merge new defaults into projects created by older versions.
  p.settings = mergeDeep(DEFAULT_SETTINGS, p.settings || {});
  if (!p.settings.reading.version) {
    // Migrate the old 0.18s/char + 0.8s base pacing to the 20 chars ≈ 3s rule.
    p.settings.reading = { ...deepClone(DEFAULT_SETTINGS.reading), version: 2 };
  }
  if (!oldCapcutVersion || oldCapcutVersion < 2) {
    // Migrate old approximate text transforms to the values verified in CapCut.
    p.settings.capcut = deepClone(DEFAULT_SETTINGS.capcut);
  }
  ensureFont(resolveProjectPath(projectDir, p.settings.font.path));
  assignSpeakerColors(p);
  return p;
}

function saveProject(projectDir, project) {
  fs.mkdirSync(projectDir, { recursive: true });
  project.updatedAt = new Date().toISOString();
  const tmp = path.join(projectDir, 'project.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2), 'utf8');
  fs.renameSync(tmp, path.join(projectDir, 'project.json'));
}

function ms(v) {
  return Math.round(v * 1000);
}

/**
 * Build the authoritative timeline.
 *
 * Units: seconds internally, milliseconds in the returned structure.
 *
 * Layer rules for a fade-to-black transition (duration T):
 *   A.contentEnd ── T/2 ── A.end == B.start ── T/2 ── B.contentStart
 *   - Background A covers [A.start, A.end], background B covers [B.start, B.end].
 *   - Characters / dialogue box / text end at A.contentEnd and resume at B.contentStart.
 *   - A black overlay covers [A.contentEnd, B.contentStart] with alpha 0 → 1 → 0.
 *   - A TST group gets a full-screen opening movie instead of a black transition.
 */
function buildTimeline(project, projectDir) {
  const s = project.settings;
  const fontPath = resolveProjectPath(projectDir, s.font.path);
  ensureFont(fontPath);
  const dialogueFont = fontSpec(s.font.dialogueSize);
  const transitionEnabled = !s.transition || s.transition.enabled !== false;
  const transitionSec = transitionEnabled ? Math.max(0, Number(s.transition.duration || 0.6)) : 0;
  const openingEnabled = !s.trialOpening || s.trialOpening.enabled !== false;
  const openingPath = (s.trialOpening && s.trialOpening.path) || 'assets/trial_opening.mov';
  const openingSec = openingEnabled ? Math.max(0, Number((s.trialOpening && s.trialOpening.duration) || 2.972)) : 0;

  const flat = [];
  project.groups.forEach((g, gi) => g.shots.forEach((sh, si) => flat.push({ g, sh, gi, si })));

  const gaps = [];
  for (let i = 0; i < flat.length - 1; i += 1) {
    const a = flat[i];
    const b = flat[i + 1];
    if (transitionEnabled && transitionSec > 0 && a.g.type === 'STD' && b.g.type === 'STD') {
      gaps.push({ type: 'black', gapMs: transitionSec * 1000, outPadMs: (transitionSec * 1000) / 2, inPadMs: (transitionSec * 1000) / 2 });
    } else {
      gaps.push({ type: 'none', gapMs: 0, outPadMs: 0, inPadMs: 0 });
    }
  }

  let cursor = 0;
  let shotIndex = 0;
  const groups = [];
  const transitions = [];

  for (const g of project.groups) {
    let opening = null;
    if (openingEnabled && openingSec > 0 && g.type === 'TST') {
      opening = { path: openingPath, startMs: ms(cursor), endMs: ms(cursor + openingSec), durationMs: ms(openingSec) };
      cursor += openingSec;
    }
    const groupContentStart = cursor;
    const shots = [];

    for (const sh of g.shots) {
      const idx = shotIndex;
      const inPad = idx === 0 ? 0 : gaps[idx - 1].inPadMs / 1000;
      const outPad = idx === flat.length - 1 ? 0 : gaps[idx].outPadMs / 1000;
      const shotStart = cursor - inPad;
      const contentStart = cursor;
      const lines = [];

      for (const line of sh.lines) {
        const lineStart = cursor;
        const pagesText = paginateText(line.text, {
          font: dialogueFont,
          maxWidth: s.font.maxWidth,
          maxLines: s.font.maxLines,
        });
        const override = sh.lineDurations && sh.lineDurations[line.key];
        const baseDuration = override != null
          ? Number(override)
          : defaultDuration(line.text, s.reading.speed, s.reading.min, s.reading.max);
        const per = baseDuration / Math.max(1, pagesText.length);
        const pages = [];
        for (const text of pagesText) {
          const pageStart = cursor;
          const d = Math.max(0.6, Math.round(per * 1000) / 1000);
          cursor += d;
          pages.push({ text, speaker: line.speaker, startMs: ms(pageStart), endMs: ms(cursor), durationMs: ms(cursor) - ms(pageStart), start: pageStart, duration: d });
        }
        lines.push({
          key: line.key,
          index: line.index,
          speaker: line.speaker,
          text: line.text,
          startMs: ms(lineStart),
          endMs: ms(cursor),
          durationMs: ms(cursor) - ms(lineStart),
          pages,
        });
      }

      const contentEnd = cursor;
      const shotEnd = contentEnd + outPad;
      shots.push({
        key: sh.key,
        index: sh.index,
        label: sh.label,
        background: sh.background || g.background,
        combined: sh.combined || null,
        characters: sh.characters || [],
        startMs: ms(shotStart),
        endMs: ms(shotEnd),
        contentStartMs: ms(contentStart),
        contentEndMs: ms(contentEnd),
        inPadMs: ms(inPad),
        outPadMs: ms(outPad),
        durationMs: ms(shotEnd) - ms(shotStart),
        lines,
      });

      if (idx < flat.length - 1) {
        const gap = gaps[idx];
        if (gap.type === 'black') {
          transitions.push({
            type: 'black',
            groupKey: g.key,
            shotKey: sh.key,
            startMs: ms(contentEnd),
            endMs: ms(contentEnd + gap.gapMs / 1000),
            durationMs: Math.round(gap.gapMs),
          });
        }
        cursor = contentEnd + gap.gapMs / 1000;
      }
      shotIndex += 1;
    }

    if (!shots.length) continue;
    const first = shots[0];
    const last = shots[shots.length - 1];
    const groupStart = opening ? opening.startMs / 1000 : first.startMs / 1000;
    const groupEnd = last.endMs / 1000;
    groups.push({
      key: g.key,
      index: g.index,
      label: g.label,
      type: g.type,
      background: g.background,
      bgm: g.bgm || null,
      bgmDuration: g.bgmDuration || null,
      startMs: ms(groupStart),
      endMs: ms(groupEnd),
      durationMs: ms(groupEnd) - ms(groupStart),
      contentStartMs: ms(groupContentStart),
      contentEndMs: last.contentEndMs,
      bgmStartMs: ms(groupContentStart),
      opening,
      shots,
    });
  }

  return { durationMs: ms(cursor), groups, transitions, duration: cursor };
}

function resolveProjectPath(projectDir, rel) {
  if (!rel) return null;
  if (path.isAbsolute(rel)) return rel;
  return path.resolve(projectDir, rel);
}

module.exports = {
  DEFAULT_SETTINGS,
  SAMPLE_SCRIPT,
  createProject,
  loadProject,
  saveProject,
  buildTimeline,
  assignSpeakerColors,
  colorForSpeaker,
  resolveProjectPath,
  hashString,
  deepClone,
  mergeDeep,
};
