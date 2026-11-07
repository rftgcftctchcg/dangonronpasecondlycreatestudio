'use strict';

/**
 * Script parser for the visual-novel script format.
 *
 * Format (labels before ':' are arbitrary):
 *   [组 1:begin][STD]
 *   [分镜 1:begin]
 *   足立零：台词
 *   [分镜 1:end]
 *   [组 1:end]
 *
 * A group starts at top level; a shot starts inside a group.
 * The parser is deliberately tolerant: it records errors/warnings and
 * still returns the best-effort tree so the UI can show a preview.
 */

const BLOCK_RE = /^(.*?)\s*:\s*(begin|end)\s*$/i;

function parseScript(text, options = {}) {
  const rawText = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const lines = rawText.split(/\r\n|\r|\n/);
  const errors = [];
  const warnings = [];
  const groups = [];

  let group = null;
  let shot = null;
  let pendingType = null;
  let groupSeq = 0;
  let shotSeq = 0;

  const err = (line, message) => errors.push({ line, message, raw: lines[line - 1] || '' });
  const warn = (line, message) => warnings.push({ line, message, raw: lines[line - 1] || '' });

  function startGroup(label, line) {
    groupSeq += 1;
    group = {
      key: `g${groupSeq}`,
      index: groupSeq,
      label: label || `组 ${groupSeq}`,
      type: pendingType || 'STD',
      typeExplicit: !!pendingType,
      line,
      shots: [],
    };
    pendingType = null;
    shot = null;
    shotSeq = 0;
    groups.push(group);
  }

  function endGroup(line) {
    if (!group) {
      err(line, '遇到组结束标记，但没有已打开的组');
      return;
    }
    if (shot) {
      err(line, `组「${group.label}」结束前分镜「${shot.label}」未闭合，已自动闭合`);
      shot = null;
    }
    if (!group.shots.length) {
      warn(line, `组「${group.label}」没有任何分镜`);
    }
    group = null;
    pendingType = null;
  }

  function startShot(label, line) {
    if (!group) {
      err(line, '分镜开始标记出现在组外，已忽略');
      return;
    }
    if (shot) {
      err(line, `分镜「${shot.label}」尚未结束，又开始了新分镜「${label}」`);
      return;
    }
    shotSeq += 1;
    shot = {
      key: `${group.key}s${shotSeq}`,
      index: shotSeq,
      label: label || `分镜 ${shotSeq}`,
      line,
      lines: [],
    };
    group.shots.push(shot);
  }

  function endShot(line) {
    if (!shot) {
      err(line, '遇到分镜结束标记，但没有已打开的分镜');
      return;
    }
    if (!shot.lines.length) {
      warn(line, `分镜「${shot.label}」没有台词`);
    }
    shot = null;
  }

  function endBlock(label, line) {
    if (!shot) {
      endGroup(line);
      return;
    }
    const groupLabel = group ? group.label : '';
    const closeGroupToo = group && (label === groupLabel) && (label !== shot.label || shot.label === '隐式分镜');
    endShot(line);
    if (closeGroupToo) endGroup(line);
  }

  function addLine(lineNo, rawLine) {
    const text = rawLine.trim();
    if (!text) return;

    // Find the first full-width or half-width colon. A colon inside the
    // dialogue is preserved.
    let idx = text.indexOf('：');
    if (idx < 0) idx = text.indexOf(':');
    let speaker = '';
    let content = text;
    if (idx >= 0) {
      speaker = text.slice(0, idx).trim();
      content = text.slice(idx + 1).trim();
    }
    if (!content) {
      warn(lineNo, '空台词已忽略');
      return;
    }
    if (!shot) {
      if (!group) {
        err(lineNo, '台词出现在任何组之外，已忽略');
        return;
      }
      warn(lineNo, `组「${group.label}」中的台词不在分镜内，已创建隐式分镜`);
      startShot('隐式分镜', lineNo);
    }
    shot.lines.push({
      key: `${shot.key}l${shot.lines.length + 1}`,
      index: shot.lines.length + 1,
      speaker,
      text: content,
      line: lineNo,
      raw: rawLine,
    });
  }

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    // Extract all bracket tokens on the line.
    const tokens = [];
    const re = /\[([^\]]*)\]/g;
    let m;
    while ((m = re.exec(trimmed)) !== null) tokens.push({ token: m[1].trim(), start: m.index, end: re.lastIndex });

    // A line is a pure tag line only when the non-bracket remainder is blank.
    let remainder = trimmed;
    for (let j = tokens.length - 1; j >= 0; j -= 1) {
      const t = tokens[j];
      remainder = remainder.slice(0, t.start) + remainder.slice(t.end);
    }
    const isPureTagLine = tokens.length > 0 && remainder.trim() === '';

    if (!isPureTagLine) {
      // Dialogue line. Strip a leading type tag if someone wrote `[STD]台词`.
      addLine(lineNo, trimmed);
      continue;
    }

    for (const t of tokens) {
      const block = t.token.match(BLOCK_RE);
      if (block) {
        const label = block[1].trim();
        const kind = block[2].toLowerCase();
        if (kind === 'begin') {
          if (!group) startGroup(label, lineNo);
          else startShot(label, lineNo);
        } else {
          endBlock(label, lineNo);
        }
        continue;
      }
      const upper = t.token.toUpperCase();
      if (upper === 'STD' || upper === 'TST') {
        if (!group) {
          err(lineNo, `类型标记 [${upper}] 出现在组外，已忽略`);
        } else if (shot || group.shots.length > 0) {
          err(lineNo, `类型标记 [${upper}] 必须紧跟组开始，不能出现在分镜内容之后`);
        } else if (pendingType) {
          err(lineNo, `组「${group.label}」重复指定类型标记`);
        } else {
          group.type = upper;
          group.typeExplicit = true;
          pendingType = upper;
        }
        continue;
      }
      err(lineNo, `无法识别的标签 [${t.token}]`);
    }
  }

  if (shot) {
    err(lines.length, `文件结束时仍有关闭的分镜「${shot.label}」未闭合`);
  }
  if (group) {
    err(lines.length, `文件结束时仍有组「${group.label}」未闭合`);
  }

  // Ensure every group has a type and at least one shot.
  for (const g of groups) {
    if (!g.typeExplicit) {
      g.type = g.type || 'STD';
      errors.push({ line: g.line, message: `组「${g.label}」缺少 [STD] 或 [TST] 类型标记，暂按 STD 处理`, raw: lines[g.line - 1] || '' });
    }
    if (!g.shots.length) {
      warnings.push({ line: g.line, message: `组「${g.label}」没有分镜`, raw: '' });
    }
  }

  return {
    groups,
    errors,
    warnings,
    stats: {
      groups: groups.length,
      shots: groups.reduce((n, g) => n + g.shots.length, 0),
      lines: groups.reduce((n, g) => n + g.shots.reduce((m2, s) => m2 + s.lines.length, 0), 0),
    },
  };
}

module.exports = { parseScript };
