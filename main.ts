// mend: one patch tool for every AI edit format.
// Reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form and applies
// it to the tree of text files in the working directory, atomically:
// every file changes or none does. See SPEC.md in the competition kit.
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super("parse " + line);
    this.line = line;
  }
}

function out(text: string): void {
  process.stdout.write(text);
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

function stripTrailingWS(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

function isSafePath(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  const segs = p.split("/");
  for (const seg of segs) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// File model (SPEC section 3)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string; // "\n" or "\r\n"
  finalBreak: boolean;
}

function parseFileText(text: string): FileState {
  if (text === "") return { lines: [], br: "\n", finalBreak: false };
  const idx = text.indexOf("\n");
  let br = "\n";
  if (idx > 0 && text[idx - 1] === "\r") br = "\r\n";
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    finalBreak = true;
    parts.pop();
  }
  return { lines: parts, br, finalBreak };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return "";
  return f.lines.join(f.br) + (f.finalBreak ? f.br : "");
}

function cloneFile(f: FileState): FileState {
  return { lines: f.lines.slice(), br: f.br, finalBreak: f.finalBreak };
}

// A patch's lines: split at \n, one trailing \r removed per line, and without
// the empty piece after a final \n.
function splitPatchLines(text: string): string[] {
  const parts = text.split("\n");
  const lines = parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

// new_str lines for JSON insert (SPEC section 9).
function splitNewStr(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (s.endsWith("\n")) parts.pop();
  return parts;
}

// ---------------------------------------------------------------------------
// Tier matching (SPEC section 5)
// ---------------------------------------------------------------------------

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return stripTrailingWS(s);
  return stripTrailingWS(s.replace(/^[ \t]+/, ""));
}

function findOccurrences(
  lines: string[],
  oldLines: string[],
  tier: number,
  from: number,
): number[] {
  const res: number[] = [];
  const want = oldLines.map((l) => normLine(l, tier));
  const n = oldLines.length;
  for (let i = from; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normLine(lines[i + j], tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

// First tier (of the given tier list) at which O occurs at least once at or
// after `from`, with all its occurrences there.
function findTier(
  lines: string[],
  oldLines: string[],
  tiers: number[],
  from: number,
): { tier: number; occ: number[] } | null {
  for (const t of tiers) {
    const occ = findOccurrences(lines, oldLines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// Tier at which a single line matches at a fixed position, or null.
function matchTierAt(
  lines: string[],
  oldLines: string[],
  pos: number,
  tiers: number[],
): number | null {
  for (const t of tiers) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normLine(lines[pos + j], t) !== normLine(oldLines[j], t)) {
        ok = false;
        break;
      }
    }
    if (ok) return t;
  }
  return null;
}

// Re-indent one new line at tier 2 (SPEC section 5).
function reindent(line: string, pfx: string, repl: string): string {
  if (line === "" || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(pfx)) return repl + line.slice(pfx.length);
  return line;
}

interface OItem {
  kind: "ctx" | "del";
  text: string;
}
interface NItem {
  kind: "ctx" | "add";
  text: string;
  oIndex: number; // index in O of the context line this mirrors, -1 for adds
}

// Replace O at position pos with N. Context lines are written as the file's
// own matched lines; other new lines are re-indented at tier 2.
function applyReplace(
  f: FileState,
  pos: number,
  o: OItem[],
  n: NItem[],
  tier: number,
): void {
  let pfx = "";
  let repl = "";
  if (tier === 2) {
    pfx = leadingWS(o[0].text);
    repl = leadingWS(f.lines[pos]);
  }
  const rep: string[] = n.map((item) => {
    if (item.kind === "ctx") return f.lines[pos + item.oIndex];
    return tier === 2 ? reindent(item.text, pfx, repl) : item.text;
  });
  f.lines.splice(pos, o.length, ...rep);
}

// ---------------------------------------------------------------------------
// Argument parsing (SPEC section 1)
// ---------------------------------------------------------------------------

interface Args {
  error: boolean;
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

const FORMAT_NAMES = ["unified", "search-replace", "v4a", "json", "auto"];

function parseArgs(argv: string[]): Args {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let positional: string | null = null;
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === "--") {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith("-") && a !== "-") {
      if (a === "--check") {
        if (seenCheck) return { error: true, format: "auto", check, strict, patch: null };
        seenCheck = true;
        check = true;
      } else if (a === "--strict") {
        if (seenStrict) return { error: true, format: "auto", check, strict, patch: null };
        seenStrict = true;
        strict = true;
      } else if (a.startsWith("--format=")) {
        if (seenFormat) return { error: true, format: "auto", check, strict, patch: null };
        seenFormat = true;
        const v = a.slice("--format=".length);
        if (FORMAT_NAMES.indexOf(v) === -1) {
          return { error: true, format: "auto", check, strict, patch: null };
        }
        format = v;
      } else {
        return { error: true, format: "auto", check, strict, patch: null };
      }
    } else {
      if (positional !== null) {
        return { error: true, format: "auto", check, strict, patch: null };
      }
      positional = a;
    }
  }
  return { error: false, format: format === null ? "auto" : format, check, strict, patch: positional };
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  const firstLine = lines[first];
  if (firstLine.trim() === "*** Begin Patch") return "v4a";
  const c = firstLine.trimStart()[0];
  if (c === "[" || c === "{") return "json";
  for (const l of lines) {
    if (stripTrailingWS(l) === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (
      lines[i].startsWith("--- ") &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith("+++ ")
    ) {
      return "unified";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Edit model
// ---------------------------------------------------------------------------

interface Fail {
  code: string;
  path: string;
}

type Edit =
  | {
      format: "unified";
      kind: "create" | "delete" | "move" | "change";
      oldPath: string;
      newPath: string;
      hunks: Hunk[];
    }
  | {
      format: "search-replace";
      path: string;
      oldLines: string[];
      newLines: string[];
    }
  | {
      format: "v4a";
      kind: "add" | "delete" | "update";
      path: string;
      moveTo: string | null;
      lines: string[];
      chunks: V4AChunk[];
    }
  | {
      format: "json";
      kind: "create" | "str_replace" | "insert";
      path: string;
      fileText: string;
      oldStr: string;
      newStr: string;
      insertLine: number;
    };

interface RawBodyLine {
  kind: "ctx" | "del" | "add" | "backslash";
  text: string;
}

interface Hunk {
  a: number;
  body: RawBodyLine[];
}

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: RawBodyLine[];
}

// Split a hunk/chunk body into its old lines O and new lines N.
function bodyParts(body: RawBodyLine[]): { o: OItem[]; n: NItem[] } {
  const o: OItem[] = [];
  const n: NItem[] = [];
  for (const b of body) {
    if (b.kind === "ctx") {
      const idx = o.length;
      o.push({ kind: "ctx", text: b.text });
      n.push({ kind: "ctx", text: b.text, oIndex: idx });
    } else if (b.kind === "del") {
      o.push({ kind: "del", text: b.text });
    } else if (b.kind === "add") {
      n.push({ kind: "add", text: b.text, oIndex: -1 });
    }
  }
  return { o, n };
}

// True when a `\` line immediately follows the body's last context or `+` line.
function backslashAfterLastNLine(body: RawBodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].kind === "ctx" || body[i].kind === "add") last = i;
  }
  if (last === -1) return false;
  return last + 1 < body.length && body[last + 1].kind === "backslash";
}

// Apply one hunk to a file copy, tracking the running length delta d.
// Returns the new d, or a failure code.
function applyHunk(
  f: FileState,
  hunk: Hunk,
  d: number,
  strict: boolean,
): { ok: boolean; code?: string; d: number } {
  const { o, n } = bodyParts(hunk.body);
  if (o.length === 0) {
    const oldLen = f.lines.length;
    const pos = Math.min(hunk.a + d, oldLen);
    const ins = n.map((item) => item.text);
    f.lines.splice(pos, 0, ...ins);
    if (pos === oldLen) {
      f.finalBreak = !backslashAfterLastNLine(hunk.body);
    }
    return { ok: true, d: d + n.length };
  }
  const tiers = strict ? [0] : [0, 1, 2];
  const found = findTier(
    f.lines,
    o.map((x) => x.text),
    tiers,
    0,
  );
  if (!found) return { ok: false, code: "no-match", d };
  const target = hunk.a - 1 + d;
  let best = found.occ[0];
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const atEnd = best + o.length === f.lines.length;
  applyReplace(f, best, o, n, found.tier);
  if (atEnd) f.finalBreak = !backslashAfterLastNLine(hunk.body);
  return { ok: true, d: d + n.length - o.length };
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf("\t");
  return (tab === -1 ? rest : rest.slice(0, tab)).trim();
}

function stripAB(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function isUnifiedBodyLine(line: string): boolean {
  return (
    line === "" ||
    line.startsWith(" ") ||
    line.startsWith("-") ||
    line.startsWith("+") ||
    line.startsWith("\\")
  );
}

function parseUnifiedBodyLine(line: string): RawBodyLine {
  if (line === "") return { kind: "ctx", text: "" };
  const c = line[0];
  if (c === " ") return { kind: "ctx", text: line.slice(1) };
  if (c === "-") return { kind: "del", text: line.slice(1) };
  if (c === "+") return { kind: "add", text: line.slice(1) };
  return { kind: "backslash", text: line };
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  diffOld: string | null;
  diffNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  hasPair: boolean;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

function newUnifiedSection(): UnifiedSection {
  return {
    oldPath: null,
    newPath: null,
    diffOld: null,
    diffNew: null,
    renameFrom: null,
    renameTo: null,
    hasPair: false,
    newFileMode: false,
    deletedFileMode: false,
    hunks: [],
  };
}

function sectionToEdit(sec: UnifiedSection): Edit {
  const oldPath = sec.oldPath !== null ? sec.oldPath : sec.renameFrom !== null ? sec.renameFrom : sec.diffOld !== null ? sec.diffOld : "";
  const newPath = sec.newPath !== null ? sec.newPath : sec.renameTo !== null ? sec.renameTo : sec.diffNew !== null ? sec.diffNew : "";
  let kind: "create" | "delete" | "move" | "change";
  if (oldPath === "/dev/null" || sec.newFileMode) kind = "create";
  else if (newPath === "/dev/null" || sec.deletedFileMode) kind = "delete";
  else if (oldPath !== newPath) kind = "move";
  else kind = "change";
  return { format: "unified", kind, oldPath, newPath, hunks: sec.hunks };
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let sec: UnifiedSection | null = null;
  let inHeader = false;
  let hunk: Hunk | null = null;

  const endHunk = (): void => {
    if (hunk !== null && sec !== null) {
      const b = hunk.body;
      while (b.length > 0 && b[b.length - 1].kind === "ctx" && b[b.length - 1].text === "") {
        b.pop();
      }
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  const endSection = (): void => {
    endHunk();
    if (sec !== null) edits.push(sectionToEdit(sec));
    sec = null;
    inHeader = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (hunk !== null) {
      // A `--- ` line followed by a `+++ ` line ends the body (SPEC section
      // 6): it starts a new section, it is not a `-` body line.
      if (
        line.startsWith("--- ") &&
        i + 1 < lines.length &&
        lines[i + 1].startsWith("+++ ")
      ) {
        endHunk();
        // fall through: the line is handled outside the body
      } else if (isUnifiedBodyLine(line)) {
        hunk.body.push(parseUnifiedBodyLine(line));
        continue;
      } else {
        endHunk();
        // fall through: the line is handled outside the body
      }
    }
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (!m) throw new ParseError(lineNo);
      endSection();
      sec = newUnifiedSection();
      sec.diffOld = m[1];
      sec.diffNew = m[2];
      inHeader = true;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new ParseError(lineNo);
      if (sec === null) throw new ParseError(lineNo);
      hunk = { a: parseInt(m[1], 10), body: [] };
      inHeader = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      const next = i + 1 < lines.length ? lines[i + 1] : null;
      const hasPairNext = next !== null && next.startsWith("+++ ");
      if (sec !== null && inHeader) {
        if (!hasPairNext) throw new ParseError(lineNo + 1);
        if (sec.hasPair) {
          endSection();
          sec = newUnifiedSection();
          inHeader = true;
        }
        sec.oldPath = stripAB(headerPath(line));
        sec.newPath = stripAB(headerPath(next as string));
        sec.hasPair = true;
        i++;
        continue;
      }
      if (sec === null) {
        if (hasPairNext) {
          sec = newUnifiedSection();
          inHeader = true;
          sec.oldPath = stripAB(headerPath(line));
          sec.newPath = stripAB(headerPath(next as string));
          sec.hasPair = true;
          i++;
        }
        continue;
      }
      // A section exists and its hunks are done: a ---/+++ pair starts a
      // new section; anything else is ignored prose.
      if (hasPairNext) {
        endSection();
        sec = newUnifiedSection();
        inHeader = true;
        sec.oldPath = stripAB(headerPath(line));
        sec.newPath = stripAB(headerPath(next as string));
        sec.hasPair = true;
        i++;
      }
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith("rename from ")) {
        sec.renameFrom = line.slice("rename from ".length).trim();
      } else if (line.startsWith("rename to ")) {
        sec.renameTo = line.slice("rename to ".length).trim();
      } else if (line.startsWith("new file mode")) {
        sec.newFileMode = true;
      } else if (line.startsWith("deleted file mode")) {
        sec.deletedFileMode = true;
      }
      // index, old mode, new mode, similarity index, dissimilarity index,
      // Index: lines and any other line are ignored.
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
  }
  endSection();
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    let searchIdx = -1;
    for (let j = i; j < lines.length; j++) {
      if (stripTrailingWS(lines[j]) === "<<<<<<< SEARCH") {
        searchIdx = j;
        break;
      }
    }
    if (searchIdx === -1) break;
    let sepIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (stripTrailingWS(lines[j]) === "=======") {
        sepIdx = j;
        break;
      }
    }
    if (sepIdx === -1) throw new ParseError(searchIdx + 1);
    let endIdx = -1;
    for (let j = sepIdx + 1; j < lines.length; j++) {
      if (stripTrailingWS(lines[j]) === ">>>>>>> REPLACE") {
        endIdx = j;
        break;
      }
    }
    if (endIdx === -1) throw new ParseError(searchIdx + 1);
    const oldLines = lines.slice(searchIdx + 1, sepIdx);
    const newLines = lines.slice(sepIdx + 1, endIdx);
    let foundPath: string | null = null;
    for (let p = searchIdx - 1; p > prevReplaceEnd; p--) {
      const s = lines[p];
      if (s.trim() === "") continue;
      if (s.trim().startsWith("```")) continue;
      foundPath = s.trim();
      break;
    }
    if (foundPath === null) {
      if (prevPath !== null) {
        foundPath = prevPath;
      } else {
        throw new ParseError(searchIdx + 1);
      }
    }
    edits.push({ format: "search-replace", path: foundPath, oldLines, newLines });
    prevPath = foundPath;
    prevReplaceEnd = endIdx;
    i = endIdx + 1;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

const V4A_SECTION_RE = /^\*\*\* (Add|Delete|Update) File: (.*)$/;

function parseV4ABodyLine(line: string): RawBodyLine {
  if (line === "") return { kind: "ctx", text: "" };
  const c = line[0];
  if (c === " ") return { kind: "ctx", text: line.slice(1) };
  if (c === "-") return { kind: "del", text: line.slice(1) };
  return { kind: "add", text: line.slice(1) };
}

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== "*** Begin Patch") throw new ParseError(first + 1);
  if (lines[last].trim() !== "*** End Patch") throw new ParseError(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const m = V4A_SECTION_RE.exec(line);
    if (!m) throw new ParseError(i + 1);
    const kind = m[1];
    const pth = m[2].trim();
    if (kind === "Add") {
      const flines: string[] = [];
      i++;
      while (i < last) {
        const l = lines[i];
        if (V4A_SECTION_RE.test(l)) break;
        if (l === "") {
          flines.push("");
          i++;
          continue;
        }
        if (l.startsWith("+")) {
          flines.push(l.slice(1));
          i++;
          continue;
        }
        throw new ParseError(i + 1);
      }
      while (flines.length > 0 && flines[flines.length - 1] === "") flines.pop();
      edits.push({ format: "v4a", kind: "add", path: pth, moveTo: null, lines: flines, chunks: [] });
      continue;
    }
    if (kind === "Delete") {
      i++;
      while (i < last) {
        const l = lines[i];
        if (V4A_SECTION_RE.test(l)) break;
        if (l.trim() === "") {
          i++;
          continue;
        }
        throw new ParseError(i + 1);
      }
      edits.push({ format: "v4a", kind: "delete", path: pth, moveTo: null, lines: [], chunks: [] });
      continue;
    }
    // Update File
    const updateLineNo = i + 1;
    i++;
    let moveTo: string | null = null;
    if (i < last && lines[i].startsWith("*** Move to: ")) {
      moveTo = lines[i].slice("*** Move to: ".length).trim();
      i++;
    }
    const chunks: V4AChunk[] = [];
    let cur: V4AChunk | null = null;
    let seenChunk = false;
    const endChunk = (strip: boolean): void => {
      if (cur !== null) {
        if (strip) {
          const b = cur.body;
          while (b.length > 0 && b[b.length - 1].kind === "ctx" && b[b.length - 1].text === "") {
            b.pop();
          }
        }
        chunks.push(cur);
      }
      cur = null;
    };
    let closed = false;
    while (i < last) {
      const l = lines[i];
      if (V4A_SECTION_RE.test(l)) {
        closed = true;
        break;
      }
      if (l === "*** End of File") {
        if (cur === null) throw new ParseError(i + 1);
        cur.eof = true;
        endChunk(false);
        i++;
        continue;
      }
      if (l.startsWith("@@")) {
        endChunk(false);
        cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
        seenChunk = true;
        i++;
        continue;
      }
      if (l.startsWith(" ") || l.startsWith("-") || l.startsWith("+") || l === "") {
        if (cur === null) {
          if (seenChunk) throw new ParseError(i + 1);
          cur = { anchor: null, eof: false, body: [] };
          seenChunk = true;
        }
        cur.body.push(parseV4ABodyLine(l));
        i++;
        continue;
      }
      throw new ParseError(i + 1);
    }
    if (!closed) endChunk(true);
    else endChunk(false);
    if (chunks.length === 0 && moveTo === null) throw new ParseError(updateLineNo);
    edits.push({ format: "v4a", kind: "update", path: pth, moveTo, lines: [], chunks });
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function jsonEditObject(obj: unknown, lineNo: number): Edit {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new ParseError(lineNo);
  }
  const o = obj as Record<string, unknown>;
  if (typeof o["path"] !== "string") throw new ParseError(lineNo);
  if (typeof o["command"] !== "string") throw new ParseError(lineNo);
  const pth = o["path"] as string;
  const cmd = o["command"] as string;
  if (cmd === "create") {
    if (typeof o["file_text"] !== "string") throw new ParseError(lineNo);
    return {
      format: "json",
      kind: "create",
      path: pth,
      fileText: o["file_text"] as string,
      oldStr: "",
      newStr: "",
      insertLine: 0,
    };
  }
  if (cmd === "str_replace") {
    if (typeof o["old_str"] !== "string" || (o["old_str"] as string) === "") {
      throw new ParseError(lineNo);
    }
    if (o["new_str"] !== undefined && typeof o["new_str"] !== "string") {
      throw new ParseError(lineNo);
    }
    return {
      format: "json",
      kind: "str_replace",
      path: pth,
      fileText: "",
      oldStr: o["old_str"] as string,
      newStr: typeof o["new_str"] === "string" ? (o["new_str"] as string) : "",
      insertLine: 0,
    };
  }
  if (cmd === "insert") {
    if (typeof o["insert_line"] !== "number" || !Number.isInteger(o["insert_line"])) {
      throw new ParseError(lineNo);
    }
    if (typeof o["new_str"] !== "string") throw new ParseError(lineNo);
    return {
      format: "json",
      kind: "insert",
      path: pth,
      fileText: "",
      oldStr: "",
      newStr: o["new_str"] as string,
      insertLine: o["insert_line"] as number,
    };
  }
  throw new ParseError(lineNo);
}

function parseJSON(lines: string[]): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) throw new ParseError(1);
  const text = lines.join("\n");
  const firstChar = lines[firstIdx].trimStart()[0];
  const edits: Edit[] = [];
  if (firstChar === "[") {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseError(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(firstIdx + 1);
    for (const el of arr) edits.push(jsonEditObject(el, firstIdx + 1));
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseError(i + 1);
    }
    edits.push(jsonEditObject(obj, i + 1));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// Applying edits (SPEC section 10)
// ---------------------------------------------------------------------------

type Tree = Map<string, FileState>;
type MoveRecord = { old: string; nw: string };

function applyUnified(
  tree: Tree,
  edit: Extract<Edit, { format: "unified" }>,
  strict: boolean,
  moves: MoveRecord[],
): Fail | null {
  if (edit.kind === "create") {
    if (!isSafePath(edit.newPath)) return { code: "unsafe", path: edit.newPath };
    if (tree.has(edit.newPath)) return { code: "exists", path: edit.newPath };
    const newLines: string[] = [];
    let lastPlus: { hunk: Hunk; idx: number } | null = null;
    for (const h of edit.hunks) {
      for (let idx = 0; idx < h.body.length; idx++) {
        if (h.body[idx].kind === "add") {
          newLines.push(h.body[idx].text);
          lastPlus = { hunk: h, idx };
        }
      }
    }
    let finalBreak = true;
    if (lastPlus !== null) {
      const b = lastPlus.hunk.body;
      finalBreak = !(
        lastPlus.idx + 1 < b.length && b[lastPlus.idx + 1].kind === "backslash"
      );
    }
    tree.set(edit.newPath, {
      lines: newLines,
      br: "\n",
      finalBreak: newLines.length > 0 ? finalBreak : false,
    });
    return null;
  }
  if (edit.kind === "delete") {
    if (!isSafePath(edit.oldPath)) return { code: "unsafe", path: edit.oldPath };
    if (!tree.has(edit.oldPath)) return { code: "missing", path: edit.oldPath };
    tree.delete(edit.oldPath);
    return null;
  }
  // move or change
  if (!isSafePath(edit.oldPath)) return { code: "unsafe", path: edit.oldPath };
  if (!isSafePath(edit.newPath)) return { code: "unsafe", path: edit.newPath };
  if (!tree.has(edit.oldPath)) return { code: "missing", path: edit.oldPath };
  if (edit.kind === "move" && tree.has(edit.newPath)) {
    return { code: "exists", path: edit.newPath };
  }
  const f = cloneFile(tree.get(edit.oldPath) as FileState);
  let d = 0;
  for (const hunk of edit.hunks) {
    const r = applyHunk(f, hunk, d, strict);
    if (!r.ok) return { code: r.code as string, path: edit.oldPath };
    d = r.d;
  }
  if (edit.kind === "move") {
    tree.delete(edit.oldPath);
    tree.set(edit.newPath, f);
    moves.push({ old: edit.oldPath, nw: edit.newPath });
  } else {
    tree.set(edit.oldPath, f);
  }
  return null;
}

function applySearchReplace(
  tree: Tree,
  edit: Extract<Edit, { format: "search-replace" }>,
  strict: boolean,
): Fail | null {
  if (!isSafePath(edit.path)) return { code: "unsafe", path: edit.path };
  if (edit.oldLines.length === 0) {
    if (tree.has(edit.path)) return { code: "exists", path: edit.path };
    tree.set(edit.path, {
      lines: edit.newLines.slice(),
      br: "\n",
      finalBreak: edit.newLines.length > 0,
    });
    return null;
  }
  const f = tree.get(edit.path);
  if (!f) return { code: "missing", path: edit.path };
  const tiers = strict ? [0] : [0, 1, 2];
  const found = findTier(f.lines, edit.oldLines, tiers, 0);
  if (!found) return { code: "no-match", path: edit.path };
  if (found.occ.length > 1) return { code: "ambiguous", path: edit.path };
  const nf = cloneFile(f);
  const o: OItem[] = edit.oldLines.map((t) => ({ kind: "del" as const, text: t }));
  const n: NItem[] = edit.newLines.map((t) => ({ kind: "add" as const, text: t, oIndex: -1 }));
  applyReplace(nf, found.occ[0], o, n, found.tier);
  tree.set(edit.path, nf);
  return null;
}

function applyV4AChunk(
  f: FileState,
  chunk: V4AChunk,
  cursor: number,
  strict: boolean,
): { ok: boolean; code?: string; cursor: number } {
  const tiers = strict ? [0] : [0, 1, 2];
  let cur = cursor;
  if (chunk.anchor !== null && chunk.anchor !== "") {
    const found = findTier(f.lines, [chunk.anchor], tiers, cur);
    if (!found) return { ok: false, code: "no-match", cursor };
    cur = found.occ[0] + 1;
  }
  const { o, n } = bodyParts(chunk.body);
  if (o.length === 0) {
    const pos = chunk.eof ? f.lines.length : cur;
    const ins = n.map((item) => item.text);
    f.lines.splice(pos, 0, ...ins);
    return { ok: true, cursor: pos + n.length };
  }
  if (chunk.eof) {
    const endPos = f.lines.length - o.length;
    if (endPos < cur) return { ok: false, code: "no-match", cursor };
    const tier = matchTierAt(f.lines, o.map((x) => x.text), endPos, tiers);
    if (tier === null) return { ok: false, code: "no-match", cursor };
    applyReplace(f, endPos, o, n, tier);
    return { ok: true, cursor: endPos + n.length };
  }
  const found = findTier(f.lines, o.map((x) => x.text), tiers, cur);
  if (!found) return { ok: false, code: "no-match", cursor };
  const pos = found.occ[0];
  applyReplace(f, pos, o, n, found.tier);
  return { ok: true, cursor: pos + n.length };
}

function applyV4A(
  tree: Tree,
  edit: Extract<Edit, { format: "v4a" }>,
  strict: boolean,
  moves: MoveRecord[],
): Fail | null {
  if (edit.kind === "add") {
    if (!isSafePath(edit.path)) return { code: "unsafe", path: edit.path };
    if (tree.has(edit.path)) return { code: "exists", path: edit.path };
    tree.set(edit.path, {
      lines: edit.lines.slice(),
      br: "\n",
      finalBreak: edit.lines.length > 0,
    });
    return null;
  }
  if (edit.kind === "delete") {
    if (!isSafePath(edit.path)) return { code: "unsafe", path: edit.path };
    if (!tree.has(edit.path)) return { code: "missing", path: edit.path };
    tree.delete(edit.path);
    return null;
  }
  // update
  if (!isSafePath(edit.path)) return { code: "unsafe", path: edit.path };
  if (edit.moveTo !== null && !isSafePath(edit.moveTo)) {
    return { code: "unsafe", path: edit.moveTo };
  }
  if (!tree.has(edit.path)) return { code: "missing", path: edit.path };
  if (edit.moveTo !== null && tree.has(edit.moveTo)) {
    return { code: "exists", path: edit.moveTo };
  }
  const f = cloneFile(tree.get(edit.path) as FileState);
  let cursor = 0;
  for (const chunk of edit.chunks) {
    const r = applyV4AChunk(f, chunk, cursor, strict);
    if (!r.ok) return { code: r.code as string, path: edit.path };
    cursor = r.cursor;
  }
  if (edit.moveTo !== null) {
    tree.delete(edit.path);
    tree.set(edit.moveTo, f);
    moves.push({ old: edit.path, nw: edit.moveTo });
  } else {
    tree.set(edit.path, f);
  }
  return null;
}

function applyJSON(
  tree: Tree,
  edit: Extract<Edit, { format: "json" }>,
): Fail | null {
  if (!isSafePath(edit.path)) return { code: "unsafe", path: edit.path };
  if (edit.kind === "create") {
    if (tree.has(edit.path)) return { code: "exists", path: edit.path };
    tree.set(edit.path, parseFileText(edit.fileText));
    return null;
  }
  const f = tree.get(edit.path);
  if (!f) return { code: "missing", path: edit.path };
  if (edit.kind === "str_replace") {
    let text = serializeFile(f);
    let oldS = edit.oldStr;
    let newS = edit.newStr;
    if (f.br === "\r\n") {
      text = text.replace(/\r\n/g, "\n");
      oldS = oldS.replace(/\r\n/g, "\n");
      newS = newS.replace(/\r\n/g, "\n");
    }
    let count = 0;
    let firstIdx = -1;
    let from = 0;
    for (;;) {
      const j = text.indexOf(oldS, from);
      if (j === -1) break;
      count++;
      if (firstIdx === -1) firstIdx = j;
      if (count > 1) break;
      from = j + 1;
    }
    if (count === 0) return { code: "no-match", path: edit.path };
    if (count > 1) return { code: "ambiguous", path: edit.path };
    const replaced = text.slice(0, firstIdx) + newS + text.slice(firstIdx + oldS.length);
    const back = f.br === "\r\n" ? replaced.replace(/\n/g, "\r\n") : replaced;
    tree.set(edit.path, parseFileText(back));
    return null;
  }
  // insert
  if (edit.insertLine < 0 || edit.insertLine > f.lines.length) {
    return { code: "no-match", path: edit.path };
  }
  const nf = cloneFile(f);
  nf.lines.splice(edit.insertLine, 0, ...splitNewStr(edit.newStr));
  tree.set(edit.path, nf);
  return null;
}

function applyEdit(
  tree: Tree,
  edit: Edit,
  strict: boolean,
  moves: MoveRecord[],
): Fail | null {
  if (edit.format === "unified") return applyUnified(tree, edit, strict, moves);
  if (edit.format === "search-replace") return applySearchReplace(tree, edit, strict);
  if (edit.format === "v4a") return applyV4A(tree, edit, strict, moves);
  return applyJSON(tree, edit);
}

// ---------------------------------------------------------------------------
// Tree IO and reporting
// ---------------------------------------------------------------------------

function loadTree(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = rel === "" ? e.name : rel + "/" + e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, p);
      } else if (e.isFile()) {
        try {
          result.set(p, fs.readFileSync(full, "utf8"));
        } catch {
          // unreadable file: leave it out of the tree
        }
      }
    }
  };
  walk(root, "");
  return result;
}

function computeChanges(
  initial: Map<string, string>,
  tree: Tree,
  moves: MoveRecord[],
): string[] {
  const finalTexts = new Map<string, string>();
  for (const [p, f] of tree) finalTexts.set(p, serializeFile(f));
  const items: { key: string; line: string }[] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const m of moves) {
    if (
      initial.has(m.old) &&
      !finalTexts.has(m.old) &&
      !initial.has(m.nw) &&
      finalTexts.has(m.nw)
    ) {
      items.push({ key: m.nw, line: "R " + m.old + " -> " + m.nw });
      rOld.add(m.old);
      rNew.add(m.nw);
    }
  }
  const allPaths = new Set<string>([...initial.keys(), ...finalTexts.keys()]);
  for (const p of allPaths) {
    const before = initial.get(p);
    const after = finalTexts.get(p);
    if (before === undefined && after !== undefined) {
      if (!rNew.has(p)) items.push({ key: p, line: "A " + p });
    } else if (before !== undefined && after === undefined) {
      if (!rOld.has(p)) items.push({ key: p, line: "D " + p });
    } else if (before !== undefined && after !== undefined && before !== after) {
      items.push({ key: p, line: "M " + p });
    }
  }
  items.sort((a, b) => Buffer.compare(Buffer.from(a.key, "utf8"), Buffer.from(b.key, "utf8")));
  return items.map((i) => i.line);
}

function writeTree(initial: Map<string, string>, tree: Tree): void {
  const finalTexts = new Map<string, string>();
  for (const [p, f] of tree) finalTexts.set(p, serializeFile(f));
  const allPaths = new Set<string>([...initial.keys(), ...finalTexts.keys()]);
  for (const p of allPaths) {
    const before = initial.get(p);
    const after = finalTexts.get(p);
    if (after === undefined && before !== undefined) {
      try {
        fs.unlinkSync(p);
      } catch {
        // already gone
      }
    } else if (after !== undefined && before !== after) {
      const dir = path.dirname(p);
      if (dir !== ".") fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, after, "utf8");
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    out("error: usage\n");
    return 2;
  }
  let patchText: string;
  if (args.patch === null || args.patch === "-") {
    patchText = fs.readFileSync(0, "utf8");
  } else {
    try {
      patchText = fs.readFileSync(args.patch, "utf8");
    } catch {
      out("error: no-patch\n");
      return 2;
    }
  }
  const lines = splitPatchLines(patchText);
  let fmt: string | null = args.format;
  if (fmt === "auto") {
    fmt = detectFormat(lines);
    if (fmt === null) {
      out("error: format\n");
      return 2;
    }
  }
  let edits: Edit[];
  try {
    if (fmt === "unified") edits = parseUnified(lines);
    else if (fmt === "search-replace") edits = parseSearchReplace(lines);
    else if (fmt === "v4a") edits = parseV4A(lines);
    else edits = parseJSON(lines);
  } catch (e) {
    if (e instanceof ParseError) {
      out("error: parse " + e.line + "\n");
      return 2;
    }
    throw e;
  }

  const initial = loadTree(process.cwd());
  const tree: Tree = new Map<string, FileState>();
  for (const [p, t] of initial) tree.set(p, parseFileText(t));

  const failures: Fail[] = [];
  const moves: MoveRecord[] = [];
  for (const edit of edits) {
    const fail = applyEdit(tree, edit, args.strict, moves);
    if (fail !== null) failures.push(fail);
  }

  if (failures.length > 0) {
    let text = "";
    for (const f of failures) text += "error: " + f.code + " " + f.path + "\n";
    text += "failed: " + failures.length + " of " + edits.length + " edits\n";
    out(text);
    return 1;
  }

  const changes = computeChanges(initial, tree, moves);
  if (!args.check) writeTree(initial, tree);
  let text = "";
  for (const c of changes) text += c + "\n";
  text += changes.length === 1 ? "ok: 1 file\n" : "ok: " + changes.length + " files\n";
  out(text);
  return 0;
}

process.exitCode = main();
