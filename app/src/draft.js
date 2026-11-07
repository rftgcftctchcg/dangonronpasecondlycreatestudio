'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { APP_DIR, resolveAsset } = require('./render');

const skeletonData = require('./capcut_skeleton.json');
const metaTemplate = require('./draft_meta_template.json');

function uuid() {
  return crypto.randomUUID();
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function hexToRgb(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, 'f');
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
}

function mediaDurationSec(file) {
  // Kept for callers that already have a duration; probing is done at upload time.
  return 0;
}

function imageSize() {
  return { width: 1920, height: 1080 };
}

function makeExtra(store, type, overrides = {}) {
  const proto = skeletonData.prototypes[type];
  if (!proto) throw new Error(`Missing material prototype: ${type}`);
  const obj = clone(proto);
  obj.id = uuid();
  Object.assign(obj, overrides);
  store.push(obj);
  return obj.id;
}

function makeVideoMaterial(store, file, options = {}) {
  const p = clone(skeletonData.prototypes.videos);
  const localId = uuid();
  const size = imageSize(file);
  p.id = uuid();
  p.type = options.video ? 'video' : 'photo';
  p.duration = options.video ? Math.max(1, Math.round((options.durationSec || 1) * 1e6)) : 10800000000;
  p.path = toPosix(file);
  p.media_path = '';
  p.local_id = '';
  p.has_audio = !!options.hasAudio;
  p.width = size.width;
  p.height = size.height;
  p.material_name = path.basename(file);
  p.material_id = '';
  p.material_url = '';
  p.local_material_id = localId;
  p.extra_info = path.basename(file);
  store.push(p);
  return { material: p, localId };
}

function makeAudioMaterial(store, file, durationSec) {
  const p = clone(skeletonData.prototypes.audios);
  const localId = uuid();
  p.id = uuid();
  p.path = toPosix(file);
  p.name = path.basename(file);
  p.duration = Math.max(1, Math.round((durationSec || 30) * 1e6));
  p.local_material_id = localId;
  p.category_name = 'local';
  p.type = 'extract_music';
  store.push(p);
  return { material: p, localId, duration: p.duration };
}

function makeTextMaterial(store, opts) {
  const p = clone(skeletonData.prototypes.texts);
  p.id = uuid();
  p.name = opts.name || '';
  p.type = 'text';
  const fontPath = toPosix(opts.fontPath);
  const color = hexToRgb(opts.color);
  const size = opts.size;
  const text = String(opts.text || '');
  const payload = {
    text,
    styles: [
      {
        fill: { content: { render_type: 'solid', solid: { color } } },
        font: { path: fontPath, id: '' },
        size,
        range: [0, text.length],
      },
    ],
  };
  p.content = JSON.stringify(payload);
  p.base_content = '';
  p.font_path = fontPath;
  p.font_name = opts.fontName || '';
  p.font_size = size;
  p.text_color = opts.color || '#FFFFFF';
  p.text_alpha = 1.0;
  p.border_color = opts.borderColor || '#000000';
  p.border_width = opts.borderWidth != null ? opts.borderWidth : 0.08;
  p.border_mode = 0;
  p.has_shadow = opts.shadow !== false;
  p.shadow_color = opts.shadowColor || '#000000';
  p.shadow_alpha = 0.8;
  p.shadow_distance = 4.0;
  p.shadow_smoothing = 0.45;
  p.line_spacing = opts.lineSpacing != null ? opts.lineSpacing : 0.02;
  p.alignment = opts.alignment != null ? opts.alignment : 0;
  p.fixed_width = -1.0;
  p.line_max_width = opts.lineMaxWidth != null ? opts.lineMaxWidth : 0.906;
  p.text_size = 30;
  p.initial_scale = 1.0;
  p.letter_spacing = 0.0;
  p.background_color = opts.background || '';
  p.background_alpha = opts.background ? 0.72 : 1.0;
  p.background_style = opts.background ? 1 : 0;
  p.background_round_radius = opts.background ? 0.12 : 0.0;
  p.background_width = opts.background ? 0.14 : 0.14;
  p.background_height = opts.background ? 0.14 : 0.14;
  p.background_vertical_offset = 0.0;
  p.background_horizontal_offset = 0.0;
  p.is_rich_text = false;
  p.use_effect_default_color = true;
  store.push(p);
  return p;
}

function makeVideoSegment(proto, opts) {
  const seg = clone(proto);
  seg.id = uuid();
  seg.material_id = opts.materialId;
  seg.source_timerange = { start: opts.sourceStart || 0, duration: opts.duration };
  seg.target_timerange = { start: opts.targetStart, duration: opts.duration };
  seg.render_timerange = { start: 0, duration: 0 };
  seg.speed = 1.0;
  seg.volume = opts.volume != null ? opts.volume : 1.0;
  seg.visible = true;
  seg.clip = seg.clip || {};
  seg.clip.scale = { x: 1.0, y: 1.0 };
  seg.clip.rotation = 0.0;
  seg.clip.transform = { x: 0.0, y: 0.0 };
  seg.clip.alpha = 1.0;
  seg.render_index = opts.renderIndex || 0;
  seg.extra_material_refs = opts.extraRefs || [];
  seg.common_keyframes = opts.commonKeyframes || [];
  return seg;
}

function makeTextSegment(proto, opts) {
  const seg = clone(proto);
  seg.id = uuid();
  seg.material_id = opts.materialId;
  seg.source_timerange = null;
  seg.target_timerange = { start: opts.targetStart, duration: opts.duration };
  seg.render_timerange = { start: 0, duration: 0 };
  seg.speed = 1.0;
  seg.volume = 1.0;
  seg.visible = true;
  seg.clip = seg.clip || {};
  seg.clip.scale = { x: 1.0, y: 1.0 };
  seg.clip.rotation = 0.0;
  seg.clip.transform = { x: opts.x != null ? opts.x : 0.0, y: opts.y != null ? opts.y : 0.667 };
  seg.clip.alpha = 1.0;
  seg.render_index = opts.renderIndex || 14000;
  seg.extra_material_refs = opts.extraRefs || [];
  return seg;
}

function makeAudioSegment(proto, opts) {
  const seg = clone(proto);
  seg.id = uuid();
  seg.material_id = opts.materialId;
  seg.source_timerange = { start: opts.sourceStart || 0, duration: opts.duration };
  seg.target_timerange = { start: opts.targetStart, duration: opts.duration };
  seg.render_timerange = { start: 0, duration: 0 };
  seg.speed = 1.0;
  seg.volume = opts.volume != null ? opts.volume : 1.0;
  seg.clip = null;
  seg.uniform_scale = null;
  seg.render_index = 0;
  seg.extra_material_refs = opts.extraRefs || [];
  return seg;
}

function makeTrack(type, name) {
  return { id: uuid(), type, segments: [], flag: 0, attribute: 0, name: name || '', is_default_name: !name };
}

function alphaKeyframes(durationUs) {
  const kf = (time, value) => ({
    curveType: 'Line',
    graphID: '',
    left_control: { x: 0.0, y: 0.0 },
    right_control: { x: 0.0, y: 0.0 },
    id: uuid(),
    time_offset: Math.round(time),
    values: [value],
  });
  const half = Math.max(1, Math.round(durationUs / 2));
  return [
    {
      id: uuid(),
      keyframe_list: [
        kf(0, 0.0),
        kf(half, 1.0),
        kf(Math.max(half + 1, durationUs - 1000), 0.0),
      ],
      material_id: '',
      property_type: 'KFTypeAlpha',
    },
  ];
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed with code ${code}`))));
  });
}

async function extractAudio(videoFile, outFile) {
  if (!videoFile || !fs.existsSync(videoFile)) return null;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  try {
    await runFfmpeg(['-y', '-loglevel', 'error', '-i', videoFile, '-vn', '-c:a', 'aac', '-b:a', '192k', outFile]);
    return fs.existsSync(outFile) ? outFile : null;
  } catch (e) {
    return null;
  }
}

function makeBlackPng(file) {
  const canvas = createCanvas(1920, 1080);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 1920, 1080);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  return file;
}

async function makeCover(project, projectDir, firstVisualPath, outPath) {
  const { width, height } = project.settings.canvas;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, width, height);
  if (firstVisualPath && fs.existsSync(firstVisualPath)) {
    try {
      const img = await loadImage(firstVisualPath);
      const scale = Math.max(width / img.width, height / img.height);
      ctx.drawImage(img, (width - img.width * scale) / 2, (height - img.height * scale) / 2, img.width * scale, img.height * scale);
    } catch (e) {
      /* ignore */
    }
  }
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, height - 180, width, 180);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 64px VNText';
  ctx.fillText(project.name || '视觉小说', 70, height - 95);
  fs.writeFileSync(outPath, canvas.toBuffer('image/jpeg', 90));
}

/**
 * Build a self-contained CapCut draft folder.
 *
 * Every image, video, audio file and font is copied into <draft>/materials and
 * referenced by an absolute path inside that draft. installDraft() rewrites the
 * prefix when the folder is copied into CapCut's draft root.
 *
 * visuals:
 *   { [groupKey]: { type:'std', backgrounds:{shotKey:path}, characters:{shotKey:path}, box:path }
 *                | { type:'tst', video:path } }
 */
async function buildCapcutDraft(options) {
  const { project, projectDir, timeline, visuals, outDir, draftName, draftRoot } = options;
  const skeleton = clone(skeletonData.skeleton);
  const segProtos = skeletonData.segmentPrototypes;
  const materials = skeleton.materials;
  const tracks = [];
  const draftFolder = path.resolve(outDir);
  const materialsDir = path.join(draftFolder, 'materials');
  fs.mkdirSync(materialsDir, { recursive: true });

  const copyCache = new Map();
  const usedNames = new Set();
  const copyInto = (src, subdir, preferred) => {
    const abs = path.resolve(src);
    if (copyCache.has(abs)) return copyCache.get(abs);
    if (!fs.existsSync(abs)) throw new Error(`素材不存在：${src}`);
    const ext = (path.extname(abs) || '.bin').toLowerCase();
    let base = preferred || path.basename(abs, path.extname(abs));
    base = String(base).replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'asset';
    let rel = `${subdir}/${base}${ext}`;
    let n = 2;
    while (usedNames.has(rel.toLowerCase())) {
      rel = `${subdir}/${base}_${n}${ext}`;
      n += 1;
    }
    usedNames.add(rel.toLowerCase());
    const dest = path.join(materialsDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (path.resolve(dest) !== abs) fs.copyFileSync(abs, dest);
    copyCache.set(abs, dest);
    return dest;
  };

  skeleton.id = uuid();
  skeleton.name = draftName || project.name || '视觉小说';
  skeleton.duration = timeline.durationMs * 1000;
  skeleton.fps = project.settings.fps || 30;
  skeleton.canvas_config = { width: project.settings.canvas.width, height: project.settings.canvas.height, ratio: '16:9', background: null };
  skeleton.create_time = nowSec();
  skeleton.update_time = nowSec();
  skeleton.platform = { os: 'windows', os_version: '10.0.19045', app_id: 359289, app_version: '9.0.0', app_source: 'cc', device_id: '', hard_disk_id: '', mac_address: '' };
  skeleton.last_modified_platform = clone(skeleton.platform);
  skeleton.tracks = tracks;

  const mediaEntries = [];
  const registerMedia = (file, kind, extra = {}) => {
    const id = uuid();
    const entry = {
      ai_group_type: '',
      create_time: -1,
      duration: extra.duration || 5000000,
      enter_from: 0,
      extra_info: path.basename(file),
      file_Path: toPosix(file),
      height: extra.height != null ? extra.height : 1080,
      id,
      import_time: -1,
      import_time_ms: -1,
      item_source: 1,
      material_color_tag: '',
      md5: '',
      metetype: kind,
      roughcut_time_range: { duration: -1, start: -1 },
      sub_time_range: { duration: -1, start: -1 },
      type: 0,
      width: extra.width != null ? extra.width : 1920,
    };
    mediaEntries.push(entry);
    return id;
  };

  const mainTrack = makeTrack('video', '主画面');
  const charTrack = makeTrack('video', '人物');
  const boxTrack = makeTrack('video', '对话框');
  const dialogueTrack = makeTrack('text', '台词');
  const nameTrack = makeTrack('text', '姓名');
  const transitionTrack = makeTrack('video', '转场');
  const openingAudioTrack = makeTrack('audio', '开庭音效');
  const audioTrack = makeTrack('audio', 'BGM');
  // CapCut's main track auto-joins clips and cannot contain gaps. Every clip
  // that occupies the full frame (STD background, trial opening, TST composite)
  // must live on this one contiguous track, otherwise later backgrounds shift.
  tracks.push(mainTrack, charTrack, boxTrack, dialogueTrack, nameTrack, transitionTrack, openingAudioTrack, audioTrack);

  const fontSource = resolveAsset(projectDir, project.settings.font.path) || path.join(APP_DIR, 'assets', 'fonts', 'NotoSansSC.otf');
  const fontPath = copyInto(fontSource, 'fonts', 'NotoSansSC');
  const fontName = project.settings.font.displayName || 'NotoSansSC';
  const capcut = project.settings.capcut || {};
  const dialogueSize = capcut.dialogueFontSize || 4.0;
  const nameSize = capcut.nameFontSize || 3.2;
  const dialogueY = capcut.dialogueY != null ? capcut.dialogueY : -0.667;
  const nameY = capcut.nameY != null ? capcut.nameY : -0.173;
  const dialogueX = capcut.dialogueX != null ? capcut.dialogueX : -0.453;
  const nameX = capcut.nameX != null ? capcut.nameX : -0.45;
  const typewriter = capcut.typewriter || {};
  const nameAlignment = capcut.nameAlignment != null ? capcut.nameAlignment : 1;
  const dialogueAlignment = capcut.dialogueAlignment != null ? capcut.dialogueAlignment : 0;
  const projectAbs = (rel) => (rel ? path.resolve(projectDir, rel) : null);

  const videoExtras = () => [
    makeExtra(materials.speeds, 'speeds', { speed: 1.0 }),
    makeExtra(materials.placeholder_infos, 'placeholder_infos'),
    makeExtra(materials.canvases, 'canvases'),
    makeExtra(materials.material_animations, 'material_animations'),
    makeExtra(materials.sound_channel_mappings, 'sound_channel_mappings'),
    makeExtra(materials.material_colors, 'material_colors'),
    makeExtra(materials.loudnesses, 'loudnesses'),
    makeExtra(materials.vocal_separations, 'vocal_separations'),
  ];

  const addPhoto = (track, file, startMs, endMs, preferred) => {
    const copied = copyInto(file, 'images', preferred);
    const localId = registerMedia(copied, 'photo', { duration: 5000000, width: 1920, height: 1080 });
    const mat = makeVideoMaterial(materials.videos, copied, { video: false });
    mat.material.local_material_id = localId;
    const seg = makeVideoSegment(segProtos.video, {
      materialId: mat.material.id,
      targetStart: Math.round(startMs * 1000),
      duration: Math.max(1, Math.round((endMs - startMs) * 1000)),
      renderIndex: 0,
      extraRefs: videoExtras(),
    });
    track.segments.push(seg);
    return seg;
  };

  const addVideo = (track, file, startMs, endMs, opts = {}) => {
    const copied = copyInto(file, opts.subdir || 'video', opts.preferred || 'video');
    const durationMs = Math.max(1, endMs - startMs);
    const localId = registerMedia(copied, 'video', { duration: Math.round(durationMs * 1000), width: 1920, height: 1080 });
    const mat = makeVideoMaterial(materials.videos, copied, {
      video: true,
      durationSec: durationMs / 1000,
      hasAudio: !!opts.hasAudio,
    });
    mat.material.local_material_id = localId;
    const seg = makeVideoSegment(segProtos.video, {
      materialId: mat.material.id,
      targetStart: Math.round(startMs * 1000),
      duration: Math.round(durationMs * 1000),
      renderIndex: 0,
      extraRefs: videoExtras(),
      volume: opts.volume != null ? opts.volume : 1.0,
    });
    track.segments.push(seg);
    return seg;
  };

  // Shared STD dialogue-box overlay.
  const stdBoxSource = resolveAsset(projectDir, 'assets/std.png') || path.join(APP_DIR, 'assets', 'std.png');
  const stdBoxPath = copyInto(stdBoxSource, 'ui', 'std_box');

  // Shared black plate for fade transitions.
  const blackPath = makeBlackPng(path.join(materialsDir, 'ui', 'black.png'));

  for (const g of timeline.groups) {
    const vis = visuals[g.key];
    if (!vis) continue;

    if (g.opening) {
      const openingAbs = resolveAsset(projectDir, g.opening.path) || path.join(APP_DIR, 'assets', 'trial_opening.mov');
      const openingAudio = await extractAudio(openingAbs, path.join(materialsDir, 'audio', 'trial_opening.m4a'));
      addVideo(mainTrack, openingAbs, g.opening.startMs, g.opening.endMs, {
        preferred: 'trial_opening',
        volume: openingAudio ? 0.0 : 1.0,
        hasAudio: !openingAudio,
      });
      if (openingAudio) {
        const copied = copyInto(openingAudio, 'audio', 'trial_opening');
        const audio = makeAudioMaterial(materials.audios, copied, g.opening.durationMs / 1000);
        const localId = registerMedia(copied, 'music', { duration: audio.duration, width: 0, height: 0 });
        audio.material.local_material_id = localId;
        const extraRefs = [
          makeExtra(materials.speeds, 'speeds', { speed: 1.0 }),
          makeExtra(materials.placeholder_infos, 'placeholder_infos'),
          makeExtra(materials.audio_fades, 'audio_fades', { fade_in_duration: 0, fade_out_duration: 0 }),
          makeExtra(materials.beats, 'beats'),
          makeExtra(materials.sound_channel_mappings, 'sound_channel_mappings'),
          makeExtra(materials.vocal_separations, 'vocal_separations'),
        ];
        openingAudioTrack.segments.push(
          makeAudioSegment(segProtos.audio, {
            materialId: audio.material.id,
            targetStart: g.opening.startMs * 1000,
            sourceStart: 0,
            duration: g.opening.durationMs * 1000,
            extraRefs,
          }),
        );
      }
    }

    if (vis.type === 'tst' && vis.video) {
      const file = projectAbs(vis.video) || vis.video;
      addVideo(mainTrack, file, g.contentStartMs, g.contentEndMs, { preferred: `tst_${g.key}`, subdir: 'video' });
    } else if (vis.type === 'std') {
      for (const shot of g.shots) {
        const bg = vis.backgrounds && vis.backgrounds[shot.key];
        if (bg) addPhoto(mainTrack, projectAbs(bg) || bg, shot.startMs, shot.endMs, `bg_${g.key}_${shot.key}`);
        const chars = vis.characters && vis.characters[shot.key];
        if (chars) addPhoto(charTrack, projectAbs(chars) || chars, shot.contentStartMs, shot.contentEndMs, `char_${g.key}_${shot.key}`);
        addPhoto(boxTrack, stdBoxPath, shot.contentStartMs, shot.contentEndMs, 'std_box_seg');
      }
    }

    // Text pages: one name clip and one dialogue clip per page.
    for (const shot of g.shots) {
      for (const line of shot.lines) {
        for (const page of line.pages) {
          const start = page.startMs * 1000;
          const dur = page.durationMs * 1000;
          if (page.speaker) {
            const color = (project.speakerColors && project.speakerColors[page.speaker]) || '#ffffff';
            const nameMat = makeTextMaterial(materials.texts, {
              text: page.speaker,
              name: page.speaker,
              fontPath,
              fontName,
              size: nameSize,
              color,
              borderColor: '#000000',
              borderWidth: 0.08,
              shadow: false,
              lineMaxWidth: 0.82,
              alignment: nameAlignment,
            });
            const animId = makeExtra(materials.material_animations, 'material_animations');
            nameTrack.segments.push(
              makeTextSegment(segProtos.text, {
                materialId: nameMat.id,
                targetStart: start,
                duration: dur,
                y: nameY,
                x: nameX,
                renderIndex: 14001,
                extraRefs: [animId],
              }),
            );
          }
          const dialogueMat = makeTextMaterial(materials.texts, {
            text: page.text,
            name: '',
            fontPath,
            fontName,
            size: dialogueSize,
            color: '#FFFFFF',
            borderColor: '#000000',
            borderWidth: 0.08,
            shadow: false,
            lineMaxWidth: 0.82,
            alignment: dialogueAlignment,
          });
          const animId2 = makeExtra(materials.material_animations, 'material_animations');
          if (typewriter.enabled !== false && dur > 300000) {
            const anim = materials.material_animations.find((m) => m.id === animId2);
            const ratio = typewriter.ratio != null ? typewriter.ratio : 0.28;
            const minUs = Math.round((typewriter.min != null ? typewriter.min : 0.3) * 1e6);
            const maxUs = Math.round((typewriter.max != null ? typewriter.max : 1.6) * 1e6);
            const animDur = Math.max(minUs, Math.min(maxUs, Math.round(dur * ratio), dur - 100000));
            anim.animations = [
              {
                anim_adjust_params: null,
                platform: 'all',
                panel: '',
                material_type: 'sticker',
                name: typewriter.name || 'Typewriter',
                id: typewriter.resourceId || '7210980292243231233',
                type: 'in',
                resource_id: typewriter.resourceId || '7210980292243231233',
                start: 0,
                duration: animDur,
              },
            ];
          }
          dialogueTrack.segments.push(
            makeTextSegment(segProtos.text, {
              materialId: dialogueMat.id,
              targetStart: start,
              duration: dur,
              y: dialogueY,
              x: dialogueX,
              renderIndex: 14000,
              extraRefs: [animId2],
            }),
          );
        }
      }
    }

    // BGM starts after the trial opening, not underneath its audio.
    if (g.bgm) {
      const bgmFile = projectAbs(g.bgm);
      if (bgmFile && fs.existsSync(bgmFile)) {
        const copied = copyInto(bgmFile, 'audio', `bgm_${g.key}`);
        const audio = makeAudioMaterial(materials.audios, copied, g.bgmDuration || 30);
        const localId = registerMedia(copied, 'music', { duration: audio.duration, width: 0, height: 0 });
        audio.material.local_material_id = localId;
        const bgmStart = g.bgmStartMs != null ? g.bgmStartMs : g.startMs;
        let remaining = Math.max(0, g.contentEndMs - bgmStart);
        let offset = 0;
        while (remaining > 0) {
          const segDur = Math.min(remaining, audio.duration / 1000);
          const fadeId = makeExtra(materials.audio_fades, 'audio_fades', {
            fade_in_duration: offset === 0 ? Math.min(300000, segDur * 1000) : 0,
            fade_out_duration: remaining - segDur <= 0 ? Math.min(300000, segDur * 1000) : 0,
          });
          const extraRefs = [
            makeExtra(materials.speeds, 'speeds', { speed: 1.0 }),
            makeExtra(materials.placeholder_infos, 'placeholder_infos'),
            fadeId,
            makeExtra(materials.beats, 'beats'),
            makeExtra(materials.sound_channel_mappings, 'sound_channel_mappings'),
            makeExtra(materials.vocal_separations, 'vocal_separations'),
          ];
          audioTrack.segments.push(
            makeAudioSegment(segProtos.audio, {
              materialId: audio.material.id,
              targetStart: Math.round((bgmStart + offset) * 1000),
              sourceStart: 0,
              duration: Math.round(segDur * 1000),
              extraRefs,
            }),
          );
          offset += segDur;
          remaining -= segDur;
          if (audio.duration <= 0) break;
        }
      }
    }
  }

  // Black fade transitions sit above every other visual layer.
  const blackMat = makeVideoMaterial(materials.videos, blackPath, { video: false });
  const blackLocal = registerMedia(blackPath, 'photo', { duration: 5000000, width: 1920, height: 1080 });
  blackMat.material.local_material_id = blackLocal;
  for (const tr of timeline.transitions || []) {
    if (tr.type !== 'black' || tr.durationMs <= 0) continue;
    const durUs = Math.round(tr.durationMs * 1000);
    const seg = makeVideoSegment(segProtos.video, {
      materialId: blackMat.material.id,
      targetStart: Math.round(tr.startMs * 1000),
      duration: durUs,
      renderIndex: 0,
      extraRefs: videoExtras(),
      commonKeyframes: alphaKeyframes(durUs),
    });
    transitionTrack.segments.push(seg);
  }

  // Sort segments and assign track_render_index.
  tracks.forEach((track, index) => {
    track.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    for (const seg of track.segments) seg.track_render_index = index;
  });

  skeleton.materials = materials;
  skeleton.tracks = tracks;
  skeleton.keyframes = { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] };
  skeleton.keyframe_graph_list = [];
  skeleton.relationships = [];
  skeleton.group_container = null;
  skeleton.cover = null;
  skeleton.retouch_cover = null;
  skeleton.static_cover_image_path = '';
  skeleton.extra_info = null;
  skeleton.mutable_config = null;
  skeleton.time_marks = null;
  skeleton.draft_type = '';
  skeleton.source = 'default';

  const contentFile = path.join(draftFolder, 'draft_content.json');
  const metaFile = path.join(draftFolder, 'draft_meta_info.json');
  const coverFile = path.join(draftFolder, 'draft_cover.jpg');

  const firstVisual = (() => {
    for (const g of timeline.groups) {
      const v = visuals[g.key];
      if (!v) continue;
      if (v.type === 'tst' && v.video) return projectAbs(v.video) || v.video;
      if (v.type === 'std' && v.backgrounds) {
        const first = Object.values(v.backgrounds)[0];
        if (first) return projectAbs(first) || first;
      }
    }
    return null;
  })();
  await makeCover(project, projectDir, firstVisual, coverFile);

  fs.writeFileSync(contentFile, JSON.stringify(skeleton, null, 1), 'utf8');

  const meta = clone(metaTemplate);
  const draftId = skeleton.id;
  meta.draft_id = draftId;
  meta.draft_name = skeleton.name;
  meta.draft_fold_path = toPosix(draftFolder);
  meta.draft_root_path = toPosix(draftRoot || path.dirname(draftFolder));
  meta.draft_json_file = toPosix(contentFile);
  meta.draft_cover = 'draft_cover.jpg';
  meta.draft_removable_storage_device = (draftRoot || draftFolder).slice(0, 2);
  meta.draft_duration = skeleton.duration;
  meta.tm_duration = skeleton.duration;
  meta.tm_draft_create = Date.now() * 1000;
  meta.tm_draft_modified = Date.now() * 1000;
  meta.draft_timeline_materials_size_ = mediaEntries.reduce((n, e) => n + (fs.existsSync(e.file_Path) ? fs.statSync(e.file_Path).size : 0), 0);
  meta.draft_timeline_materials_size = meta.draft_timeline_materials_size_;
  meta.draft_materials = [{ type: 0, value: mediaEntries }];
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1), 'utf8');

  fs.writeFileSync(
    path.join(draftFolder, 'draft_settings'),
    `[General]\r\ndraft_create_time=${nowSec()}\r\ndraft_last_edit_time=${nowSec()}\r\nreal_edit_seconds=0\r\nreal_edit_keys=0\r\ncloud_last_modify_platform=windows\r\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(draftFolder, 'draft_agency_config.json'), JSON.stringify({ is_auto_agency_enabled: false, is_auto_agency_popup: false, is_single_agency_mode: false, marterials: null, use_converter: false, video_resolution: 720 }), 'utf8');
  fs.writeFileSync(path.join(draftFolder, 'draft_biz_config.json'), JSON.stringify({ timeline_settings: {} }, null, 4), 'utf8');
  fs.writeFileSync(path.join(draftFolder, 'performance_opt_info.json'), JSON.stringify({ manual_cancle_precombine_segs: null, need_auto_precombine_segs: null }), 'utf8');
  fs.writeFileSync(path.join(draftFolder, 'draft_virtual_store.json'), JSON.stringify({ draft_materials: [], draft_virtual_store: [] }), 'utf8');

  return {
    draftFolder,
    contentFile,
    metaFile,
    coverFile,
    draftId,
    mediaCount: mediaEntries.length,
    trackCounts: tracks.map((t) => ({ type: t.type, name: t.name, segments: t.segments.length })),
    materialCount: Object.values(materials).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0),
    storedBytes: mediaEntries.reduce((n, e) => n + (fs.existsSync(e.file_Path) ? fs.statSync(e.file_Path).size : 0), 0),
  };
}

module.exports = { buildCapcutDraft };
