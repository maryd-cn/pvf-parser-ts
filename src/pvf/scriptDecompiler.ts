import { PvfFile } from './pvfFile';
import { StringView } from './stringView';
import { StringTable } from './stringTable';

function formatFloat(n: number): string {
  // keep two decimals consistent with ANI policy? Use trim trailing zeros if needed
  const s = n.toFixed(6);
  return s.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

export function decompileScript(model: any, f: PvfFile): string {
  const data = f.data!;
  const types: number[] = [];
  const values: number[] = [];
  for (let i = 2; i < f.dataLen - 4; i += 5) {
    const t = data[i];
    const v = (data[i + 1] | (data[i + 2] << 8) | (data[i + 3] << 16) | (data[i + 4] << 24)) >>> 0;
    if (t >= 2 && t <= 10) {
      types.push(t);
      values.push(v);
    }
  }
  const sb: string[] = [];
  sb.push('#PVF_File');

  const getStr = (idx: number) => model.getStringFromTable(idx) ?? `#${idx}`;
  const getStrLink = (id: number, nameIdx: number) => model.getStringView()?.get(id, getStr(nameIdx)) ?? '';
  let showSimplified = true;
  try {
    const cfg = require('vscode').workspace.getConfiguration();
    showSimplified = cfg.get('pvf.script.convertStringLink', true);
  } catch { /* ignore */ }

  // 仅把 type==5 视为章节，避免把普通字符串值(如 "[passive]")误判成章节。
  const isSection = (t: number, v: number): boolean => {
    if (t === 5) return true;
    return false;
  };

  const scratchView = new DataView(new ArrayBuffer(4));
  const toFloat32 = (v: number): number => {
    scratchView.setUint32(0, v, true);
    return scratchView.getFloat32(0, true);
  };

  const formatNumberToken = (t: number, v: number): string => {
    if (t === 4) {
      return formatFloat(toFloat32(v));
    }
    return String(v | 0);
  };

  let i = 0;
  let currentSection: string | null = null;
  let indentLevel = 0; // container depth only
  let firstSection = false;
  const containerSections = new Set<string>([
    '[dungeon]','[pvp]','[death tower]','[warroom]'
  ]);
  const sectionStack: string[] = []; // stack of container section names (lowercase)

  const floatForSection = (sec: string | null, n: number): string => {
    const s = toFloat32(n);
    if (sec === '[level property]') {
      // 保留整数浮点的 .0
      if (Number.isInteger(s)) return s.toFixed(1);
    }
    return formatFloat(s);
  };

  const emitLine = (content: string, extraIndent = 0) => {
    sb.push('\t'.repeat(indentLevel + extraIndent) + content);
  };

  while (i < types.length) {
    const t = types[i];
    const v = values[i];
    if (isSection(t, v)) {
      const name = getStr(v);
      const nameLower = name.toLowerCase();
      const closing = name.startsWith('[/');
      if (closing) {
        // map closing '[/xxx]' -> '[xxx]'
        const openName = '[' + nameLower.slice(2);
        if (sectionStack.length && sectionStack[sectionStack.length - 1] === openName) {
          // reduce indent BEFORE printing closing at same level as its opener
          indentLevel = Math.max(0, indentLevel - 1);
          sectionStack.pop();
        }
        if (!firstSection) { sb.push(''); firstSection = true; }
        else if (indentLevel === 0) { sb.push(''); }
        emitLine(name);
        // leaving a section: reset leaf section context
        currentSection = null;
        i++; continue;
      }
      // opening section
      if (!firstSection) { sb.push(''); firstSection = true; }
      else if (indentLevel === 0) { sb.push(''); }
      emitLine(name);
      currentSection = nameLower; // leaf context
      if (containerSections.has(nameLower)) {
        indentLevel++;
        sectionStack.push(nameLower);
      }
      i++; continue;
    }

    // 特殊 [command]：一条一个 token (6 / 8) 或常规字符串/链接
    if (currentSection === '[command]') {
      if (t === 6 || t === 8) {
        const strVal = getStr(v);
        if (strVal.startsWith('#')) {
          const signed = new DataView(new Uint32Array([v]).buffer).getInt32(0, true);
          emitLine('{' + t + '=' + signed + '}', 1);
        } else {
          emitLine('{' + t + '=`' + strVal + '`}', 1);
        }
        i++; continue;
      }
      if (t === 7) {
        emitLine('`' + getStr(v) + '`', 1); i++; continue;
      }
      if (t === 9 && i + 1 < types.length && types[i + 1] === 10) {
        const nameIdx = values[i + 1];
        const nameRaw = getStr(nameIdx);
        const val = getStrLink(v, nameIdx) || nameRaw;
        if (showSimplified) {
          emitLine('`' + val + '`', 1);
        } else {
          emitLine('<' + v + '::' + nameRaw + '`' + val + '`>', 1);
        }
        i += 2; continue;
      }
      // 其它数字：聚合一行
      const nums: string[] = [];
      while (i < types.length && !isSection(types[i], values[i])) {
        const itType = types[i];
        if (itType === 6 || itType === 7 || itType === 8 || itType === 9) break;
        nums.push(formatNumberToken(itType, values[i])); i++;
      }
      if (nums.length) emitLine(nums.join('\t'), 1);
      continue;
    }

    // string link 9+10
    if (t === 9 && i + 1 < types.length && types[i + 1] === 10) {
      const nameIdx = values[i + 1];
      const nameRaw = getStr(nameIdx);
      const val = getStrLink(v, nameIdx) || nameRaw;
      if (showSimplified) emitLine('`' + val + '`', 1);
      else emitLine('<' + v + '::' + nameRaw + '`' + val + '`>', 1);
      i += 2; continue;
    }
    // string 7 + 后续数字
    if (t === 7) {
      const strVal = getStr(v);
      let j = i + 1; const nums: string[] = [];
      while (j < types.length) {
        const jt = types[j];
        if (isSection(jt, values[j]) || jt === 7 || jt === 9) break;
        if (jt === 4) nums.push(floatForSection(currentSection, values[j])); else nums.push(formatNumberToken(jt, values[j]));
        j++;
      }
      if (nums.length) emitLine('`' + strVal + '`\t' + nums.join('\t'), 1);
      else emitLine('`' + strVal + '`', 1);
      i = j; continue;
    }
    // 纯数字行（聚合直到控制 token）
    const line: string[] = [];
    while (i < types.length) {
      const kt = types[i]; const kv = values[i];
      if (isSection(kt, kv) || kt === 7 || kt === 9) break;
      if (kt === 4) line.push(floatForSection(currentSection, kv)); else line.push(formatNumberToken(kt, kv));
      i++;
    }
    if (line.length) emitLine(line.join('\t'), 1);
  }
  return sb.join('\n');
}
