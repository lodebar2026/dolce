// 歌本切分 · 第一遍逐页扫描：版面几何 + 页脚页码 OCR + 标题候选 OCR + 像目录的页整页 OCR。只留几何与文字，不留像素。
import type { OcrBackend } from "../../omrkit/ocr";
import type { Binary, Rect } from "../../omrkit/types";
import type { RgbaImage } from "../../omrkit/decode";
import { otsu, rgbaToBinary, toGray } from "../../omrkit/preprocess";
import { surfaceFromInk } from "../../omrkit/surface";
import { analyzePage, boxOf, footerWords, isMusicBand, isTitleCandidate, pageComps, type Band, type PageComps, type PageLayout } from "./layout";
import type { Component } from "../../omrkit/types";
import type { PageInfo, TitleHit, TocEntry } from "./types";

type OcrLine = { text: string; bbox: Rect; chars?: { text: string; cx: number; x1?: number }[] };

const CJK = /[㐀-鿿豈-﫿]/;
const PAGE_NO_RE = /^[-–—_~·.\s]*(\d{1,4})[-–—_~·.\s]*$/;

/** `toc`：true = 当目录页整页 OCR，false = 不当，undefined = 按版面自动认。 */
/** `expect`：按上一页推的本页页码（上一页 + 1）。页码区常有折痕、污点也读得出数，候选里有等于它的就取它。 */
export async function scanPage(index: number, img: RgbaImage, ocr: OcrBackend, toc?: boolean, expect?: number): Promise<PageInfo> {
  const bin = pageBinary(img);
  if (!ocr.recognizeRegion) throw new Error("OCR 后端不支持整片识别（需要 PaddleOCR 检测模型）");
  const pc = pageComps(bin);
  // 页码先在连通块上找出来剔掉，再分带：页码常紧贴末行、甚至与末行歌词同排，按带找会被并进正文
  let footer: { n: number; comps: Component[] } | undefined;
  for (const g of footerWords(pc)) { // 最靠下的在前
    const n = await readPageNumber(bin, g, pc, ocr);
    if (n === undefined) continue;
    if (!footer) footer = { n, comps: g };
    if (expect === undefined) break;
    if (n === expect) { footer = { n, comps: g }; break; }
  }
  const layout = analyzePage(pc, bin, img.data, new Set(footer?.comps ?? []));
  const info: PageInfo = { index, layout, body: layout.bands, titles: [], toc: [] };
  if (footer) { info.printed = footer.n; info.footer = boxOf(footer.comps); }

  // 刚认出标题、还没到谱行（两道小节线以上的带）：这一段是本首的页眉，里面的大字（出处「希伯来书13:1-2节」与调号同排）不是下一首的标题
  let inHeader = false;
  for (let k = 0; k < info.body.length; k++) {
    const b = info.body[k];
    if (b.bars >= 2) inHeader = false;
    if (inHeader || !isTitleCandidate(b, layout)) continue;
    const lines = await ocr.recognizeRegion(bin, pad(b, layout, layout.charH * 0.3));
    const inkH = (r: Rect) => inkHeight(bin, r);
    let hit = parseTitle(lines, b, layout, inkH);
    // 调号不与曲名同排、印在下面的页眉行里（简线混排谱：曲名、出处、「1=F 4/4」各占一行）：往下到谱行之前找调号
    if (!hit && lines.some((l) => CJK.test(l.text)) && await keyBelow(bin, info.body, k, layout, ocr)) hit = parseTitle(lines, b, layout, inkH, true);
    if (!hit) continue;
    inHeader = true;
    if (hit.titleBox) {
      const t = await rereadTitle(bin, hit.titleBox, ocr);
      if (t && t.length >= [...hit.title].filter((c) => CJK.test(c)).length) hit.title = t;
    }
    // 曲号以带两端的数字块逐字认为准（整行 OCR 常把曲号与调号读成一串「1151=C」、或把粗体数字读错）
    const n = await edgeNumber(bin, b, layout.charH, ocr, hit.numberSpan);
    if (n !== undefined) hit.number = n;
    info.titles.push(hit);
  }

  if (toc ?? looksLikeToc(info.body, layout.h)) info.toc = parseToc(await ocr.recognizeRegion(bin, fullRect(bin)));
  for (const b of layout.bands) b.boxes = [];
  return info;
}

/** 页眉行最多看几带 */
const HEADER_BANDS = 3;

/** 第 k 带（标题候选）之下、谱行与下一个（读不出调号的）标题候选之前的几带里读得出调号「1=」。 */
async function keyBelow(bin: Binary, body: readonly Band[], k: number, p: PageLayout, ocr: OcrBackend): Promise<boolean> {
  for (let j = k + 1; j < body.length && j <= k + HEADER_BANDS; j++) {
    const b = body[j];
    if (b.bars >= 2) return false;
    const lines = await ocr.recognizeRegion!(bin, pad(b, p, p.charH * 0.3));
    if (KEY_RE.test([...lines].sort((a, c) => a.bbox.x - c.bbox.x).map((l) => l.text).join(" "))) return true;
    // 读不出调号的下一个标题候选就是下一首了（调号与出处同排的页眉行也像候选，先读再停）
    if (isTitleCandidate(b, p)) return false;
  }
  return false;
}

/**
 * 曲号按字形逐字认：带内块按横向间隙 ≤ 0.7 字高并成「词」，看最左、最右两个词——整词的字（块按横向重叠并成字）
 * 全像数字（够高、不宽）且不超过 4 个，才逐字按 0–9 认。「1=C」里有「=」、出处「1-5」里有「-」，整词就不算。
 * 两端都像曲号时取离整行 OCR 读到曲号的位置近的那个，没读到取左边。整行 OCR 常把曲号与调号读成一串（「1151=C」）、
 * 把出处粘上（「1-5 469」读成「5469」）、或把左边调号的「1」当曲号；逐字认的就是那几个块，读多读少都不会。
 */
async function edgeNumber(bin: Binary, b: Band, charH: number, ocr: OcrBackend, span?: [number, number]): Promise<number | undefined> {
  if (!ocr.recognizeNumerals || !b.boxes.length) return undefined;
  const words: Rect[][] = [];
  for (const r of [...b.boxes].sort((p, q) => p.x - q.x)) {
    const w = words[words.length - 1];
    if (w && r.x - Math.max(...w.map((q) => q.x + q.w)) <= charH * 0.7) w.push(r); else words.push([r]);
  }
  const cands: { n: number; x: number }[] = [];
  for (const w of words.length > 1 ? [words[0], words[words.length - 1]] : words) {
    const cells: Rect[] = [];
    for (const r of w) {
      const last = cells[cells.length - 1];
      if (last && r.x < last.x + last.w) {
        const x = Math.min(last.x, r.x), y = Math.min(last.y, r.y);
        cells[cells.length - 1] = { x, y, w: Math.max(last.x + last.w, r.x + r.w) - x, h: Math.max(last.y + last.h, r.y + r.h) - y };
      } else cells.push({ ...r });
    }
    if (!cells.length || cells.length > 4) continue;
    if (!cells.every((c) => c.h >= charH * 0.8 && c.h <= charH * 2 && c.w <= c.h * 0.9)) continue;
    const ds = await ocr.recognizeNumerals(bin, cells);
    if (ds.every((d) => d !== undefined) && ds[0] !== 0) cands.push({ n: Number(ds.join("")), x: cells[0].x });
  }
  if (cands.length < 2 || !span) return cands[0]?.n;
  return cands.reduce((a, c) => (Math.abs(c.x - span[0]) < Math.abs(a.x - span[0]) ? c : a)).n;
}

/**
 * 页码：词里的块按横向重叠并成字（断笔并回），够高的逐字按 0–9 认（「– 4 –」这种整片检测常读丢）；
 * 有字认不出、或两字粘成一块时退整片 OCR。返回 undefined = 不是页码。
 */
async function readPageNumber(bin: Binary, g: readonly Component[], pc: PageComps, ocr: OcrBackend): Promise<number | undefined> {
  // 先把横向重叠的块并成字（断笔的「2」是上下两截），再丢掉横杠
  const merged: Rect[] = [];
  for (const { bbox: r } of [...g].sort((a, b) => a.bbox.x - b.bbox.x)) {
    const last = merged[merged.length - 1];
    if (last && r.x < last.x + last.w) {
      const x = Math.min(last.x, r.x), y = Math.min(last.y, r.y);
      merged[merged.length - 1] = { x, y, w: Math.max(last.x + last.w, r.x + r.w) - x, h: Math.max(last.y + last.h, r.y + r.h) - y };
    } else merged.push({ ...r });
  }
  const cells = merged.filter((r) => r.h >= pc.charH * 0.6);
  if (!cells.length || cells.length > 4) return undefined;
  // 两个数字粘成一块（「44」）逐字认不了，交给整片 OCR
  if (ocr.recognizeNumerals && cells.every((c) => c.w <= c.h * 0.95)) {
    const ds = await ocr.recognizeNumerals(bin, cells);
    if (ds.every((d) => d !== undefined)) return Number(ds.join(""));
  }
  const b = boxOf(g), d = Math.round(pc.charH * 0.4);
  const x = Math.max(0, b.x - d), y = Math.max(0, b.y - d);
  const lines = await ocr.recognizeRegion!(bin, { x, y, w: Math.min(pc.w, b.x + b.w + d) - x, h: Math.min(pc.h, b.y + b.h + d) - y });
  const m = PAGE_NO_RE.exec(lines.map((l) => l.text).join(""));
  return m ? Number(m[1]) : undefined;
}

/**
 * 页面二值图：Sauvola 的墨再与全局 Otsu 阈值取交。扫描页常有背面透印的淡灰字，Sauvola 是局部阈值，
 * 在透印处照样判成墨，把相邻两带粘成一片；透印比正面墨浅得多，全局阈值一卡就掉。
 */
export function pageBinary(img: RgbaImage): Binary {
  const bin = rgbaToBinary(img.data, img.width, img.height);
  const gray = toGray(img.data, img.width, img.height);
  const { thr } = otsu(gray);
  for (let i = 0; i < gray.length; i++) if (gray[i] > thr) bin.data[i] = 0;
  return bin;
}

/** 框里墨迹的纵向实高（有 ≥ 2 个墨点的首行到末行）。 */
function inkHeight(bin: Binary, r: Rect): number {
  let y0 = -1, y1 = -1;
  const x0 = Math.max(0, Math.round(r.x)), x1 = Math.min(bin.w, Math.round(r.x + r.w));
  for (let y = Math.max(0, Math.round(r.y)); y < Math.min(bin.h, Math.round(r.y + r.h)); y++) {
    let n = 0;
    for (let x = x0; x < x1 && n < 2; x++) n += bin.data[y * bin.w + x];
    if (n >= 2) { if (y0 < 0) y0 = y; y1 = y; }
  }
  return y0 < 0 ? 0 : y1 - y0 + 1;
}

function pad(b: Band, p: PageLayout, d: number): Rect {
  const x = Math.max(0, Math.floor(b.x0 - d)), y = Math.max(0, Math.floor(b.y0 - d));
  return { x, y, w: Math.min(p.w, Math.ceil(b.x1 + d)) - x, h: Math.min(p.h, Math.ceil(b.y1 + d)) - y };
}

function fullRect(bin: Binary): Rect { return { x: 0, y: 0, w: bin.w, h: bin.h }; }

/** 像目录的页：没有谱行、字占了页高的四分之一以上（两栏错行时多行会并成一带，不能按带数算）。
 *  前言之类的文字页也会过，整页 OCR 后按「文字 + 两个数」认不出条目，不碍事。
 *  谱行至少有两道小节线：笔画细的字体里曲号的「1」也够得上「竖细长」，一行里一道不算谱行。 */
function looksLikeToc(body: readonly Band[], h: number): boolean {
  return body.length >= 3 && !body.some((b) => isMusicBand(b) && b.bars >= 2) && body.reduce((a, b) => a + b.y1 - b.y0, 0) >= h * 0.25;
}

/** 调号「1=C」「1=♭E」：标题行的标志（调名字母常读错，只认「1=」）。 */
const KEY_RE = /1\s*[=＝]/;
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff·、，！？]+/g;

/**
 * 标题带的 OCR → 曲名 + 曲号。带里读出调号（`1=`），或大字比本页字行高出 15% 且读得到曲号，才算标题
 * （有的本子某首歌词字号比别的大，光凭字大会把歌词行认成标题；段号「1.」不算曲号）。
 * 曲名：与最高那框（按墨迹实高）等高、横排相挨的各框里各取最长一段汉字拼起来（「圣　哉」检测常切成两框），
 *   字间空格与同一字形的重读去掉；
 * 曲号：不属于调号、拍号（`4/4`）、出处（`诗67篇`、`33:8`）的独立整数里最靠两端的那个；
 * 曲号紧挨调号读成一串（「115 1=C」→「1151=C」）时去掉末位的 1。
 */
export function parseTitle(
  lines: OcrLine[], band: Band, p: PageLayout, inkH: (r: Rect) => number = (r) => r.h, keyBelow = false,
): TitleHit | null {
  const cjkLines = lines.filter((l) => CJK.test(l.text));
  if (!cjkLines.length) return null;
  // 调号常被检测切成几框（「1=」「E」），按横向次序拼起来再认
  // `keyBelow`：调号印在下面的页眉行里（调用方已查过），与同排读出调号同等对待
  const hasKey = keyBelow || KEY_RE.test([...lines].sort((a, b) => a.bbox.x - b.bbox.x).map((l) => l.text).join(" "));
  // 字高按框里墨迹的实际高度比：检测框高带着外扩的边，旁边小一号的分类字（「教会」）框高也差不多
  const ink = new Map(cjkLines.map((l) => [l, inkH(l.bbox)]));
  const main = cjkLines.reduce((a, b) => (ink.get(b)! > ink.get(a)! ? b : a));
  const mainH = ink.get(main)!;
  // 单字框（含「诗103:11」这类出处只有一个汉字的框）放宽到墨高 0.75 倍并要求与最高框中线对齐：
  // 「二」「心」本身扁（实测 0.76、0.87），出处小一号（0.63–0.69）
  const sameSize = (l: OcrLine) => (l.text.replace(/[^\u3400-\u9fff\uf900-\ufaff]/g, "").length >= 2
    ? ink.get(l)! >= mainH * 0.88
    : ink.get(l)! >= mainH * 0.75 && Math.abs(l.bbox.y + l.bbox.h / 2 - (main.bbox.y + main.bbox.h / 2)) <= main.bbox.h * 0.25);
  // 与最高框等高、同一横排、且一框挨一框（间隙 ≤ 2.2 字高，「悔　　改」这种疏排标题字距近两字）的才拼：隔得远的同号字多是旁边的分类、出处（「悔改」「爱主」）
  const peers = cjkLines
    .filter((l) => sameSize(l) && overlapY(l.bbox, main.bbox) >= Math.min(l.bbox.h, main.bbox.h) * 0.5)
    .sort((a, b) => a.bbox.x - b.bbox.x);
  const at = peers.indexOf(main);
  let lo = at, hi = at;
  const near = (a: Rect, b: Rect) => b.x - (a.x + a.w) <= main.bbox.h * 2.2;
  while (lo > 0 && near(peers[lo - 1].bbox, peers[lo].bbox)) lo--;
  while (hi < peers.length - 1 && near(peers[hi].bbox, peers[hi + 1].bbox)) hi++;
  const parts = peers.slice(lo, hi + 1);
  const title = parts.map((l) => {
    const runs = (dedupeChars(l).replace(/\s+/g, "").match(CJK_RUN) ?? []).filter((r) => CJK.test(r));
    return runs.reduce((a, b) => (b.length > a.length ? b : a), "").replace(/^[·、，]+|[·、，]+$/g, "");
  }).join("");

  const nums: { v: number; x: number; x0: number; x1: number }[] = [];
  for (const l of lines) {
    const t = l.text;
    const re = /\d+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      let digits = m[0];
      const before = t.slice(0, m.index).replace(/\s+$/, "");
      const after = t.slice(m.index + digits.length).replace(/^\s+/, "");
      if (/^[=＝]/.test(after)) {
        if (digits.length < 2 || !digits.endsWith("1")) continue; // 调号本身
        digits = digits.slice(0, -1);
      } else if (/[=＝:：/／]$/.test(before) || /^[:：/／]/.test(after)) continue; // 4/4、33:8
      if (/[诗篇第章节]$/.test(before) || /^[篇章节首.．、]/.test(after)) continue; // 出处、段号「1.」
      const v = Number(digits);
      if (!(v >= 1 && v <= 9999)) continue;
      const ch = l.chars;
      const at = (k: number) => (ch && ch.length === t.length ? ch[k].cx : l.bbox.x + ((k + 0.5) / Math.max(1, t.length)) * l.bbox.w);
      const x0 = at(m.index), x1 = at(m.index + digits.length - 1);
      nums.push({ v, x: x0, x0, x1 });
    }
  }
  // 最靠左（在曲名左边）或最靠右（在曲名右边）的数；两边都有取离带边更近的
  const mid = main.bbox.x + main.bbox.w / 2;
  const left = nums.filter((n) => n.x < mid).sort((a, b) => a.x - b.x)[0];
  const right = nums.filter((n) => n.x >= mid).sort((a, b) => b.x - a.x)[0];
  const pick = left && right ? (left.x - band.x0 <= band.x1 - right.x ? left : right) : left ?? right;
  const number = pick?.v;
  // 没读出调号的，要字比本页字行大、且读得到曲号才算（防大字号歌词行）
  // 本页有铺开的大字歌词行时，大字还要比歌词字大 15%
  if (!hasKey && (band.bigH < Math.max(p.textH, p.lyricH) * 1.15 || number === undefined)) return null;
  // 整段重认的范围：往左并上拍号（含「/」或「=」的框）之后、紧挨着曲名的框——疏排的「二」会被单独读成「1」、不算汉字
  const fence = Math.max(-Infinity, ...lines.filter((l) => /[=＝/／]/.test(l.text)).map((l) => l.bbox.x + l.bbox.w));
  const extra = lines.filter((l) => !parts.includes(l) && l.bbox.x >= fence && l.bbox.x + l.bbox.w <= parts[0].bbox.x
    && l.bbox.h >= main.bbox.h * 0.6 && overlapY(l.bbox, main.bbox) >= Math.min(l.bbox.h, main.bbox.h) * 0.5)
    .sort((a, b) => b.bbox.x - a.bbox.x);
  const all = [...parts];
  for (const l of extra) if (all[0].bbox.x - (l.bbox.x + l.bbox.w) <= main.bbox.h * 2.2) all.unshift(l);
  const box = all.length > 1 ? unionBox(all.map((l) => l.bbox)) : undefined;
  return { band, title, number, numberSpan: pick ? [pick.x0, pick.x1] : undefined, titleBox: box };
}

/**
 * 一个字被识别读成两个（CTC 在一个宽字形里前后两段各出一类：「我们神」读成「我们门神」）：
 * 相邻两字横坐标之差不到本框汉字字距中位的 0.35 倍，后一个是同一个字形的重读，去掉。
 */
function dedupeChars(l: OcrLine): string {
  const ch = l.chars;
  if (!ch || ch.length !== l.text.length) return l.text;
  const steps: number[] = [];
  for (let k = 1; k < ch.length; k++) if (CJK.test(ch[k].text) && CJK.test(ch[k - 1].text)) steps.push(ch[k].cx - ch[k - 1].cx);
  steps.sort((a, b) => a - b);
  const pitch = steps.length >= 2 ? steps[steps.length >> 1] : 0;
  if (!pitch) return l.text;
  let out = "", prev = -Infinity;
  for (const c of ch) {
    if (CJK.test(c.text) && c.cx - prev < pitch * 0.35) continue;
    out += c.text;
    if (CJK.test(c.text)) prev = c.cx;
  }
  return out;
}

function unionBox(rs: readonly Rect[]): Rect {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}

/**
 * 疏排标题（「二　十　心」）检测切成一字一框，框又裁得紧，单字识别很差（「二」读成「IL」、「十」读成「士」）。
 * 把曲名整段（首框到末框）裁成一条、四周垫白再识别一次；读出的汉字不少于原来的字数就用它。
 */
async function rereadTitle(bin: Binary, box: Rect, ocr: OcrBackend): Promise<string | null> {
  if (!ocr.recognizeTexts) return null;
  const x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y));
  const w = Math.min(bin.w, Math.round(box.x + box.w)) - x0, h = Math.min(bin.h, Math.round(box.y + box.h)) - y0;
  if (w <= 0 || h <= 0) return null;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) ink.set(bin.data.subarray((y0 + y) * bin.w + x0, (y0 + y) * bin.w + x0 + w), y * w);
  const [t] = await ocr.recognizeTexts([surfaceFromInk(w, h, ink, Math.round(h * 0.25))]);
  return t ? (t.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).join("") : null;
}

function overlapY(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

/**
 * 目录页整页 OCR → 条目。一条 = 文字 + 曲号 + 页码（「天使歌声 59 46」）。检测常把文字与数字切成两框、
 * 两个数又时分时合（「5946」「346」「267」），故先按纵向位置聚成行、行内按横坐标排，
 * 数字框再按字距拆数（字距大于全页数内字距中位的 1.6 倍就断开）。文字后跟 ≥2 个数 → 取末两个为曲号、页码；
 * 经文目录「经文 首句 曲号 页码」同样适用。
 */
export function parseToc(lines: OcrLine[]): TocEntry[] {
  const isNum = (t: string) => /^[\s\d]+$/.test(t) && /\d/.test(t);
  // 全页数内字距：数字框里相邻两字的横距中位
  const steps: number[] = [];
  for (const l of lines) {
    if (!isNum(l.text) || !l.chars || l.chars.length !== l.text.length) continue;
    const cs = l.chars.filter((c) => /\d/.test(c.text));
    for (let k = 1; k < cs.length; k++) steps.push(cs[k].cx - cs[k - 1].cx);
  }
  steps.sort((a, b) => a - b);
  const pitch = steps.length ? steps[Math.floor(steps.length * 0.3)] : 0;

  const hs = lines.map((l) => l.bbox.h).sort((a, b) => a - b);
  const tol = (hs[Math.floor(hs.length / 2)] ?? 40) * 0.5;
  const rows: OcrLine[][] = [];
  for (const l of [...lines].sort((a, b) => cyOf(a) - cyOf(b))) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(cyOf(l) - cyOf(row[0])) <= tol) row.push(l);
    else rows.push([l]);
  }

  const out: TocEntry[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.bbox.x - b.bbox.x);
    let text = "";
    let nums: number[] = [];
    const flush = () => {
      const t = text.replace(/[\s*＊—–\-.…·]+/g, " ").trim();
      if (CJK.test(t) && nums.length >= 2) out.push({ text: t, number: nums[nums.length - 2], page: nums[nums.length - 1] });
      text = ""; nums = [];
    };
    for (const l of row) {
      if (isNum(l.text)) nums.push(...splitNumbers(l, pitch));
      else {
        // 文字框尾巴上粘着的数（「主啊我赞美 1」）
        const m = /^(.*?[^\d\s])\s*([\d\s]*\d)$/.exec(l.text);
        if (nums.length) flush();
        if (m && CJK.test(m[1])) { text += m[1]; nums.push(...m[2].trim().split(/\s+/).map(Number)); }
        else text += l.text;
      }
    }
    flush();
  }
  // 只列「曲号 曲名」、不带页码的目录（两栏排：「1 至于我　29 神啊我心坚定」）：曲号在前、紧跟汉字。
  // 按「文字 + 两个数」认出的条目不到它的一半才改用它（那种目录里每条也是「数 + 字」开头的，别抢）
  const lead = numberFirstToc(rows);
  return lead.length > out.length * 2 ? lead : out;
}

/** 「曲号 曲名」式目录行：数字框后接汉字框，或一个框里数在前、字在后。 */
function numberFirstToc(rows: readonly OcrLine[][]): TocEntry[] {
  const out: TocEntry[] = [];
  for (const row of rows) {
    let num: number | undefined;
    for (const l of row) {
      const t = l.text.trim();
      if (/^\d{1,4}$/.test(t)) { num = Number(t); continue; }
      const m = /^(\d{1,4})\s*(\D.*)$/.exec(t);
      const [n, text] = m ? [Number(m[1]), m[2]] : [num, t];
      num = undefined;
      const name = text.replace(/[\s*＊—–\-.…·]+/g, "").replace(/\d+$/, "");
      if (n !== undefined && CJK.test(name)) out.push({ text: name, number: n });
    }
  }
  return out;
}

function cyOf(l: OcrLine): number { return l.bbox.y + l.bbox.h / 2; }

/** 一个纯数字框 → 若干数：空格处断，字距明显大于数内字距处也断。 */
function splitNumbers(l: OcrLine, pitch: number): number[] {
  const out: number[] = [];
  const ch = l.chars && l.chars.length === l.text.length ? l.chars : null;
  let cur = "";
  let prevX = -Infinity;
  for (let k = 0; k < l.text.length; k++) {
    const c = l.text[k];
    if (!/\d/.test(c)) { if (cur) out.push(Number(cur)); cur = ""; prevX = -Infinity; continue; }
    const x = ch ? ch[k].cx : NaN;
    if (cur && ch && pitch > 0 && x - prevX > pitch * 1.6) { out.push(Number(cur)); cur = ""; }
    cur += c;
    prevX = x;
  }
  if (cur) out.push(Number(cur));
  return out;
}
