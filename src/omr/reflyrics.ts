// 参照歌词互证：拿同一首诗歌的歌词文本（歌本配套的 .txt / .lrc）与识别出的歌词逐字对照——
//   形近字按参照选字、补回漏读的字；两边对不上的（版本用字、字多字少、一字多音却没认出弧、
//   反复顺序对不上）只报告，不擅改。
//
// **参照是按演唱顺序写全的**：反复段、每段后的副歌都照唱写一遍，谱面却只印一遍、多段叠在下面。
// 所以先把识别结果按演唱顺序展开（与展开档排版、试听同一条路：recognizedToDoc → jianpuInputOfDoc
// → walkPlay），再与参照整篇对齐；展开不出来或展开后反而对不上时，退回谱面印的顺序（逐段串起各谱行）。
//
// 挂在 jianpu.ts 的歌词落位之后、弧裁决与「有词的 0」复原之前：补上的字要喂给那几步（都看音符有没有词）。
// **无 DOM 依赖**（Node CLI 要 import 它）。
import type { JpNum, LyricCheck, LyricCheckItem, RecognizedScore, StaffRow } from "../omrkit/types";
import { rcx } from "../omrkit/types";
import type { LyricCharRef, LyricHooks } from "./lyrics";
import { simplifiedOf } from "./hanvariant";
import { recognizedToDoc } from "./todoc";
import type { ElementId } from "../model/doc";
import { jianpuInputOfDoc } from "../model/jianpuinput";
import type { JChord } from "../layout/input";
import { walkPlay } from "../jianpu/expand";
import { probe } from "./probe";

const isHanzi = (c: string) => /[一-鿿]/.test(c);
/** 比较口径：繁简归一（繁体谱对简体词不算不同）。 */
const normCh = (c: string) => simplifiedOf(c) ?? c;

// ───────────────────────── 参照歌词解析 ─────────────────────────

export interface RefToken {
  ch: string;
  norm: string;
  /** 所在那一句（报告里给人对照；太长时只截该字前后一段） */
  line: string;
}

/** 报告里的参照句：一行太长（整段不分行的歌词）时截该字前后各 12 字 */
function contextOf(line: string, pos: number): string {
  const cs = [...line];
  if (cs.length <= 30) return line;
  const a = Math.max(0, pos - 12), b = Math.min(cs.length, pos + 13);
  return (a > 0 ? "…" : "") + cs.slice(a, b).join("") + (b < cs.length ? "…" : "");
}

// 结构标注：`(副歌)`、`【副歌】`、`[Chorus]`、`副歌：`、单独一行的 `1.` / `一、`
const LABEL_RE = /^(?:副歌|副|和|合|间奏|尾声|结尾|重复|重唱|独唱|齐唱|合唱|领|众|男|女|男声|女声|chorus|refrain|verse|bridge|coda|intro|outro|ending)\s*\d*$/i;
// lrc 与歌词站的信息行
const META_RE = /^(?:歌曲|歌名|曲名|专辑|作词|作曲|词|曲|词曲|演唱|歌手|编曲|原唱|ti|ar|al|by|offset)\s*[:：]/i;
const LRC_TS = /\[(\d+):(\d+(?:\.\d+)?)\]/g;

/** 歌词文本 → 逐字 token（只收汉字；标点、段号、结构标注、lrc 时间戳与信息行都去掉）。
 *  lrc 一句带几个时间戳 = 这句唱几遍，按时间展开排序（就是演唱顺序）。 */
export function parseRefLyrics(text: string): RefToken[] {
  let lines = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  if (lines.some((l) => /^\s*\[\d+:\d+/.test(l))) {
    const timed: { t: number; s: string }[] = [];
    for (const l of lines) {
      const ts = [...l.matchAll(LRC_TS)];
      const s = l.replace(LRC_TS, "");
      for (const m of ts) timed.push({ t: Number(m[1]) * 60 + Number(m[2]), s });
    }
    timed.sort((a, b) => a.t - b.t);
    lines = timed.map((x) => x.s);
  }
  const out: RefToken[] = [];
  for (const raw of lines) {
    let l = raw.trim();
    if (!l || /^\[[a-z]+:.*\]$/i.test(l) || META_RE.test(l)) continue;
    // 括起来的结构标注整个去掉；括号里是词（`(阿们)`）的保留
    l = l.replace(/[(（【[<《]\s*([^)）】\]>》]{1,8}?)\s*[)）】\]>》]/g,
      (m, inner: string) => (LABEL_RE.test(inner.trim()) || /^(?:\d+|[一二三四五六七八九十]+)$/.test(inner.trim()) ? "" : m));
    // 行首的结构标注：`副歌：` `副)` `副）`（只有半边括号，上面那条配不上）
    l = l.replace(/^[（(]?\s*(?:副歌|副|和|合|chorus|refrain)\s*[:：)）]\s*/i, "");
    l = l.replace(/^\s*(?:\d{1,2}|[一二三四五六七八九十])\s*[.．、:：)）]\s*/, "");   // 行首段号 `1.` `一、`
    l = l.replace(/^\s*\d{1,2}\s+(?=[一-鿿])/, "");                                   // `1 我主…`
    l = l.trim();
    if (!l || LABEL_RE.test(l)) continue;
    [...l].forEach((c, pos) => { if (isHanzi(c)) out.push({ ch: c, norm: normCh(c), line: contextOf(l, pos) }); });
  }
  return out;
}

// ───────────────────────── 识别侧序列 ─────────────────────────

/** 识别侧序列的一项：一个汉字，或一个没有词的音（空位）。同一 (音符, 段) 可因反复出现多次。 */
interface Item {
  n: JpNum;
  verse: number;
  /** 该段歌词串里第几个汉字（空位为 -1） */
  idx: number;
  ch: string | null;
  norm: string | null;
  /** 空位在弧/连音线的延续里：本就不该有新字（一字多音） */
  held: boolean;
  /** 空位所在谱行这一段整行没词（房外只印一行、器乐行……）：不能往上补字 */
  absent: boolean;
}

interface NoteLoc { row: number; note: number; bar: number; rowRef: StaffRow }

/** 音符 → 谱行/行内序/小节号（小节按行内小节线数，跨行小节不细究，只供报告定位）。 */
function locate(rows: readonly StaffRow[]): Map<JpNum, NoteLoc> {
  const out = new Map<JpNum, NoteLoc>();
  const barBase = new Map<number, number>();              // 每个声部各自数小节
  rows.forEach((r, ri) => {
    const voice = r.voice ?? 0;
    const base = barBase.get(voice) ?? 0;
    r.nums.forEach((n, ni) => {
      const cx = rcx(n.bbox);
      out.set(n, { row: ri, note: ni, bar: base + 1 + r.barlineXs.filter((x) => x < cx).length, rowRef: r });
    });
    const lastX = r.nums.length ? rcx(r.nums[r.nums.length - 1]!.bbox) : 0;
    barBase.set(voice, base + r.barlineXs.filter((x) => x < lastX).length + (r.barlineXs.some((x) => x > lastX) ? 1 : 0));
  });
  return out;
}

/** 弧/连音线的延续音（不是起音）：在一条还开着的 slur 里，或是 tie 的收尾。 */
function heldNotes(rows: readonly StaffRow[]): Set<JpNum> {
  const held = new Set<JpNum>();
  const depth = new Map<number, number>();
  for (const r of rows) {
    const v = r.voice ?? 0;
    let d = depth.get(v) ?? 0;
    for (const n of r.nums) {
      if (d > 0 || n.tieStop || n.slurStop) held.add(n);
      d = Math.max(0, d + (n.slurStart ?? 0) - (n.slurStop ?? 0));
    }
    depth.set(v, d);
  }
  return held;
}

function itemBuilder(locs: Map<JpNum, NoteLoc>, held: Set<JpNum>) {
  const out: Item[] = [];
  const rowHas = (r: StaffRow, v: number) => r.nums.some((n) => (n.lyrics?.[v] ?? "") !== "");
  const push = (n: JpNum, verse: number, text: string | undefined, rest: boolean) => {
    const hz = [...(text ?? "")].filter(isHanzi);
    if (hz.length) {
      hz.forEach((c, idx) => out.push({ n, verse, idx, ch: c, norm: normCh(c), held: false, absent: false }));
      return;
    }
    if (text && /[A-Za-z]/.test(text)) return;         // 英文音节 v1 不参与对齐
    if (rest || n.digit === 0) return;                  // 休止不占字
    const loc = locs.get(n);
    out.push({ n, verse, idx: -1, ch: null, norm: null, held: held.has(n), absent: !loc || !rowHas(loc.rowRef, verse) });
  };
  return { out, push };
}

/** 按演唱顺序展开（与展开档同口径：第 pass 遍唱第 pass 段、副歌每遍都唱）。展开不出来返回 null。 */
function expandedItems(score: RecognizedScore, locs: Map<JpNum, NoteLoc>, held: Set<JpNum>): Item[] | null {
  const numOf = new Map<ElementId, JpNum>();
  let js;
  try {
    js = jianpuInputOfDoc(recognizedToDoc(score, numOf), { forExpanded: true });
  } catch {
    return null;
  }
  const measures = js?.parts[0]?.measures;
  if (!js || !measures || !js.playData.measures.length) return null;
  const { out, push } = itemBuilder(locs, held);
  walkPlay(js.playData.measures, {
    measure: (mid, pass, cut) => {
      const m = measures[mid];
      if (!m) return;
      let chords = m.entries.filter((e): e is JChord => e.kind === "chord").sort((a, b) => a.position.compareTo(b.position));
      if (cut.skip) chords = chords.slice(cut.skip);
      if (cut.limit >= 0) chords = chords.slice(0, cut.limit);
      const p = Math.max(1, pass);
      for (const ch of chords) {
        const n = ch.id !== null ? numOf.get(ch.id) : undefined;
        if (!n) continue;
        const ls = ch.notes[0]?.lyrics ?? [];
        const l = ls.find((x) => x.number === p) ?? ls.find((x) => x.refrain);
        let verse = p - 1;
        if (l) {
          const at = n.lyrics?.[l.number - 1] === l.text ? l.number - 1 : (n.lyrics ?? []).indexOf(l.text);
          verse = at >= 0 ? at : l.number - 1;
        }
        push(n, verse, n.lyrics?.[verse], ch.rest);
      }
    },
    passEnd: () => {},
  });
  return out;
}

/** 谱面印的顺序：第 1 段从头到尾，再第 2 段……（不展开反复）。 */
function printedItems(rows: readonly StaffRow[], locs: Map<JpNum, NoteLoc>, held: Set<JpNum>): Item[] {
  const { out, push } = itemBuilder(locs, held);
  const nv = Math.max(0, ...rows.flatMap((r) => r.nums.map((n) => n.lyrics?.length ?? 0)));
  for (let v = 0; v < nv; v++) {
    for (const r of rows) {
      if (!r.nums.some((n) => n.lyrics?.[v])) continue;   // 这一段整行没词的谱行不进来
      for (const n of r.nums) push(n, v, n.lyrics?.[v], n.digit === 0);
    }
  }
  return out;
}

// ───────────────────────── 对齐 ─────────────────────────

const SAME = 2, SUB = -1, FILL = -1, GAP_OPEN = -3, GAP_EXT = -0.5;
const NEG = -1e9;
/** 一对：a = 识别侧下标（-1 = 参照多出的字），b = 参照下标（-1 = 识别侧多出的项）。 */
type Pair = [number, number];

/** 全局对齐（Gotoh 仿射缺口）：参照首尾免罚（参照常多写标题、多写谱面没印的段）。
 *  缺口按段计：参照里整段副歌/衬词（「嘿！嘿！…」）识别侧没有时，一段缺口比逐字硬配便宜，不会把真词拉歪。
 *  识别侧空位（没词的音）跳过不罚，只在参照恰好多出字时拿来补（FILL 比开一个缺口便宜）。 */
function align(a: readonly Item[], b: readonly RefToken[]): { pairs: Pair[]; score: number } {
  const m = a.length, k = b.length, W = k + 1, N = (m + 1) * W;
  // 三个状态：0 = 上一步配对，1 = 上一步跳过识别项（↑），2 = 上一步跳过参照字（←）
  const S = [new Float64Array(N).fill(NEG), new Float64Array(N).fill(NEG), new Float64Array(N).fill(NEG)];
  const T = [new Uint8Array(N), new Uint8Array(N), new Uint8Array(N)];     // 各状态的来路状态
  S[0]![0] = 0;
  const best3 = (idx: number, add: [number, number, number]): [number, number] => {
    let bv = NEG, bs = 0;
    for (let s = 0; s < 3; s++) { const v = S[s]![idx]! + add[s]!; if (v > bv) { bv = v; bs = s; } }
    return [bv, bs];
  };
  for (let i = 0; i <= m; i++) {
    const it = i > 0 ? a[i - 1]! : null;
    const endRow = i === 0 || i === m;               // 参照首尾免罚
    for (let j = 0; j <= k; j++) {
      const c = i * W + j;
      if (i === 0 && j === 0) continue;
      if (i > 0 && j > 0) {
        const pair = it!.ch !== null ? (it!.norm === b[j - 1]!.norm ? SAME : SUB) : it!.absent ? NEG : FILL;
        const [v, s] = best3((i - 1) * W + j - 1, [pair, pair, pair]);
        S[0]![c] = v; T[0]![c] = s;
      }
      if (i > 0) {
        // 空位跳过不罚、也不算开缺口；汉字跳过按段计
        const add: [number, number, number] = it!.ch === null ? [0, 0, 0] : [GAP_OPEN, GAP_EXT, GAP_OPEN];
        const [v, s] = best3((i - 1) * W + j, add);
        S[1]![c] = v; T[1]![c] = s;
      }
      if (j > 0) {
        const add: [number, number, number] = endRow ? [0, 0, 0] : [GAP_OPEN, GAP_OPEN, GAP_EXT];
        const [v, s] = best3(i * W + j - 1, add);
        S[2]![c] = v; T[2]![c] = s;
      }
    }
  }
  const fin = best3(m * W + k, [0, 0, 0]);
  const score = fin[0];
  let st = fin[1];
  const pairs: Pair[] = [];
  let i = m, j = k;
  while (i > 0 || j > 0) {
    const prev = T[st]![i * W + j]!;
    if (st === 0) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (st === 1) { pairs.push([i - 1, -1]); i--; }
    else { pairs.push([-1, j - 1]); j--; }
    st = prev;
  }
  pairs.reverse();
  return { pairs, score };
}

const matchedOf = (a: readonly Item[], b: readonly RefToken[], pairs: readonly Pair[]) =>
  pairs.filter(([i, j]) => i >= 0 && j >= 0 && a[i]!.ch !== null && a[i]!.norm === b[j]!.norm).length;

// ───────────────────────── 判定 ─────────────────────────

// 版本用字（各歌本编辑取舍不同，不是识别错）：只报、不按参照改
const VARIANT_GROUPS = ["他祂她牠它", "你祢妳您", "那哪", "阿啊", "于於与", "像象", "的得地", "惟唯", "藉借", "着著", "么吗嘛", "哦喔噢", "耶爷"];
const isVariant = (x: string, y: string) => VARIANT_GROUPS.some((g) => g.includes(x) && g.includes(y));
/** 参照字在该字 OCR 候选里、且得分不低于首选的这个比例，才算「形近」、按参照改。
 *  按歌词库 787 首里 336 处「参照字在候选里」逐个看图定的（见 docs/实现/OMR-简谱识别.md）：0.05 是拐点——
 *  往下立刻混进歌词文本自己的错字（態→熊 0.040、人→入 0.043），往上提到 0.1 白丢 11 处改对。 */
const ALT_SCORE_RATIO = 0.05;
/** 人称代词组：谱面用不用「祂/祢」（称神的特殊字形）以谱面为准，参照的写法常与谱面不同 */
const PRONOUN_GROUPS = ["他祂", "你祢"];
const PRONOUN_SPECIAL = "祂祢";
/** OCR 把「祂/祢」读成的形近字。「他/你」是常用字、很少被读成这些字，所以识别出它们、参照又作他/你/祂/祢时，
 *  图上几乎一定是「祂/祢」——哪怕本页的「祂/祢」全被读错、按页计数数不出来（《人若渴了》通篇读成「池」） */
const SPECIAL_MISREADS: Record<string, string> = { 祂: "池袍袖施社弛祀衪地", 祢: "称袮弥" };
/** 本页一字多音的音里印了弧的至少占这么多，才把没弧的报「疑漏弧」 */
const SLUR_PAGE_RATIO = 0.8;
/** 整首同字率低于此值：词不对题（选错了歌词文件、版本差太多），不做任何改动 */
const MIN_MATCH_RATIO = 0.5;

/**
 * 形近又常被歌词文件写错的几组字，按常见词组定字：「己 / 已 / 巳」「人 / 入」「儆 / 做」「瞎 / 唐」。
 * 歌词库里这几处参照常是错字（「舍已」「自已」「他巳」「出死人生」「进人他的门」「做醒」「唐眼」），
 * 只能看上下文。判不出来返回 undefined（交给候选与参照）。
 * `prev2 prev [本字] next`，`end` = 本字后面紧跟标点或到了行尾。
 */
const PHRASE_CHARS = "己已巳人入儆做瞎唐徬傍";
export function charByPhrase(ch: string, prev2: string, prev: string, next: string, end: boolean): string | undefined {
  if ("己已巳".includes(ch)) return jiYiByPhrase(prev2, prev, next, end) ?? (ch === "巳" ? "已" : undefined);
  if ("人入".includes(ch)) {
    if (prev === "死" && next === "生") return "入";                  // 出死入生
    if (prev2 + prev === "免得") return "入";                         // 免得入了迷惑
    if ("进深陷投加侵涌纳渗步归流".includes(prev) && prev) return "入";   // 进入、深入、陷入、投入、加入、归入、流入……
    if ("世众罪爱敌外穷圣义恶女男别旁凡个每".includes(prev) && prev) return "人";
    if ("们类".includes(next) && next) return "人";
    return undefined;
  }
  if ("儆做".includes(ch)) return next === "醒" ? "儆" : undefined;   // 儆醒
  if ("瞎唐".includes(ch)) return "眼子".includes(next) && next ? "瞎" : undefined;   // 瞎眼、瞎子
  if ("徬傍".includes(ch)) return next === "徨" ? "徬" : undefined;   // 徬徨（「傍徨」不成词）
  return undefined;
}

function jiYiByPhrase(prev2: string, prev: string, next: string, end: boolean): "己" | "已" | undefined {
  if (next === "经") return "已";                                    // 已经
  if (prev === "自") return (prev2 === "能" || prev2 === "不") && end ? "已" : "己";   // 不能自已、情不自已；其余自己
  if ("舍克律知利异虚".includes(prev) && prev) return "己";          // 舍己、克己、律己、知己、利己、异己、虚己
  if ("身任意".includes(next) && next) return "己";                  // 己身、己任、己意（不收「见」：「我已见」也常见）
  if ("然往久".includes(next) && next) return "已";                  // 已然、已往、已久
  if ("早而业".includes(prev) && prev) return "已";                  // 早已、而已、业已
  if (prev === "不" && end) return "已";                             // 不已
  return undefined;
}

/** 在一段歌词串里把第 idx 个汉字换成 ch（开引号前缀、尾随标点原样保留）。 */
function replaceHanzi(text: string, idx: number, ch: string): string {
  let k = -1;
  return [...text].map((c) => (isHanzi(c) && ++k === idx ? ch : c)).join("");
}

/**
 * 参照歌词与识别结果互证：改形近字、补漏字，其余不一致只报告。直接改 `score.rows` 里各音符的 `lyrics`
 * （与叠加框的 text），返回核对结果（也挂到调用方的 `score.lyricCheck`）。
 */
export async function applyRefLyrics(score: RecognizedScore, refText: string, hooks: LyricHooks): Promise<LyricCheck> {
  const ref = parseRefLyrics(refText);
  const rows = score.rows;
  const locs = locate(rows);
  const held = heldNotes(rows);
  const items: LyricCheckItem[] = [];
  const at = (n: JpNum, extra: Partial<LyricCheckItem> = {}): Partial<LyricCheckItem> => {
    const l = locs.get(n);
    return l ? { row: l.row, note: l.note, bar: l.bar, bbox: n.bbox, ...extra } : { bbox: n.bbox, ...extra };
  };

  const printed = printedItems(rows, locs, held);
  const expanded = expandedItems(score, locs, held);
  const pAl = align(printed, ref);
  const eAl = expanded ? align(expanded, ref) : null;
  const pM = matchedOf(printed, ref, pAl.pairs);
  const eM = eAl ? matchedOf(expanded!, ref, eAl.pairs) : -1;
  // 两种顺序按 F1 比（同字 ×2 ÷ 两边字数和）：只比同字数不行——展开错了会把同一段唱出好几遍，
  // 同字数照样高，多出来的几百个字却对不上任何参照。
  const hz = (xs: readonly Item[]) => xs.filter((x) => x.ch !== null).length;
  const f1 = (mt: number, xs: readonly Item[]) => (2 * mt) / Math.max(1, hz(xs) + ref.length);
  const pF = f1(pM, printed), eF = expanded ? f1(eM, expanded) : -1;
  // 按演唱顺序展开是正路；展开后反而明显对得更差 → 反复/房号/跳转多半认错，退回谱面顺序并报出来
  let order: LyricCheck["order"] = "expanded";
  let seq = expanded, al = eAl, matched = eM;
  if (!expanded || !eAl || pF > eF + 0.1) {
    if (expanded && eAl) {
      probe("refLyrics.repeatSuspect");
      items.push({ kind: "repeatSuspect", detail: `按演唱顺序展开：同字 ${eM}/识别 ${hz(expanded)} 字；按谱面顺序：同字 ${pM}/识别 ${hz(printed)} 字（参照 ${ref.length} 字）——反复/房号/跳转记号可能认错或漏认` });
    }
    order = "printed"; seq = printed; al = pAl; matched = pM;
  }
  const a = seq!, pairs = al!.pairs;
  const ocrChars = a.filter((x) => x.ch !== null).length;
  const result: LyricCheck = { order, refChars: ref.length, ocrChars, matched, items, unmatchedRef: [] };
  if (!ref.length || !ocrChars || matched < ocrChars * MIN_MATCH_RATIO) {
    items.push({ kind: "noMatch", detail: !ocrChars ? "识别侧没有歌词（谱面无词，或歌词行没认出来），未核对"
      : !ref.length ? "参照里没有汉字歌词，未核对"
      : `同字 ${matched} / 识别 ${ocrChars} 字 / 参照 ${ref.length} 字，词不对题，未做改动` });
    return result;
  }

  // 逐对分类：M 同字 · S 异字 · F 空位对上参照字 · E 空位跳过 · X 识别多出的字 · G 参照多出的字
  type Kind = "M" | "S" | "F" | "E" | "X" | "G";
  const kinds: Kind[] = pairs.map(([i, j]) => (i < 0 ? "G" : a[i]!.ch === null ? (j < 0 ? "E" : "F")
    : j < 0 ? "X" : a[i]!.norm === ref[j]!.norm ? "M" : "S"));
  // 不一致的「段」= 连续的非同字对（空位夹在中间不断段）。段里至多两处、且两头都贴着同字，才逐字处理（改/补/报）——
  // 左右都对上了，中间这一两个字才可信地一一对应；否则是整句对不上（版本不同、识别大错），整段合成一条报告、不改。
  const anchored = new Uint8Array(pairs.length);
  // 锚定段编号：一段里改了一个字、却还有别的字对不上（参照多出、识别多出、改不了的异字），说明歌词在这里本身可能写乱了，
  // 改动标「待复查」（「是我们」对「是捌门」：们→门 改了，我↔捌 改不了）
  const runOf = new Int32Array(pairs.length).fill(-1);
  let runN = 0;
  const segItems = new Map<string, LyricCheckItem>();
  const hanziOf = (t0: number, t1: number) => pairs.slice(t0, t1).filter(([i]) => i >= 0 && a[i]!.ch !== null).map(([i]) => a[i]!.ch!).join("");
  const refOf = (t0: number, t1: number) => pairs.slice(t0, t1).filter(([, j]) => j >= 0).map(([, j]) => ref[j]!.ch).join("");
  const clip = (x: string) => (x.length > 40 ? x.slice(0, 40) + "…" : x);
  let seenM = false;
  for (let t = 0; t < pairs.length;) {
    if (kinds[t] === "M" || kinds[t] === "E") { if (kinds[t] === "M") seenM = true; t++; continue; }
    let u = t;
    while (u < pairs.length && kinds[u] !== "M") u++;
    let end = u;
    while (end > t && kinds[end - 1] === "E") end--;
    const ks = kinds.slice(t, end).filter((x) => x !== "E");
    if (ks.length <= 2 && seenM && u < pairs.length) { anchored.fill(1, t, end); runOf.fill(runN++, t, end); t = u; continue; }
    if (ks.every((x) => x === "G")) {
      const js = pairs.slice(t, end).map(([, j]) => j);
      result.unmatchedRef.push({ from: js[0]!, to: js[js.length - 1]! + 1, text: clip(refOf(t, end)) });
    } else {
      const first = pairs.slice(t, end).find(([i]) => i >= 0);
      const it = first ? a[first[0]]! : undefined;
      const firstRef = pairs.slice(t, end).find(([, j]) => j >= 0);
      const ocr = clip(hanziOf(t, end)), rf = clip(refOf(t, end));
      const x: LyricCheckItem = ks.every((q) => q === "X")
        ? { kind: "extraChar", ...(it ? { verse: it.verse, ...at(it.n) } : {}), ocr, detail: "识别出参照里没有的一段" }
        : { kind: "mismatch", ...(it ? { verse: it.verse, ...at(it.n) } : {}), ocr, ref: rf,
          context: firstRef ? ref[firstRef[1]]!.line : undefined, detail: "整句对不上（版本不同或识别错得多），未改" };
      const key = `${x.kind}|${x.row}|${x.verse}|${x.note}|${ocr}|${rf}`;
      if (!segItems.has(key)) segItems.set(key, x);
    }
    t = u;
  }
  items.push(...segItems.values());

  // 同一 (音符, 段, 字) 在展开序列里可出现多次（副歌回唱）：各次对到的参照字汇总后再判；有一次落在整句不对的段里就不逐字处理
  const keyOf = (it: Item): string => `${locs.get(it.n)?.row}:${locs.get(it.n)?.note}:${it.verse}:${it.idx}`;
  const hits = new Map<string, { it: Item; refs: number[]; inSeg: boolean }>();

  // 形近又常被歌词写错的几组字先按词组定（见 charByPhrase）；定下来的不再走下面的逐字判定
  const phraseDone = new Set<string>();
  const resolved = new Map<string, LyricCheckItem>();              // 已改/已补的字 → 那一条
  const runKeys = new Map<number, { keys: Set<string>; hasG: boolean }>();
  const inRun = (t: number, key: string | null) => {
    const id = runOf[t]!;
    if (id < 0) return;
    const r = runKeys.get(id) ?? { keys: new Set<string>(), hasG: false };
    if (key === null) r.hasG = true; else r.keys.add(key);
    runKeys.set(id, r);
  };
  {
    const refAt = new Map<number, number>();
    for (const [i, j] of pairs) if (i >= 0 && j >= 0) refAt.set(i, j);
    const hzIdx = a.map((x, i) => (x.ch !== null ? i : -1)).filter((i) => i >= 0);
    hzIdx.forEach((ai, q) => {
      const it = a[ai]!;
      if (!PHRASE_CHARS.includes(it.ch!)) return;
      const key = keyOf(it);
      if (phraseDone.has(key)) return;
      const chAt = (d: number) => { const x = hzIdx[q + d]; return x !== undefined ? a[x]!.ch! : ""; };
      const text = it.n.lyrics?.[it.verse] ?? "";
      let k = -1, after = "";
      for (const c of text) { if (isHanzi(c)) k++; else if (k === it.idx) after += c; }
      const end = /[，。、；：！？…,;:!?]/.test(after) || q === hzIdx.length - 1;
      const want = charByPhrase(it.ch!, chAt(-2), chAt(-1), chAt(1), end);
      if (!want) return;
      phraseDone.add(key);
      const j = refAt.get(ai);
      const refCh = j !== undefined ? ref[j]! : undefined;
      const phrase = `${chAt(-1)}${want}${chAt(1)}`;
      if (want !== it.ch) {
        probe("refLyrics.phrase");
        it.n.lyrics![it.verse] = replaceHanzi(text, it.idx, want);
        const region = hooks.regionOf({ n: it.n, verse: it.verse, idx: it.idx });
        if (region) region.text = replaceHanzi(region.text, 0, want);
        const x: LyricCheckItem = { kind: "fixed", verse: it.verse, ...at(it.n), ocr: it.ch!, ref: want, context: refCh?.line,
          charBox: region?.bbox, detail: `按词组「${phrase}」定字${refCh && refCh.ch !== want ? `（歌词作「${refCh.ch}」）` : ""}` };
        items.push(x);
        resolved.set(key, x);
      } else if (refCh && refCh.norm !== want) {
        items.push({ kind: "mismatch", verse: it.verse, ...at(it.n), ocr: it.ch!, ref: refCh.ch, context: refCh.line,
          detail: `按词组「${phrase}」保留「${want}」，歌词这处多是错字` });
        resolved.set(key, items[items.length - 1]!);   // 已按词组定了，不算「还有别的字对不上」
      }
    });
  }
  // 参照多出的一两个字（锚定的 G）：挂到前一个识别项上报「谱上没地方落」
  let pendG: number[] = [];
  let lastA = -1;
  const flushG = () => {
    if (!pendG.length) return;
    const it = lastA >= 0 ? a[lastA]! : undefined;
    items.push({ kind: "missingNote", ...(it ? { verse: it.verse, ...at(it.n) } : {}), ref: pendG.map((j) => ref[j]!.ch).join(""),
      context: ref[pendG[0]!]!.line, detail: "参照在此多出字，谱上没有空着的音可落（漏音、漏字或版本不同）" });
    pendG = [];
  };
  // 一字多音却没认出弧按**音符**报一次：每一段在这个音上都没字才算（有一段有字就不是一字多音）。
  // 只在**本页一字多音大多印了弧**时报：不少谱子（流行体、小册子）一字多音本就不印弧，那样的页逐个报只是噪声。
  const slurSeen = new Set<JpNum>();
  let melHeld = 0, melFree = 0;
  for (const r of rows) {
    if (!r.nums.some((n) => (n.lyrics ?? []).some((t) => [...(t ?? "")].some(isHanzi)))) continue;
    r.nums.forEach((n, ni) => {
      if (ni === 0 || n.digit === 0 || (n.lyrics ?? []).some((t) => [...(t ?? "")].some(isHanzi))) return;
      const prev = r.nums[ni - 1]!;
      if (prev.digit === n.digit && prev.octave === n.octave && !held.has(n)) return;   // 同音延续归 tie，不算
      if (held.has(n)) melHeld++; else melFree++;
    });
  }
  const pageSlurs = melHeld + melFree >= 4 && melHeld >= (melHeld + melFree) * SLUR_PAGE_RATIO;
  pairs.forEach(([i, j], t) => {
    const kd = kinds[t]!;
    if (kd === "G") { if (anchored[t]) { pendG.push(j); inRun(t, null); } return; }
    flushG();
    lastA = i;
    const it = a[i]!;
    if (kd === "E") {
      // 两头都是同字的空位（不在任何不一致段里）：一直没字、不在弧里、不是同音延续（后面的隐含 tie 补检会连上）
      if (!pageSlurs || it.held || it.absent || slurSeen.has(it.n)) return;
      let l = t - 1, r = t + 1;
      while (l >= 0 && kinds[l] === "E") l--;
      while (r < pairs.length && kinds[r] === "E") r++;
      if (l < 0 || r >= pairs.length || kinds[l] !== "M" || kinds[r] !== "M") return;
      const loc = locs.get(it.n);
      const prev = loc && loc.note > 0 ? loc.rowRef.nums[loc.note - 1] : undefined;
      if (!prev || prev.digit === 0 || (prev.digit === it.n.digit && prev.octave === it.n.octave)) return;
      if ((it.n.lyrics ?? []).some((x) => [...(x ?? "")].some(isHanzi))) return;
      slurSeen.add(it.n);
      items.push({ kind: "slurSuspect", verse: it.verse, ...at(it.n), detail: "各段在这个音上都没字、也不在弧里：一字多音的弧可能漏认（谱面本就没印弧的可忽略）" });
      return;
    }
    const key = keyOf(it);
    if (kd !== "M") inRun(t, key);
    const h = hits.get(key) ?? { it, refs: [], inSeg: false };
    if (kd !== "M" && !anchored[t]) h.inSeg = true;
    h.refs.push(j);
    hits.set(key, h);
  });
  flushG();

  // 逐字判定
  const fixReqs: { it: Item; r: RefToken; key: string }[] = [];
  for (const [key, { it, refs, inSeg }] of hits) {
    if (inSeg || phraseDone.has(key)) continue;
    const aligned = refs.filter((j) => j >= 0);
    const refChars = [...new Set(aligned.map((j) => ref[j]!.norm))];
    if (it.ch !== null) {
      if (!aligned.length) {
        items.push({ kind: "extraChar", verse: it.verse, ...at(it.n), ocr: it.ch, detail: "识别出参照里没有的字" });
        continue;
      }
      if (refChars.length === 1 && refChars[0] === it.norm && aligned.length === refs.length) continue;   // 对上了
      if (refChars.length > 1 || aligned.length !== refs.length) {
        items.push({ kind: "mismatch", verse: it.verse, ...at(it.n), ocr: it.ch, ref: refChars.join("/"), context: ref[aligned[0]!]!.line, detail: "唱几遍对到的参照字不一致" });
        continue;
      }
      const r = ref[aligned[0]!]!;
      if (isVariant(it.norm!, r.norm)) {
        items.push({ kind: "variant", verse: it.verse, ...at(it.n), ocr: it.ch, ref: r.ch, context: r.line });
        continue;
      }
      fixReqs.push({ it, r, key });
    } else {
      // 空位：参照在这里有字（各次都对到同一个字）→ 补；弧/连音线里的空位不补，报出来
      if (!aligned.length || refChars.length !== 1 || aligned.length !== refs.length) continue;
      const r = ref[aligned[0]!]!;
      if (it.held) {
        items.push({ kind: "missingNote", verse: it.verse, ...at(it.n), ref: r.ch, context: r.line, detail: "参照在此有字，但这个音在弧/连音线里（弧多认了，或漏读了字）" });
        continue;
      }
      probe("refLyrics.filled");
      const lyr = (it.n.lyrics ??= []);
      for (let v = lyr.length; v < it.verse; v++) lyr[v] = "";
      lyr[it.verse] = r.ch;
      const x: LyricCheckItem = { kind: "filled", verse: it.verse, ...at(it.n), ref: r.ch, context: r.line };
      items.push(x);
      resolved.set(key, x);
    }
  }

  // 本页识别歌词里各代词字形出现几次（选字前统计，不含参照）
  const pageCount = new Map<string, number>();
  for (const r of rows) for (const n of r.nums) for (const t of n.lyrics ?? []) for (const c of t ?? "") {
    if (PRONOUN_GROUPS.some((g) => g.includes(c))) pageCount.set(c, (pageCount.get(c) ?? 0) + 1);
  }
  // 形近字：参照字要在该字的 OCR 候选里才改
  if (fixReqs.length) {
    const reqs: LyricCharRef[] = fixReqs.map(({ it }) => ({ n: it.n, verse: it.verse, idx: it.idx }));
    const alts = await hooks.rankAlts(reqs);
    fixReqs.forEach(({ it, r, key }, q) => {
      const al = alts[q];
      // 参照字是人称代词（他/祂、你/祢）时按谱面取字形：候选里有过门槛的「祂/祢」，且参照本身就写它、或本页已用过它
      // 两次以上，就取它（图上印「祂」、歌词作「他」，OCR 读成「池」「袍」——该改成祂）；否则取参照字。
      // 不按「你/他」的出现次数比：「你们」「他们」里的你、他会把计数拉高（「因为祢的慈爱」被改成「你」）。
      const pro = PRONOUN_GROUPS.find((g) => g.includes(r.norm));
      const top = al?.scores[0] ?? 0;
      const ratioAt = (i: number) => (al && al.scores.length ? (al.scores[i] ?? 0) / Math.max(1e-9, top) : 1);
      let k = -1;
      if (al) {
        const idxOf = (c: string) => al.alts.findIndex((x) => normCh(x) === c);
        if (pro) {
          const special = [...pro].find((c) => PRONOUN_SPECIAL.includes(c))!;
          const ks = idxOf(special), kr = idxOf(r.norm);
          const okAt = (i: number) => i >= 0 && ratioAt(i) >= ALT_SCORE_RATIO;
          const misread = SPECIAL_MISREADS[special]!.includes(it.ch!);
          k = ks >= 0 && misread ? ks
            : okAt(ks) && (r.norm === special || (pageCount.get(special) ?? 0) >= 2) ? ks
            : okAt(kr) ? kr
            : [...pro].map(idxOf).filter(okAt).sort((x, y) => (al.scores[y] ?? 0) - (al.scores[x] ?? 0))[0] ?? -1;
        } else k = idxOf(r.norm);
      }
      // 形近误读定下来的「祂/祢」不看得分比（「池」读得再有把握，图上也不会是「他」）
      const byMisread = !!pro && k >= 0 && PRONOUN_SPECIAL.includes(normCh(al!.alts[k]!)) && SPECIAL_MISREADS[normCh(al!.alts[k]!)]!.includes(it.ch!);
      const ratio = k >= 0 ? (byMisread ? 1 : ratioAt(k)) : 1;
      // 参照多半是歌词文本的错字、不照改的几种：
      //  「巳」歌词里几乎用不到，是「已」的错字；「己」→「已」是把「舍己」「自己」写错（歌词库里没有一例是真的）；
      //  识别出的是本页常用的代词字形（整页的「祢」），参照换成别的字（「求称」）
      const ownPronoun = PRONOUN_GROUPS.some((g) => g.includes(it.norm!)) && (pageCount.get(it.ch!) ?? 0) >= 3 && !pro;
      // 「入」→「人」同理：歌词库把「入」写成「人」极常见（投葡萄入酢、归入天仓），而这一对没有一例是真改对；
      // 该是「人」的由上面的词组判出来（众人、世人），轮不到这里
      const refTypo = r.norm === "巳" || (it.norm === "己" && r.norm === "已") || (it.norm === "入" && r.norm === "人") || ownPronoun;
      const ok = al && k >= 0 && !refTypo && ratio >= ALT_SCORE_RATIO;
      const charBox = hooks.regionOf(reqs[q]!)?.bbox;
      const cand = al && k >= 0 ? { rank: k, score: al.scores[k] ?? 0, top } : undefined;
      if (!ok) {
        items.push({ kind: "mismatch", verse: it.verse, ...at(it.n), ocr: it.ch!, ref: r.ch, context: r.line, charBox, cand,
          detail: !al ? "取不到识别候选（字来自谱后附段等）"
            : k < 0 ? `参照字不在识别候选里（字形不像；候选 ${al.alts.slice(0, 5).join("")}）`
            : refTypo ? (ownPronoun ? `谱面通篇用「${it.ch}」，参照这处多是错字，不照改` : "参照这个字多是歌词文本的错字（巳/已/己、人/入），不照改")
            : `参照字在候选第 ${k + 1} 位但得分太低（${(al.scores[k] ?? 0).toFixed(4)} / 首选 ${top.toFixed(3)}）` });
        return;
      }
      // 用候选里那个字形（谱面是繁体就留繁体、印的是祂就取祂），候选与参照同形时就是参照字
      const ch = al.alts[k]!;
      probe("refLyrics.fixed");
      const text = it.n.lyrics?.[it.verse];
      if (text) it.n.lyrics![it.verse] = replaceHanzi(text, it.idx, ch);
      const region = hooks.regionOf(reqs[q]!);
      if (region) region.text = replaceHanzi(region.text, 0, ch);
      const x: LyricCheckItem = { kind: "fixed", verse: it.verse, ...at(it.n), ocr: it.ch!, ref: ch, context: r.line, charBox: region?.bbox, cand,
        detail: `候选第 ${k + 1} 位（得分 ${(al.scores[k] ?? 0).toFixed(3)}，首选 ${top.toFixed(3)}）`
          + (normCh(ch) !== r.norm ? `；歌词作「${r.ch}」，按谱面取「${ch}」` : "") };
      items.push(x);
      resolved.set(key, x);
    });
  }

  // 待复查：改动所在的锚定段里还有没解释掉的不一致（参照多出的字、改不了的异字、识别多出的字）
  for (const { keys, hasG } of runKeys.values()) {
    const open = hasG || [...keys].some((k) => !resolved.has(k));
    if (!open) continue;
    for (const k of keys) {
      const x = resolved.get(k);
      if (x && (x.kind === "fixed" || x.kind === "filled")) x.review = "同一处还有别的字对不上，歌词这里可能写乱了";
    }
  }

  const order2 = (x: LyricCheckItem) => [x.row ?? -1, x.verse ?? -1, x.note ?? -1];
  items.sort((x, y) => {
    const p = order2(x), q = order2(y);
    return p[0]! - q[0]! || p[1]! - q[1]! || p[2]! - q[2]!;
  });
  return result;
}

/** 报告里一条的可读写法（CLI 打到 stderr 用）。 */
export function formatLyricCheckItem(x: LyricCheckItem): string {
  const LABEL: Record<LyricCheckItem["kind"], string> = {
    fixed: "已改", filled: "已补", variant: "用字不同", mismatch: "不一致", missingNote: "谱上缺位",
    extraChar: "参照没有", slurSuspect: "疑漏弧", repeatSuspect: "疑反复", noMatch: "对不上",
  };
  const where = x.row !== undefined ? `第${x.row + 1}行 第${(x.verse ?? 0) + 1}段 第${(x.note ?? 0) + 1}音（小节${x.bar}）` : "全曲";
  const what = x.ocr !== undefined || x.ref !== undefined ? `：谱面「${x.ocr ?? ""}」→ 歌词「${x.ref ?? ""}」` : "";
  return `[${LABEL[x.kind]}${x.review ? "·待复查" : ""}] ${where}${what}${x.detail ? `  ${x.detail}` : ""}${x.review ? `  ⚠ ${x.review}` : ""}${x.context ? `  〔${x.context}〕` : ""}`;
}

