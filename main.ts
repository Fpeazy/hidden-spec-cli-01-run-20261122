// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/* ---------- SPEC.md section 5: files and line matching ---------- */

interface FileModel {
  lines: string[];
  br: '\n' | '\r\n';
  finalBreak: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O matches lines at the tier (occurrences may overlap). */
function occurrences(o: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** Positions where O matches lines at the tier, at or after `from`. */
function occurrencesFrom(o: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; strict: only 0) with at least one occurrence. */
function findOccurrences(o: string[], lines: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(o, lines, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** First line at or after the cursor equal to the anchor, at the first tier with one. */
function findAnchor(anchor: string, lines: string[], cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = cursor; k < lines.length; k++) {
      if (normLine(lines[k]!, t) === normLine(anchor, t)) return k;
    }
  }
  return null;
}

/**
 * Build the lines that replace the matched lines at pos.
 * nCtx[k] is the index into O of N[k] when N[k] is a context line, else null.
 * Context lines are written as the file's own matched lines; at tier 2 other N lines
 * are re-indented (leading P of O's first line replaced by leading F of the file's
 * first matched line).
 */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: string[], nCtx: (number | null)[], tier: number): string[] {
  const out: string[] = [];
  const f = fileLines[pos] === undefined ? '' : leadingWs(fileLines[pos]!);
  const p = o.length === 0 ? '' : leadingWs(o[0]!);
  for (let k = 0; k < n.length; k++) {
    const oi = nCtx[k];
    if (oi !== null && oi !== undefined) {
      out.push(fileLines[pos + oi]!);
    } else if (tier === 2) {
      const l = n[k]!;
      if (l !== '' && l.trim() !== '' && l.startsWith(p)) out.push(f + l.slice(p.length));
      else out.push(l);
    } else {
      out.push(n[k]!);
    }
  }
  return out;
}

type BodyKind = 'ctx' | 'old' | 'new' | 'backslash';
interface BodyLine { kind: BodyKind; text: string; }

interface ParsedBody {
  o: string[];
  n: string[];
  nCtx: (number | null)[];
  /** A `\` line follows the last ctx or new body line. */
  backslashAfterLast: boolean;
  /** A `\` line follows the last new body line. */
  backslashAfterLastNew: boolean;
}

function parseBody(body: BodyLine[]): ParsedBody {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  let lastContent = -1;
  let lastNew = -1;
  for (let idx = 0; idx < body.length; idx++) {
    const b = body[idx]!;
    if (b.kind === 'ctx') { nCtx.push(o.length); o.push(b.text); n.push(b.text); lastContent = idx; }
    else if (b.kind === 'old') { o.push(b.text); }
    else if (b.kind === 'new') { n.push(b.text); nCtx.push(null); lastContent = idx; lastNew = idx; }
  }
  const backslashAfterLast = lastContent >= 0 && body[lastContent + 1] !== undefined && body[lastContent + 1]!.kind === 'backslash';
  const backslashAfterLastNew = lastNew >= 0 && body[lastNew + 1] !== undefined && body[lastNew + 1]!.kind === 'backslash';
  return { o, n, nCtx, backslashAfterLast, backslashAfterLastNew };
}

/* ---------- SPEC.md section 7: SEARCH/REPLACE blocks ---------- */

interface SearchBlock { path: string; oldLines: string[]; newLines: string[]; }

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchBlock[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let eq = -1;
      for (let j = s + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') { eq = j; break; }
        if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '>>>>>>> REPLACE') { rep = j; break; }
        if (t === '<<<<<<< SEARCH') break;
      }
      if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
      let path: string | null = null;
      for (let j = s - 1; j > prevReplaceEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
        path = prevPath;
      }
      blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevReplaceEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = splitFile(before);
    const found = findOccurrences(b.oldLines, model.lines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const nOut = buildReplacement(model.lines, found.pos[0]!, b.oldLines, b.newLines, b.newLines.map(() => null), found.tier);
    model.lines.splice(found.pos[0]!, b.oldLines.length, ...nOut);
    tree.now.set(b.path, joinFile(model));
  });
}

/* ---------- SPEC.md section 6: unified diffs ---------- */

interface Hunk { a: number; body: BodyLine[]; parsed: ParsedBody; }

interface UnifiedSection {
  kind: 'create' | 'delete' | 'move' | 'change';
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  return s.trim();
}

function parseHunkHeader(line: string, i: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  return parseInt(m[1]!, 10);
}

function parseHunkBody(lines: string[], start: number): { lines: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '') { body.push({ kind: 'ctx', text: '' }); i++; continue; }
    const c = line[0]!;
    if (c === ' ') { body.push({ kind: 'ctx', text: line.slice(1) }); i++; continue; }
    if (c === '-') { body.push({ kind: 'old', text: line.slice(1) }); i++; continue; }
    if (c === '+') { body.push({ kind: 'new', text: line.slice(1) }); i++; continue; }
    if (c === '\\') { body.push({ kind: 'backslash', text: line }); i++; continue; }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  return { lines: body, next: i };
}

function applyUnifiedHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n, nCtx } = h.parsed;
    if (o.length === 0) {
      const idx = Math.min(h.a + d, model.lines.length);
      const touchesEnd = idx === model.lines.length;
      model.lines.splice(idx, 0, ...n);
      if (touchesEnd) model.finalBreak = !h.parsed.backslashAfterLast;
      d += n.length - o.length;
    } else {
      const found = findOccurrences(o, model.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const touchesEnd = best + o.length === model.lines.length;
      const nOut = buildReplacement(model.lines, best, o, n, nCtx, found.tier);
      model.lines.splice(best, o.length, ...nOut);
      if (touchesEnd) model.finalBreak = !h.parsed.backslashAfterLast;
      d += n.length - o.length;
    }
  }
}

function unifiedSectionEdit(sec: UnifiedSection, strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    if (sec.kind === 'create') {
      const p = sec.newPath;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const outLines: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') outLines.push(b.text);
      let finalBreak = false;
      if (outLines.length > 0) {
        finalBreak = true;
        for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const h = sec.hunks[hi]!;
          if (h.body.some((b) => b.kind === 'new')) { finalBreak = !h.parsed.backslashAfterLastNew; break; }
        }
      }
      tree.now.set(p, outLines.length === 0 ? '' : outLines.join('\n') + (finalBreak ? '\n' : ''));
    } else if (sec.kind === 'delete') {
      const p = sec.oldPath;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    } else if (sec.kind === 'move') {
      const oldP = sec.oldPath;
      const newP = sec.newPath;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const model = splitFile(before);
      applyUnifiedHunks(model, sec.hunks, strict, oldP);
      tree.now.set(newP, joinFile(model));
      tree.now.set(oldP, null);
      moves.push([oldP, newP]);
    } else {
      const p = sec.oldPath;
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = splitFile(before);
      applyUnifiedHunks(model, sec.hunks, strict, p);
      tree.now.set(p, joinFile(model));
    }
  };
}

function parseUnifiedSection(lines: string[], start: number, gitOld: string | null, gitNew: string | null, startedByPair: boolean, strict: boolean, moves: Array<[string, string]>, edits: Edit[]): number {
  let dashOld: string | null = null;
  let plusNew: string | null = null;
  let newFile = false;
  let delFile = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  const hunks: Hunk[] = [];
  const n = lines.length;
  let i: number;
  if (startedByPair) {
    dashOld = headerPath(lines[start]!);
    plusNew = headerPath(lines[start + 1]!);
    i = start + 2;
  } else {
    i = start + 1;
  }
  let inHeader = true;
  while (i < n) {
    const line = lines[i]!;
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          dashOld = headerPath(line);
          plusNew = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) { plusNew = headerPath(line); i++; continue; }
      if (line.startsWith('rename from ')) { renameFrom = line.slice('rename from '.length).trim(); i++; continue; }
      if (line.startsWith('rename to ')) { renameTo = line.slice('rename to '.length).trim(); i++; continue; }
      if (line.startsWith('new file mode')) { newFile = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { delFile = true; i++; continue; }
      if (line.startsWith('diff --git ')) break;
      if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i);
        inHeader = false;
        i++;
        const body = parseHunkBody(lines, i);
        i = body.next;
        hunks.push({ a, body: body.lines, parsed: parseBody(body.lines) });
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line.startsWith('@@')) {
      const a = parseHunkHeader(line, i);
      i++;
      const body = parseHunkBody(lines, i);
      i = body.next;
      hunks.push({ a, body: body.lines, parsed: parseBody(body.lines) });
      continue;
    }
    i++;
  }
  const oldP = dashOld !== null ? (dashOld === '/dev/null' ? null : stripAB(dashOld)) : (renameFrom !== null ? renameFrom : gitOld);
  const newP = plusNew !== null ? (plusNew === '/dev/null' ? null : stripAB(plusNew)) : (renameTo !== null ? renameTo : gitNew);
  let kind: 'create' | 'delete' | 'move' | 'change';
  if (oldP === null || newFile) kind = 'create';
  else if (newP === null || delFile) kind = 'delete';
  else if (oldP !== newP) kind = 'move';
  else kind = 'change';
  const sec: UnifiedSection = { kind, oldPath: oldP === null ? '' : oldP, newPath: newP === null ? '' : newP, hunks };
  edits.push(unifiedSectionEdit(sec, strict, moves));
  return i;
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      i = parseUnifiedSection(lines, i, m[1]!, m[2]!, false, strict, moves, edits);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      i = parseUnifiedSection(lines, i, null, null, true, strict, moves, edits);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return edits;
}

/* ---------- SPEC.md section 8: V4A patches ---------- */

interface V4AChunk { anchor: string | null; body: BodyLine[]; parsed: ParsedBody; eof: boolean; }

function v4aBodyLine(l: string): BodyLine {
  if (l === '') return { kind: 'ctx', text: '' };
  const c = l[0]!;
  if (c === ' ') return { kind: 'ctx', text: l.slice(1) };
  if (c === '-') return { kind: 'old', text: l.slice(1) };
  return { kind: 'new', text: l.slice(1) };
}

function applyV4AChunks(model: FileModel, chunks: V4AChunk[], strict: boolean, path: string): void {
  const tiers = strict ? [0] : [0, 1, 2];
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const at = findAnchor(c.anchor, model.lines, cursor, strict);
      if (at === null) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const { o, n, nCtx } = c.parsed;
    if (o.length === 0) {
      const idx = c.eof ? model.lines.length : cursor;
      model.lines.splice(idx, 0, ...n);
      cursor = idx + n.length;
    } else {
      let found: { tier: number; pos: number } | null = null;
      for (const t of tiers) {
        const occ = occurrencesFrom(o, model.lines, t, cursor);
        if (occ.length === 0) continue;
        if (c.eof) {
          const p = occ.find((x) => x + o.length === model.lines.length);
          if (p !== undefined) { found = { tier: t, pos: p }; break; }
          continue;
        }
        found = { tier: t, pos: occ[0]! };
        break;
      }
      if (found === null) throw new Fail('no-match', path);
      const nOut = buildReplacement(model.lines, found.pos, o, n, nCtx, found.tier);
      model.lines.splice(found.pos, o.length, ...nOut);
      cursor = found.pos + nOut.length;
    }
  }
}

function v4aAddEdit(path: string, body: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, body.length === 0 ? '' : body.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const model = splitFile(before);
    applyV4AChunks(model, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(moveTo, joinFile(model));
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, joinFile(model));
    }
  };
}

function parseV4AUpdate(lines: string[], start: number, last: number, strict: boolean, moves: Array<[string, string]>, edits: Edit[]): number {
  const path = lines[start]!.slice('*** Update File: '.length).trim();
  let moveTo: string | null = null;
  const chunks: V4AChunk[] = [];
  let j = start + 1;
  if (j < last && lines[j]!.startsWith('*** Move to: ')) {
    moveTo = lines[j]!.slice('*** Move to: '.length).trim();
    j++;
  }
  let current: V4AChunk | null = null;
  while (j < last) {
    const l = lines[j]!;
    if (l.startsWith('*** ')) {
      if (l === '*** End of File') {
        if (!current) throw new Exit2(`error: parse ${j + 1}`);
        current.eof = true;
        current = null;
        j++;
        continue;
      }
      break;
    }
    if (l.startsWith('@@')) {
      const anchorText = l.slice(2).trim();
      current = { anchor: anchorText === '' ? null : anchorText, body: [], parsed: { o: [], n: [], nCtx: [], backslashAfterLast: false, backslashAfterLastNew: false }, eof: false };
      chunks.push(current);
      j++;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (!current) {
        if (chunks.length === 0) {
          current = { anchor: null, body: [], parsed: { o: [], n: [], nCtx: [], backslashAfterLast: false, backslashAfterLastNew: false }, eof: false };
          chunks.push(current);
        } else if (blank(l)) {
          j++;
          continue;
        } else {
          throw new Exit2(`error: parse ${j + 1}`);
        }
      }
      current.body.push(v4aBodyLine(l));
      j++;
      continue;
    }
    throw new Exit2(`error: parse ${j + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${start + 1}`);
  // Blank lines at the end of a section are not part of it: drop trailing empty
  // context lines from the last chunk when it is still open.
  if (current !== null && chunks.length > 0) {
    const lastChunk = chunks[chunks.length - 1]!;
    while (lastChunk.body.length > 0) {
      const b = lastChunk.body[lastChunk.body.length - 1]!;
      if (b.kind === 'ctx' && b.text === '') lastChunk.body.pop();
      else break;
    }
  }
  for (const c of chunks) c.parsed = parseBody(c.body);
  edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
  return j;
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) { if (!blank(lines[k]!)) { last = k; break; } }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const body: string[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (l.startsWith('*** ')) break;
        if (l.startsWith('+')) body.push(l.slice(1));
        else if (l === '') body.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push(v4aAddEdit(path, body));
      i = j;
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (blank(l)) { j++; continue; }
        if (l.startsWith('*** ')) break;
        throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      edits.push(v4aDeleteEdit(path));
      i = j;
    } else if (line.startsWith('*** Update File: ')) {
      i = parseV4AUpdate(lines, i, last, strict, moves, edits);
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}


/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict, moves)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const outRows: { key: string; line: string }[] = [];
  const rOlds = new Set<string>();
  const rNews = new Set<string>();
  for (const [oldP, newP] of moves) {
    const oldWas = tree.original(oldP);
    const oldNow = tree.now.get(oldP);
    const newWas = tree.original(newP);
    const newNow = tree.now.get(newP);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null && newNow !== undefined) {
      outRows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      rOlds.add(oldP);
      rNews.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (rOlds.has(p) || rNews.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    outRows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  outRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows = outRows.map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
