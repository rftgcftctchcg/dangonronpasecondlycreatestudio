'use strict';

const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const FONT_FAMILY = 'VNText';
let fontReady = false;
let scratch = null;

function getScratch() {
  if (!scratch) scratch = createCanvas(1920, 1080).getContext('2d');
  return scratch;
}

function ensureFont(fontPath) {
  if (fontReady) return FONT_FAMILY;
  try {
    if (fontPath) GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
  } catch (e) {
    // Fall through to a Windows font.
  }
  if (!GlobalFonts.families.some((f) => f.family === FONT_FAMILY)) {
    for (const fallback of [
      'C:/Windows/Fonts/Deng.ttf',
      'C:/Windows/Fonts/simhei.ttf',
    ]) {
      try {
        GlobalFonts.registerFromPath(fallback, FONT_FAMILY);
        break;
      } catch (e) {
        /* ignore */
      }
    }
  }
  fontReady = true;
  return FONT_FAMILY;
}

function fontSpec(size, weight = 'normal') {
  return `${weight === 'bold' ? 'bold ' : ''}${size}px ${FONT_FAMILY}`;
}

function measure(text, font) {
  const ctx = getScratch();
  ctx.font = font;
  return ctx.measureText(text).width;
}

function wrapText(text, font, maxWidth) {
  const ctx = getScratch();
  ctx.font = font;
  const out = [];
  const paragraphs = String(text).split(/\r?\n/);
  for (const para of paragraphs) {
    if (!para) {
      out.push('');
      continue;
    }
    let line = '';
    for (const ch of Array.from(para)) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxWidth) {
        out.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

const PUNCT = /[。！？!?…，,、；;：:）)】」』".]/;

function splitPages(lines, maxLines) {
  if (lines.length <= maxLines) return [lines.slice()];
  const pages = [];
  let cur = [];
  for (const line of lines) {
    if (cur.length >= maxLines) {
      pages.push(cur);
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) pages.push(cur);
  return pages;
}

/**
 * Paginate dialogue for the 1740px-wide text area.
 * Explicit newlines are honoured; long paragraphs are wrapped.
 */
function paginateText(text, options = {}) {
  const ctx = getScratch();
  const font = options.font || fontSpec(options.fontSize || 44);
  const maxWidth = options.maxWidth || 1740;
  const maxLines = options.maxLines || 3;
  ctx.font = font;
  const lines = [];
  for (const para of String(text).split(/\r?\n/)) {
    if (!para) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      continue;
    }
    let line = '';
    for (const ch of Array.from(para)) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxWidth) {
        // Prefer breaking after punctuation for a nicer VN look.
        if (PUNCT.test(line.slice(-1)) || PUNCT.test(ch)) {
          lines.push(line);
          line = ch;
        } else {
          lines.push(line);
          line = ch;
        }
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  // Drop leading/trailing empty lines.
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return [''];
  return splitPages(lines, maxLines).map((p) => p.join('\n'));
}

function charCount(text) {
  return Array.from(String(text).replace(/\s/g, '')).length;
}

function punctuationCount(text) {
  return (String(text).match(/[。！？!?…，,、；;]/g) || []).length;
}

/**
 * Reading-time model tuned for visual-novel dialogue.
 *
 * 20 Chinese characters + 1-2 punctuation marks ≈ 3.0s. The old model
 * (0.18s/char + 0.8s base) produced 4.4s for the same line, which felt slow.
 */
function defaultDuration(text, speed = 0.13, min = 1.2, max = 10) {
  const c = charCount(text);
  const p = punctuationCount(text);
  const sec = 0.35 + c * speed + p * 0.06;
  return Math.max(min, Math.min(max, Math.round(sec * 1000) / 1000));
}

module.exports = {
  FONT_FAMILY,
  ensureFont,
  fontSpec,
  measure,
  wrapText,
  paginateText,
  defaultDuration,
  charCount,
};
