import { PvfModel } from './model';

interface SourceLine {
  text: string;
  eol: string;
}

function splitLinesPreserveEol(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\r' || ch === '\n' || ch === '\u2028' || ch === '\u2029') {
      let eol = ch;
      if (ch === '\r' && text[i + 1] === '\n') {
        eol = '\r\n';
        i++;
      }
      lines.push({ text: text.slice(start, i + 1 - eol.length), eol });
      start = i + 1;
    }
  }
  lines.push({ text: text.slice(start), eol: '' });
  return lines;
}

export class ScriptCompiler {
  constructor(private model: PvfModel) { }
  compile(scriptText: string): Buffer | null {
    try {
      // String link auto-conversion setting:
      // pvf.script.convertStringLink = true  =>  <id::name`text`>  ->  `text`
      // false => keep link form but blank out embedded text so compile uses id+name only (legacy behavior)
      try {
        // lazy require to avoid circular activation issues
        const cfg = require('vscode').workspace.getConfiguration();
  const auto = cfg.get('pvf.script.convertStringLink', true as boolean);
        if (auto) {
          scriptText = scriptText.replace(/<\d+::[^`<>]*`([^`]*?)`>/g, '`$1`');
        } else {
          scriptText = scriptText.replace(/<(\d+::.+?)`.+?`>/g, '<$1``>');
        }
      } catch { /* ignore config errors */ }
      const out: number[] = [0xB0, 0xD0];
      const lines = splitLinesPreserveEol(scriptText);
      let i = 0;
      while (i < lines.length) {
        let line = lines[i].text;
        const trimmed = line.trim();
        if (!trimmed || /^#pvf_file(_add)?$/i.test(trimmed)) { i++; continue; }
        // 逐字符扫描，支持多行反引号串与制表分隔 token
        let pos = 0;
        const len = line.length;
        const emitToken = (token: string) => {
          if (!token) return;
          const items = this.compileItem(token);
            for (const [t, v] of items) {
            out.push(t & 0xFF);
            out.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF);
          }
        };
        while (true) {
          // 跳过制表/前导空白（空白不作为分隔符只认制表；但前导空白在 token 中意义不大这里忽略）
          while (pos < line.length && line[pos] === '\t') pos++;
          if (pos >= line.length) break;
          if (line[pos] === '`') {
            // 多行字符串
            let token = '`';
            pos++;
            let closed = false;
            let curLine = line;
            let curLineIndex = i;
            while (true) {
              while (pos < curLine.length) {
                const ch = curLine[pos++];
                token += ch;
                if (ch === '`') { closed = true; break; }
              }
              if (closed) break;
              // 下一行继续。反引号内的换行属于字符串内容，必须按原文保留。
              const eol = lines[curLineIndex].eol;
              if (!eol) break; // 非正常闭合，直接退出
              token += eol;
              curLineIndex++;
              i = curLineIndex;
              if (i >= lines.length) break;
              curLine = lines[i].text;
              pos = 0;
            }
            // 如果闭合所在行还有剩余，继续在同一逻辑里处理余下部分
            line = curLine; // 确保 line 指向包含闭合的行，继续扫描后续 token
            emitToken(token);
            continue;
          }
          // 普通 token：直到 \t 或 行终止
          let start = pos;
          while (pos < line.length && line[pos] !== '\t') pos++;
          const raw = line.slice(start, pos).trim();
          if (raw) emitToken(raw);
        }
        i++;
      }
      return Buffer.from(out);
    } catch {
      return null;
    }
  }
  private compileItem(item: string): Array<[number, number]> {
    const res: Array<[number, number]> = [];
    const st = (this.model as any)['strtable'] as any;
    const getIdx = (s: string) => st ? (st.getIndex(s) >= 0 ? st.getIndex(s) : st.add(s)) : 0;
    const trim = (s: string) => s.trim();
    if (!item) return res;
    if (item.startsWith('[') && item.endsWith(']')) {
      const idx = getIdx(item);
      res.push([5, idx >>> 0]);
      return res;
    }
    if (item.startsWith('<') && item.endsWith('>')) {
      const inner = item.slice(1, -1);
      const idxDbl = inner.indexOf('::');
      if (idxDbl > 0) {
        const idStr = inner.slice(0, idxDbl);
        const namePart = inner.slice(idxDbl + 2);
        const name = namePart.split('`')[0];
        const id = parseInt(trim(idStr), 10) >>> 0;
        res.push([9, id]);
        const nameIdx = getIdx(name);
        res.push([10, nameIdx >>> 0]);
        return res;
      }
    }
    if (item.startsWith('`') && item.endsWith('`')) {
      const s = item.slice(1, -1);
      const idx = getIdx(s);
      res.push([7, idx >>> 0]);
      return res;
    }
    if (item.startsWith('{') && item.endsWith('}')) {
      const body = item.slice(1, -1);
      const eq = body.indexOf('=');
      const tStr = eq >= 0 ? body.slice(0, eq) : body;
      const vStr = eq >= 0 ? body.slice(eq + 1) : '';
      const t = Math.max(0, Math.min(255, parseInt(trim(tStr), 10) | 0));
      if (t === 0) return res;
      if (vStr.startsWith('`') && vStr.endsWith('`')) {
        const s = vStr.slice(1, -1);
        const idx = getIdx(s);
        res.push([t, idx >>> 0]);
      } else {
        if (vStr.indexOf('.') >= 0) {
          const f = parseFloat(vStr);
          const buf = Buffer.allocUnsafe(4); buf.writeFloatLE(isFinite(f) ? f : 0, 0);
          const val = buf.readUInt32LE(0);
          res.push([t, val >>> 0]);
        } else {
          const n = parseInt(vStr, 10) | 0;
          res.push([t, n >>> 0]);
        }
      }
      return res;
    }
    if (item.indexOf('.') >= 0) {
      const f = parseFloat(item);
      const buf = Buffer.allocUnsafe(4); buf.writeFloatLE(isFinite(f) ? f : 0, 0);
      res.push([4, buf.readUInt32LE(0) >>> 0]);
      return res;
    }
    {
      const n = parseInt(item, 10);
      if (!isNaN(n)) { res.push([2, (n | 0) >>> 0]); return res; }
    }
    return res;
  }
}
