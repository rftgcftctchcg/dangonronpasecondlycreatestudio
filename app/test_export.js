'use strict';

const fs = require('fs');
const path = require('path');
const { loadProject, buildTimeline } = require('./src/project');
const { renderStdBackground, renderStdCharacters, renderTstVisual } = require('./src/render');
const { buildCapcutDraft } = require('./src/draft');

const PROJECT_DIR = path.join(__dirname, 'data', 'sample');

(async () => {
  const project = loadProject(PROJECT_DIR);
  const timeline = buildTimeline(project, PROJECT_DIR);
  const layerDir = path.join(PROJECT_DIR, 'render', 'layers');
  fs.rmSync(layerDir, { recursive: true, force: true });
  fs.mkdirSync(layerDir, { recursive: true });
  const visuals = {};
  for (const g of timeline.groups) {
    if (g.type === 'TST') {
      const out = path.join(layerDir, `${g.key}_tst.mp4`);
      await renderTstVisual(project, PROJECT_DIR, g, out);
      visuals[g.key] = { type: 'tst', video: path.relative(PROJECT_DIR, out) };
    } else {
      const backgrounds = {};
      const characters = {};
      for (const s of g.shots) {
        const bgOut = path.join(layerDir, `${g.key}_${s.key}_bg.png`);
        await renderStdBackground(project, PROJECT_DIR, g, s, bgOut);
        backgrounds[s.key] = path.relative(PROJECT_DIR, bgOut);
        const charOut = path.join(layerDir, `${g.key}_${s.key}_char.png`);
        const chars = await renderStdCharacters(project, PROJECT_DIR, g, s, charOut);
        if (chars) characters[s.key] = path.relative(PROJECT_DIR, charOut);
      }
      visuals[g.key] = { type: 'std', backgrounds, characters, box: 'assets/std.png' };
    }
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const name = `层测试_${stamp}`;
  const outDir = path.join(PROJECT_DIR, 'output', name);
  fs.rmSync(outDir, { recursive: true, force: true });
  const result = await buildCapcutDraft({
    project,
    projectDir: PROJECT_DIR,
    timeline,
    visuals,
    outDir,
    draftName: name,
    draftRoot: null,
  });
  console.log(JSON.stringify({
    name,
    folder: result.draftFolder,
    durationMs: timeline.durationMs,
    tracks: result.trackCounts,
    mediaCount: result.mediaCount,
    materialCount: result.materialCount,
    storedBytes: result.storedBytes,
    transitions: timeline.transitions,
  }, null, 2));
})().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
