'use strict';

const fs = require('fs');
const path = require('path');
const { loadProject, buildTimeline } = require('./src/project');
const { buildCapcutDraft } = require('./src/draft');

const PROJECT_DIR = path.join(__dirname, 'data', 'sample');
const LAYER_DIR = path.join(PROJECT_DIR, 'render', 'layers');

(async () => {
  const project = loadProject(PROJECT_DIR);
  const timeline = buildTimeline(project, PROJECT_DIR);
  const visuals = {};
  for (const g of timeline.groups) {
    if (g.type === 'TST') {
      visuals[g.key] = { type: 'tst', video: path.relative(PROJECT_DIR, path.join(LAYER_DIR, `${g.key}_tst.mp4`)) };
    } else {
      const backgrounds = {};
      const characters = {};
      for (const s of g.shots) {
        backgrounds[s.key] = path.relative(PROJECT_DIR, path.join(LAYER_DIR, `${g.key}_${s.key}_bg.png`));
        const charFile = path.join(LAYER_DIR, `${g.key}_${s.key}_char.png`);
        if (fs.existsSync(charFile)) characters[s.key] = path.relative(PROJECT_DIR, charFile);
      }
      visuals[g.key] = { type: 'std', backgrounds, characters, box: 'assets/std.png' };
    }
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const name = `示例项目_最终_${stamp}`;
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
    storedBytes: result.storedBytes,
    transitions: timeline.transitions,
    openings: timeline.groups.filter((g) => g.opening).map((g) => ({ key: g.key, startMs: g.opening.startMs, durationMs: g.opening.durationMs })),
  }, null, 2));
})().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
