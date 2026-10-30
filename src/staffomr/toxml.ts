// 识别结果 → MusicXML。对应 musicpp `qtomr/toxml.cpp::Score::exportXml`。
//
// **建树，不拼字符串**：这里用 `score/xmltree.ts::h` 建一棵 MusicXML 树，交给 `model/fromxml.ts::scoreDocFromXml`
// 读成 `ScoreDoc`（表层绑在树上：符干端点、原图位置、识别 id…），再由**唯一的写出端** `model/toxml.ts` 写出文本。
// 读法与读文件同一份，所以识别结果与「把它存成文件再打开」一模一样；写出的子元素次序也由写出端定。
// 树里的子元素仍按 MusicXML 的次序建：写出端不认得的那些（`<stem>`、`<staff-details>`…）按原树里的前后位置回填。
import { h, type XmlEl } from "../score/xmltree";
import { harmonyEl } from "../score/harmonyxml";
import { scoreDocFromXml } from "../model/fromxml";
import { scoreDocToMusicXml } from "../model/toxml";
import type { StaffChord, StaffNote } from "./notedata";
import { clefFor, fifthsAt, timeSignatures, type StaffContext, type TimeSig } from "./notedata";
import type { Bar, SPage, Staff } from "./model";
import type { StaffScore } from "./score";

export interface StaffXmlOptions {
  title?: string;
  /** 每四分音符多少 tick。取 24 能整除 2/3/4/6/8 分音符与三连音。 */
  divisions?: number;
  partId?: string;
  /** 给 `<note>` 写 `id`（编辑器的识别对照按它把模型里的音对回源图坐标）；返回 undefined 不写 */
  noteId?: (n: StaffNote) => string | undefined;
  /** 给 `<slur type="start">` 写 `id`：`markSlurNotes` 的弧号 → 识别对照的 id（跨行接上的后半截写在 `stop` 上）；返回 undefined 不写。
   *  歌词、文字、力度、延音线的 id 记在各自身上（`lyrics[].id`、`words[].id`、`dynamicId`、`tieId`），有就写 */
  arcId?: (arc: string) => string | undefined;
  /** 页眉各条（位图路 OCR 读出的标题、词曲作者），写成曲首页的 `<credit>`；`size` 是字号（pt），
   *  `box` 是它在首个系统那一页上的位置（页面单位），写源谱版面时折成 `default-x` / `default-y` */
  /** 小节号印在哪（`<measure-numbering>`，写在第一声部首小节的 `<print>` 里），见 `score.ts::measureNumbering` */
  measureNumbering?: "system";
  /** `page`：第几页（缺省 1，页脚每页一份） */
  credits?: { text: string; type?: string; justify?: string; size?: number; box?: { x: number; y: number; w: number; h: number }; page?: number }[];
  /** 写源谱版面（`<defaults>` 的纸与谱表大小、各系统首小节的 `<print>`），缺省写。见 `sourceLayout` */
  layout?: boolean;
  /** 跨页的弧按「同音高、紧挨着」判延音线（配对优先配它；只找到一半的，相邻系统同声部紧挨着的音同音高也补成延音线）。
   *  位图路开：延音线行尾行首的半截常认不全。矢量路不开：Finale 直出的谱里跨行同音高相邻两音之间也有记圆滑线的
   *（牵我的手 m24 小提琴 B3→B3），而两种弧长得一样，照判反倒错 */
  crossPageTies?: boolean;
}

/** 本次写出的 `noteId`（`scoreToMusicXml` 进出时设、清；写出是同步的） */
let currentNoteId: StaffXmlOptions["noteId"] | null = null;
let currentArcId: StaffXmlOptions["arcId"] | null = null;

/** 本次写出已写过的识别 id：同一个音分进两个声部时被复制（`{...n}`），挂在它上面的字、弧也跟着写两遍，id 只给头一份 */
const writtenIds = new Set<string>();
/** `id` 属性值（没有、或已写过就不写） */
const idOf = (id: string | undefined): string | undefined => {
  if (!id || writtenIds.has(id)) return undefined;
  writtenIds.add(id);
  return id;
};

/** A4 纸宽（pt）：页面尺寸不可信的页（图片）按页宽 = 它折算 */
const A4_WIDTH_PT = (210 * 72) / 25.4;

/** 页面坐标一个单位合多少 pt：尺寸不可信的页（图片）按页宽 = A4 宽折 */
function ptPerUnit(pg: SPage): number {
  return pg.sizeKnown ? pg.ptPerUnit : A4_WIDTH_PT / pg.width;
}

/** 字号取到半点：识别量出来的高本来就只有这个精度，写多了只是噪声 */
const roundPt = (pt: number) => Math.round(pt * 2) / 2;

/** 某页上量出来的字号（页面单位）→ pt（取到半点）。页眉各条在 `song.ts` 里先折好 */
export function pageTextPt(pg: SPage, size: number): number {
  return roundPt(size * ptPerUnit(pg) * pg.textEm);
}

/** 记在音符上的字号（页面单位）→ pt；量不到返回 undefined */
function textPt(n: StaffNote, size: number | undefined): number | undefined {
  const pg = n.staff?.page;
  if (!size || !(size > 0) || !pg) return undefined;
  const pt = pageTextPt(pg, size);
  return pt > 0 ? pt : undefined;
}

/**
 * 页面上一点 → MusicXML 的纵坐标（tenths，相对这行谱的**顶线**，向上为正）：线距按该处实测的五线（位图路谱线会斜），
 * 一个线距 10 tenths。取整（识别量出来的位置本来就只有这个精度）。
 */
function staffY(st: Staff, x: number, y: number): number {
  const ys = st.lineYsAt?.(x) ?? st.lineYs;
  const sp = ys.length >= 2 ? (ys[ys.length - 1]! - ys[0]!) / (ys.length - 1) : st.stepDistance() * 2;
  return sp > 0 ? Math.round(((ys[0]! - y) * 10) / sp) : 0;
}

/** 页面上的横向距离 → tenths（取整），按这行谱的线距折 */
function staffDx(st: Staff, dx: number): number {
  const sp = st.stepDistance() * 2;
  return sp > 0 ? Math.round((dx * 10) / sp) : 0;
}

/**
 * Bravura 力度字母的墨迹上下沿（线距，基线在 0；取自 `bravura_metadata.json` 的 glyphBBoxes）。
 * 原图量的是墨迹高，换成字号要除以同一串字在 Bravura 里的墨迹高——不能按字体盒（CLAUDE.md「Bravura 的字体盒不能当墨迹盒用」）。
 */
const DYNAMIC_INK: Record<string, [number, number]> = {
  p: [-0.568, 1.096], m: [-0.04, 1.096], f: [-0.608, 1.776], s: [-0.04, 1.092], r: [0, 1.096], z: [-0.04, 1.072], n: [-0.04, 1.096],
};
/** 同上，首字母墨迹左缘离笔位多远（线距）：原图量的是墨迹左缘，`relative-x` 要的是笔位 */
const DYNAMIC_LSB: Record<string, number> = { p: -0.356, m: -0.08, f: -0.564, s: 0, r: -0.08, z: -0.12, n: -0.092 };

/** 写在谱表顶线之上的算「上方」（宣主荣耀人声的 f、mp 印在谱表上方），其余在下方 */
function aboveStaff(st: Staff, x: number, y: number): boolean {
  return staffY(st, x, y) > 0;
}

/** `<direction>` 里的 `<staff>`：每个 direction 各要一个（同一个节点挂不到两处），所以是个工厂 */
type DirStaff = () => XmlEl | null;

/**
 * `<dynamics>`：没量到墨迹框（OCR 读出来的）照旧只写 `placement="below"`；量到了且写源谱版面时，
 * 照原图写上下方、基线（`default-y`）、笔位离符头左缘（`relative-x`）与字号（墨迹高折成 Bravura 的 pt）。
 */
function dynamicEl(n: StaffNote, dirStaff: DirStaff): XmlEl {
  const name = n.dynamic!;
  const b = n.dynamicBox;
  const ink = [...name].map((c) => DYNAMIC_INK[c]).filter((v): v is [number, number] => !!v);
  const pg = n.staff?.page;
  if (!withSourceLayout || !b || !ink.length || !pg) {
    return h("direction", { placement: "below", id: idOf(n.dynamicId) }, h("direction-type", null, h("dynamics", null, h(name))), dirStaff());
  }
  const lo = Math.min(...ink.map((v) => v[0]));
  const hi = Math.max(...ink.map((v) => v[1]));
  // 一个 Bravura 线距合多少页面单位（em = 4 线距）
  const unit = (b.bottom - b.top) / (hi - lo);
  const baseline = b.bottom + lo * unit;
  const pen = b.left - (DYNAMIC_LSB[name[0]!] ?? 0) * unit;
  const pt = roundPt(4 * unit * ptPerUnit(pg));
  const x = n.sym.box.left;
  const pl = aboveStaff(n.staff, x, (b.top + b.bottom) / 2) ? "above" : "below";
  const dyn = h("dynamics", { "default-y": staffY(n.staff, x, baseline), "relative-x": staffDx(n.staff, pen - x), "font-size": pt }, h(name));
  return h("direction", { placement: pl, id: idOf(n.dynamicId) }, h("direction-type", null, dyn), dirStaff());
}

/** `<wedge>` 起点：写源谱版面时照原图写上下方、中线（`default-y`）、左端离符头左缘（`relative-x`）；渐弱的开口（`spread`）写在起点 */
function wedgeStartEl(n: StaffNote, no: number, dirStaff: DirStaff): XmlEl {
  const w = n.wedgeAt;
  if (!withSourceLayout || !w) return h("direction", { placement: "below" }, h("direction-type", null, h("wedge", { number: no, type: n.wedgeStart })), dirStaff());
  const x = n.sym.box.left;
  const pl = aboveStaff(n.staff, w.x0, w.cy) ? "above" : "below";
  const spread = n.wedgeStart === "diminuendo" && w.spread ? staffDx(n.staff, w.spread) : undefined;
  const wedge = h("wedge", { number: no, type: n.wedgeStart, "default-y": staffY(n.staff, w.x0, w.cy), "relative-x": staffDx(n.staff, w.x0 - x), spread });
  return h("direction", { placement: pl }, h("direction-type", null, wedge), dirStaff());
}

/** `<wedge type="stop">`：右端离它所在拍位（`anchorX`：写在音后时是下一个和弦的符头左缘、小节末是小节线）的距离（`relative-x`）；渐强的开口写在止点（MusicXML 的 `spread` 写在开口那一端） */
function wedgeStopEl(n: StaffNote, no: number, dirStaff: DirStaff, anchorX = n.sym.box.left): XmlEl {
  const w = n.wedgeStopAt;
  if (!withSourceLayout || !w) return h("direction", { placement: "below" }, h("direction-type", null, h("wedge", { number: no, type: "stop" })), dirStaff());
  const wedge = h("wedge", { number: no, type: "stop", "relative-x": staffDx(n.staff, w.x1 - anchorX), spread: w.spread ? staffDx(n.staff, w.spread) : undefined });
  return h("direction", { placement: "below" }, h("direction-type", null, wedge), dirStaff());
}

/** 写出源谱版面（符干端点、力度松叶原位）：`scoreToMusicXml` 按 `opts.layout` 设，只在写出时有效 */
let withSourceLayout = false;

const TYPE_OF: [number, string][] = [
  [2, "breve"],
  [1, "whole"],
  [1 / 2, "half"],
  [1 / 4, "quarter"],
  [1 / 8, "eighth"],
  [1 / 16, "16th"],
  [1 / 32, "32nd"],
  [1 / 64, "64th"],
];

/** 基本时值（全音符 = 1）→ MusicXML 的 `<type>`。取最接近的一档。 */
export function noteType(base: number): string {
  let best = "quarter";
  let bd = Infinity;
  for (const [v, name] of TYPE_OF) {
    const d = Math.abs(Math.log2(v) - Math.log2(base || 1 / 4));
    if (d < bd) {
      bd = d;
      best = name;
    }
  }
  return best;
}

const timeEl = (t: TimeSig): XmlEl => h("time", { symbol: t.symbol }, h("beats", null, t.beats), h("beat-type", null, t.beatType));

/** `<barline>`：bar-style → ending → repeat；三项皆空不写。repeat 方向按 location 定（left=forward、right=backward） */
function barlineEl(location: "left" | "right", p: { style?: string | null; repeat?: boolean; ending?: string | null }): XmlEl | null {
  const hasEnding = p.ending !== null && p.ending !== undefined;
  if (!p.style && !hasEnding && !p.repeat) return null;
  return h(
    "barline",
    { location },
    p.style && h("bar-style", null, p.style),
    hasEnding && h("ending", { number: p.ending!, type: location === "left" ? "start" : "stop" }),
    p.repeat && h("repeat", { direction: location === "left" ? "forward" : "backward" }),
  );
}

const forwardEl = (d: number): XmlEl => h("forward", null, h("duration", null, d));
const backupEl = (d: number): XmlEl => h("backup", null, h("duration", null, d));

/**
 * 一个小节里的音符 → `<note>` 等节点，按声部分开写。
 *
 * 两种写法，看 `checkFull` 凑没凑满这一小节（`StaffChord.timed`）：
 *
 * 1. **凑满了**：按和弦的 `offset` 出。声部的第一个音不在小节头时先补 `<forward>`，
 *    中间有空档同样补——多声部的谱面上，第二声部常常从第二拍才起唱，
 *    不补的话它整段前移一拍，回读出来两个声部对不齐。
 * 2. **没凑满**：退回按顺序累加时值（老写法）。没有 offset 可用，只能假定音符
 *    首尾相接；这一小节本来就有音读错了，位置对不齐是次要的。
 *
 * 声部之间用 `<backup>` 把时间倒回小节头（MusicXML 的规矩）。
 *
 * 大谱表（`staffNo` > 0）的声部号在**整个 part 里**编：第 k 行谱的声部 v 写成 `(k-1)*4 + v`
 *（下谱表 5、6，通行写法），且一律写 `<voice>`。各行谱都从 1 编的话，上下谱表的
 * voice 1 被读成同一个声部，拍数自检把两行的时值加在一起（每小节都成了两倍）。
 */
function emitVoices(inBar: StaffNote[], ticks: (d: number) => number, staffNo: number, midClefs: { x: number; el: () => XmlEl }[] = [], barRight?: number): XmlEl[] {
  // **起点不能用 `ticks`**：那个函数有 `Math.max(1, …)` 的下限（时值再短也得占一格），
  // 拿它换算 offset=0 会得到 1，于是每个从小节头起的声部都白白多出一个 1 格的 `<forward>`。
  const at = (dur: number) => Math.round(ticks(1) * dur);
  const body: XmlEl[] = [];
  const timed = inBar.every((n) => n.group?.timed);
  // **没凑满的小节里，跨谱表书写的音并进本行 x 最近那个音的声部**、按 x 排进去：它们另记的声部号单独成一个声部、从小节头写起，
  // 与本行的音落在同一时刻（宁静的伯利恒 p1 m9 钢琴：左手琶音第四个八分 A3 跨到右手谱表，右手的和弦在它之后，读回来成了同时）。
  // 凑满了的小节按 offset 写，不动
  if (!timed && inBar.some((n) => n.crossStaff) && inBar.some((n) => !n.crossStaff)) {
    const own = inBar.filter((n) => !n.crossStaff);
    inBar = inBar
      .map((n) => (n.crossStaff ? { ...n, voice: own.reduce((a, b) => (Math.abs(b.x - n.x) < Math.abs(a.x - n.x) ? b : a)).voice } : n))
      .sort((a, b) => a.x - b.x);
  }
  const split = splitUnisonStems(inBar, ticks);
  inBar = split.notes;
  const voices = [...new Set(inBar.map((n) => n.voice))].sort((a, b) => a - b);
  const withVoice = voices.length > 1 || staffNo > 0;
  const voiceBase = staffNo > 0 ? (staffNo - 1) * 4 : 0;
  // **合成一个 part 的钢琴两行，`<direction>` 也要带 `<staff>`**：不带的话读入端把它算到整个 part（两行都有一份，
  // 或一律落到第一行），松叶两行都用 1 号还会互相套住
  const dirStaff: DirStaff = () => (staffNo ? h("staff", null, staffNo) : null);
  const full = timed ? voiceTicks(inBar, ticks) : 0;
  voices.forEach((v, vi) => {
    const vn = inBar.filter((n) => n.voice === v);
    // 按 offset 出时要按 offset 排：`splitVoice` 之后同一声部的和弦在数组里
    // 未必还是从左到右（贪心分层是跨着挑的）。
    if (timed) vn.sort((a, b) => (a.group!.offset - b.group!.offset) || (b.diatonic - a.diatonic));
    // 不按拍位写时按数组次序，但**同一和弦要挨着、主音打头**：和弦的音在数组里
    // 未必主音在前（《赞美一神》A4/F#4 的 A4 排在前面、带着 `<chord/>`，挂到了前一拍）。
    const grouped = !timed && vn.every((n) => n.group);
    if (grouped) {
      const first = new Map<unknown, number>();
      vn.forEach((n, i) => first.has(n.group) || first.set(n.group, i));
      const idx = new Map(vn.map((n, i) => [n, i]));
      vn.sort((a, b) => first.get(a.group)! - first.get(b.group)! || +!!a.chordExtra - +!!b.chordExtra || idx.get(a)! - idx.get(b)!);
    }
    let cur = 0;
    let prev: StaffNote | null = null;
    let pendingStop: ((anchorX?: number) => XmlEl[]) | null = null;
    const movedLyrics = new Set<NonNullable<StaffNote["lyrics"]>[number]>();
    // 行中换谱号写在第一个声部里、它右边第一个音之前（`<attributes>` 按时间位置对整个谱表生效）
    const clefsLeft = vi === 0 ? midClefs.slice() : [];
    for (const n0 of vn) {
      while (clefsLeft.length && !n0.chordExtra && n0.x > clefsLeft[0].x) body.push(h("attributes", null, clefsLeft.shift()!.el()));
      // **`<chord/>` 按写出的次序定**，不按 `chordExtra`：那个标记是按和弦数组的下标给的
      //（下标 0 的不带），上面按音高重排之后，带标记的常常排到了第一个——
      // `<chord/>` 的意思是「与前一个音同时」，于是和弦的顶音被挂到了**前一拍**上
      //（实测《善牧恩慈歌》每个 SATB 和弦的女高都前移一拍）。
      const extra = timed || grouped ? !n0.grace && !!prev && !prev.grace && prev.group === n0.group : !!n0.chordExtra;
      let n = extra === !!n0.chordExtra ? n0 : { ...n0, chordExtra: extra || undefined };
      prev = n0;
      if (pendingStop && !extra) {
        body.push(...pendingStop(n0.sym.box.left));
        pendingStop = null;
      }
      // **歌词挂到和弦打头写出的那个音上**：字挂在和弦里哪个头上是识别时按位置配的，写出时那个头常带着 `<chord/>`，
      // 而读入端（与多数软件）只认和弦第一个 `<note>` 上的 `<lyric>`，字就丢了（望十架 p7 m57-58 一串八个字）
      if (!extra && !n0.grace && n0.group) {
        const have = new Set((n.lyrics ?? []).map((l) => l.verse));
        const add = vn
          .filter((m) => m !== n0 && m.group === n0.group)
          .flatMap((m) => m.lyrics ?? [])
          .filter((l) => !have.has(l.verse) && (have.add(l.verse), true));
        if (add.length) {
          for (const l of add) movedLyrics.add(l);
          n = { ...n, lyrics: [...(n.lyrics ?? []), ...add] };
        }
      } else if (extra && n.lyrics?.some((l) => movedLyrics.has(l))) n = { ...n, lyrics: n.lyrics.filter((l) => !movedLyrics.has(l)) };
      // 文字指示、速度、力度同理：挂在后写的头上，`<direction>` 落在和弦两个音中间，读回来成了打头那个音之后的时刻（破碎 m107 `rit.` 挪了两拍）
      if (n0.group) {
        const mates = vn.filter((m) => m !== n0 && m.group === n0.group);
        if (!extra) {
          const w = mates.flatMap((m) => m.words ?? []);
          if (w.length) n = { ...n, words: [...(n.words ?? []), ...w] };
          const t = !n.metronome && !n.tempoText ? mates.find((m) => m.metronome || m.tempoText) : undefined;
          if (t) n = { ...n, metronome: t.metronome, tempoText: t.tempoText, tempoSize: t.tempoSize, tempoId: t.tempoId };
          const d = !n.dynamic ? mates.find((m) => m.dynamic) : undefined;
          if (d) n = { ...n, dynamic: d.dynamic, dynamicBox: d.dynamicBox, dynamicSrcBox: d.dynamicSrcBox, dynamicId: d.dynamicId };
        } else n = { ...n, words: undefined, metronome: undefined, tempoText: undefined, tempoId: undefined, dynamic: undefined, dynamicId: undefined };
      }
      // 松叶的起止同理：挂在和弦哪个头上都是这一拍，写在打头的那个音前；挂在后写的头上，`<direction>` 落在和弦中间，
      // 读回来是下一拍（按拍位写时和弦先写最高音，主音不一定打头：破碎 m5、m106、m107）
      if (n0.group) {
        if (!extra) {
          const host = vn.find((m) => m.group === n0.group && m !== n0 && (m.wedgeStart || m.wedgeStop));
          if (host && !n.wedgeStart && !n.wedgeStop)
            n = { ...n, wedgeStart: host.wedgeStart, wedgeAt: host.wedgeAt, wedgeStop: host.wedgeStop, wedgeStopAfter: host.wedgeStopAfter, wedgeStopAt: host.wedgeStopAt };
        } else if (n.wedgeStart || n.wedgeStop) {
          const lead = vn.find((m) => m.group === n0.group);
          if (lead && lead !== n0 && !lead.wedgeStart && !lead.wedgeStop) n = { ...n, wedgeStart: undefined, wedgeAt: undefined, wedgeStop: undefined, wedgeStopAfter: undefined, wedgeStopAt: undefined };
        }
      }
      // 符杠同理：整枚和弦共一根干，杠记在哪个头上都一样，写在打头的那个音上
      if (!extra && n0.group && !n.beam) {
        const bm = vn.find((m) => m.group === n0.group && m.beam)?.beam;
        if (bm) n = { ...n, beam: bm };
      }
      const splitAt = !timed && !n.chordExtra ? split.starts.get(n0) : undefined;
      if (splitAt !== undefined && splitAt > cur) {
        body.push(forwardEl(splitAt - cur));
        cur = splitAt;
      }
      if (timed && !n.chordExtra && !n.grace) {
        const off = at(n.group!.offset);
        if (off > cur) {
          body.push(forwardEl(off - cur));
          cur = off;
        }
      }
      // `<harmony>` 与 `<direction>` 都排在它们所属的 `<note>` **之前**（MusicXML 规定）
      if (n.chord) body.push(harmonyEl(n.chord, 0, textPt(n, n.chordSize)));
      // 音内换和弦：偏移取整到拍（二分及更长的音按四分、短音按八分），谱面上和弦不会落在拍子中间
      for (const hc of n.chordLater ?? []) {
        const grid = n.duration >= 0.5 ? 0.25 : 0.125;
        const off = Math.round((n.duration * hc.frac) / grid) * grid;
        if (off > 0 && off < n.duration) body.push(harmonyEl(hc.text, ticks(off), textPt(n, hc.size)));
      }
      // 速度文字与节拍器印在一条上的（`Andante ♩ = c. 76`）合进同一个 `<direction>`：先文字、后节拍器，一个对象
      if (n.metronome || n.tempoText) {
        const m = n.metronome;
        // 文字后面接节拍器时末尾留一个空格（`Andante ♩ = c. 76`），不然排出来文字与音符字形贴在一起
        const words = n.tempoText && h("direction-type", null, h("words", { "font-size": textPt(n, n.tempoSize) }, m ? `${n.tempoText.trimEnd()} ` : n.tempoText));
        const metro = m && h("direction-type", null, h("metronome", { parentheses: m.parentheses ? "yes" : undefined }, h("beat-unit", null, m.unit), h("per-minute", null, m.text ?? String(m.bpm))));
        body.push(h("direction", { placement: "above", id: idOf(n.tempoId) }, words, metro, dirStaff(), m && h("sound", { tempo: m.bpm })));
      }
      for (const g of n.signs ?? []) body.push(h("direction", { placement: "above" }, h("direction-type", null, h(g)), dirStaff(), h("sound", { [g]: g })));
      for (const w of n.words ?? []) {
        const wy = withSourceLayout && w.baseY !== undefined ? staffY(n.staff, n.sym.box.left, w.baseY) : undefined;
        const el = w.rehearsal ? "rehearsal" : "words";
        const text = h(el, { enclosure: w.rehearsal ? (w.bracket ? "none" : "square") : undefined, "default-y": wy, "font-size": textPt(n, w.size) }, w.text);
        body.push(h("direction", { placement: w.above ? "above" : "below", id: idOf(w.id) }, h("direction-type", null, text), dirStaff(), w.rehearsal ? null : jumpSound(w.text)));
      }
      if (n.dynamic) body.push(dynamicEl(n, dirStaff));
      // 松叶：**止排在起之前**——同一个音符上前一条松叶收尾、下一条起头是常事，
      // 反过来写会让两条重叠（MusicXML 里同号的 wedge 不能套嵌）。
      // 收在小节线前的止（`wedgeStopAfter`）写在末音（和弦）之后：下一个和弦打头之前、或本声部末尾 `<forward>` 之前冲掉
      // 跨谱表书写的音（`crossTo`）`<staff>` 按符头所在那行；挂在它上面的松叶也按那一行编号，才与那一行上的另一端配得上
      //（宁静 m7–8 钢琴渐弱止在左手跨到右手谱表的 A3 上，原来写成 `<staff>2`，起端在右手，两端配不上）
      const nStaffNo = n.crossTo && staffNo ? (partStaffNo.get(n.staff) ?? staffNo) : staffNo;
      const wDir: DirStaff = () => (nStaffNo ? h("staff", null, nStaffNo) : null);
      const wNo = nStaffNo || 1;
      if (n.wedgeStop && !n.wedgeStopAfter) body.push(wedgeStopEl(n, wNo, wDir));
      if (n.wedgeStart) body.push(wedgeStartEl(n, wNo, wDir));
      body.push(noteEl(n, ticks(n.duration), nStaffNo, withVoice, voiceBase));
      if (n.wedgeStop && n.wedgeStopAfter) {
        const sn = n;
        pendingStop = (ax) => [wedgeStopEl(sn, wNo, wDir, ax)];
      }
      // 行末小节线上的 ⊕ / 𝄋（`signsAfter`）：写在末音之后，读回来落在小节末、画在小节线上
      if (n.signsAfter?.length) {
        const prevStop: ((anchorX?: number) => XmlEl[]) | null = pendingStop;
        const signs = n.signsAfter;
        pendingStop = (ax?: number): XmlEl[] => [
          ...(prevStop ? prevStop(ax) : []),
          ...signs.map((g) => h("direction", { placement: "above" }, h("direction-type", null, h(g)), dirStaff())),
        ];
      }
      if (!n.chordExtra && !n.grace) cur += ticks(n.duration);
    }
    if (pendingStop) body.push(...pendingStop(barRight));
    // 按拍位排满的小节里，提前收尾的声部补 `<forward>` 到小节末：合唱谱的女低、男低常常
    // 唱半小节就并回主声部的和弦（共用符干）。不补的话，换行谱前按最长声部写的 `<backup>`
    // 会倒过小节头，下一行谱整体前移。
    if (timed && cur > 0 && cur < full) {
      body.push(forwardEl(full - cur));
      cur = full;
    }
    for (const c of clefsLeft) body.push(h("attributes", null, c.el()));
    if (vi < voices.length - 1 && cur > 0) body.push(backupEl(cur));
  });
  return body;
}

/** 行首离谱表左端几个线距以内的谱号算行首的（同 `notedata.ts` 里 `clefs` 的切法）。 */
const ROW_START_CLEF = 5;
type SysEntry = StaffScore["systems"][number];
function rowStartClef(entry: SysEntry, st: Staff): string {
  const sp = st.stepDistance() * 2;
  return clefFor(entry.page, entry.ctx, st, st.box.left + sp * ROW_START_CLEF)?.code ?? "gClef";
}
function midRowClefs(entry: SysEntry, st: Staff) {
  const sp = st.stepDistance() * 2;
  return (entry.ctx.get(st)?.clefs ?? []).filter((c) => c.box.left >= st.box.left + sp * ROW_START_CLEF);
}

/**
 * **两声部同音、各带一根干的，拆回两个声部**（万口欢唱女高女中同是 E4 二分，原谱一个头上下两根干）：识别把两根干并成一枚和弦
 *（`initChords` 的断干拼接），写出来是一个声部里两个同音高、`<stem>` 一上一下的和弦音——MusicXML 一枚和弦只有一根干，
 * 混排画成并排两个头加一根干，转 ABC / 123 也只能写成 `[EE]`。
 *
 * 判据：一枚和弦里有干朝上、也有干朝下的音，且有一对同音高（音级、升降都同）的一上一下。干朝下的那几个音挪进本小节新开的声部
 *（声部号接在已有的后面，同一声部拆出来的共用一个），起点同原和弦，其余拍子靠 `<forward>` 补（按拍位写时 `emitVoices` 本来就补；不按拍位写时
 * 按原声部里它前面那些和弦的时值累加，记在 `starts` 里）。挂在挪走的音上的歌词留给原和弦：读入端按声部配词，挪到第二声部就丢了。
 */
function splitUnisonStems(inBar: StaffNote[], ticks: (d: number) => number): { notes: StaffNote[]; starts: Map<StaffNote, number> } {
  const starts = new Map<StaffNote, number>();
  const groups = new Set(inBar.map((n) => n.group).filter((g): g is StaffChord => !!g && !g.grace));
  const hits = [...groups].filter((g) => {
    const ns = inBar.filter((n) => n.group === g && !n.rest && !n.grace);
    return ns.some((u) => u.stemUp === true && ns.some((d) => d.stemUp === false && d.diatonic === u.diatonic && d.alter === u.alter));
  });
  if (!hits.length) return { notes: inBar, starts };
  const timed = inBar.every((n) => n.group?.timed);
  let next = Math.max(...inBar.map((n) => n.voice));
  // 同一声部里拆出来的音前后不重叠，共用一个新声部
  const newVoice = new Map<number, number>();
  const out = inBar.slice();
  for (const g of hits) {
    const v = inBar.find((n) => n.group === g)!.voice;
    const moved = out.filter((n) => n.group === g && n.stemUp === false).sort((a, b) => a.diatonic - b.diatonic);
    const kept = out.filter((n) => n.group === g && n.stemUp !== false).sort((a, b) => a.diatonic - b.diatonic);
    const voice = newVoice.get(v) ?? (newVoice.set(v, ++next), next);
    const ng: StaffChord = { ...g, notes: moved, voice };
    // 只补原和弦里还没有的段：同一段两个字（挪走的那个多半是错挂的）原先写出时也只留打头那个音上的
    const have = new Set(kept.flatMap((n) => (n.lyrics ?? []).map((l) => l.verse)));
    const lyrics = moved.flatMap((n) => n.lyrics ?? []).filter((l) => !have.has(l.verse) && (have.add(l.verse), true));
    const stopHave = new Set(kept.flatMap((n) => (n.lyricExtendStop ?? []).map((l) => l.verse)));
    const stops = moved.flatMap((n) => n.lyricExtendStop ?? []).filter((l) => !stopHave.has(l.verse) && (stopHave.add(l.verse), true));
    const copies = new Map<StaffNote, StaffNote>();
    moved.forEach((n, i) => copies.set(n, { ...n, group: ng, voice, chordExtra: i > 0 || undefined, lyrics: undefined, lyricExtendStop: undefined }));
    kept.forEach((n, i) => {
      const add = i === 0 ? { lyrics: lyrics.length ? [...(n.lyrics ?? []), ...lyrics] : n.lyrics, lyricExtendStop: stops.length ? [...(n.lyricExtendStop ?? []), ...stops] : n.lyricExtendStop } : {};
      copies.set(n, { ...n, ...add, chordExtra: i > 0 || undefined });
    });
    for (let i = 0; i < out.length; i++) out[i] = copies.get(out[i]) ?? out[i];
    if (!timed) {
      // 原声部里排在这枚和弦之前的那些和弦（按 x）的时值和，就是它在小节里的起点。按和弦数、每枚一次，不看 `chordExtra`：
      // 打头音不在这小节里的和弦音也带着它，`emitVoices` 分组写出时照样占拍（天父加恩 m8 的八分 F4）
      const left = Math.min(...moved.map((n) => n.x));
      const durOf = new Map<unknown, number>();
      for (const n of out) {
        if (n.voice !== v || n.grace || n.x >= left - 1e-6 || n.group === g) continue;
        const key = n.group ?? n;
        if (!durOf.has(key) || !n.chordExtra) durOf.set(key, ticks(n.duration));
      }
      starts.set(copies.get(moved[0])!, [...durOf.values()].reduce((a, d) => a + d, 0));
    }
  }
  return { notes: out, starts };
}

/** `emitVoices` 用掉的时长（大谱表换行时要照它倒回小节头）。 */
function voiceTicks(inBar: StaffNote[], ticks: (d: number) => number): number {
  const timed = inBar.every((n) => n.group?.timed);
  const at = (dur: number) => Math.round(ticks(1) * dur);
  let used = 0;
  for (const v of new Set(inBar.map((n) => n.voice))) {
    const vn = inBar.filter((n) => n.voice === v && !n.chordExtra && !n.grace);
    if (timed) {
      let m = 0;
      for (const n of vn) m = Math.max(m, at(n.group!.offset) + ticks(n.duration));
      used = Math.max(used, m);
    } else used = Math.max(used, vn.reduce((a, n) => a + ticks(n.duration), 0));
  }
  return used;
}

/**
 * 多谱表声部显式写 `<part-symbol>brace</part-symbol>`（紧跟 `<staves>`）。规范缺省就是 brace，Finale 导出也不写，
 * 但并非每个读入端都按缺省补（本仓库从前就不补）；识别出的多谱表声部只来自花括号或「G + F 谱号」大谱表，一律是 brace。
 */
const partSymbolEl = (): XmlEl => h("part-symbol", null, "brace");

/** 正在写的 part 里各行谱的谱表号（`<staff>`）：跨谱表的弧止端按起端那行编号用。 */
const partStaffNo = new Map<Staff, number>();

/** 弧标记上的临时信息（`markSlurNotes` 的弧号、落单半截的几何位置与朝向），整个声部写完后由 `renumberSlurs` 配对、重编号后扔掉 */
interface ArcInfo {
  arc: string;
  edge?: string;
  above?: boolean;
}
/** 这一遍写出的弧标记 → 弧信息（`renumberSlurs` 读） */
const arcInfo = new WeakMap<XmlEl, ArcInfo>();

function noteEl(n: StaffNote, dur: number, staffNo = 0, withVoice = false, voiceBase = 0): XmlEl {
  const type = h("type", null, noteType(n.base));
  const dots = Array.from({ length: n.dots }, () => h("dot"));
  // `<staff>` 排在 `<notations>` 之前、`<stem>` 之后（MusicXML 的子元素顺序）
  const staffEl = staffNo ? h("staff", null, staffNo) : null;
  // `<voice>` 排在 `<duration>`/`<tie>` 之后、`<type>` 之前
  const voiceEl = withVoice ? h("voice", null, n.voice + voiceBase) : null;
  // 不显示的休止（`<note print-object="no">`）不带识别 id
  if (n.rest) return h("note", { "print-object": n.hidden ? "no" : undefined, id: n.hidden ? undefined : currentNoteId?.(n) }, h("rest"), h("duration", null, dur), voiceEl, type, dots, staffEl);
  // **倚音不占拍子**：MusicXML 的 `<grace/>` 排在最前（`<chord/>` 之前），
  // 而且这种音**不许写 `<duration>`**——写了小节就超时长，回读的软件多半直接报错。
  // 短倚音的斜杠：路径画的（`findGraceSlashes`）记在 `graceSlash`，字形画的（`graceNoteSlash*`）挂在记号里
  const grace = n.grace ? h("grace", { slash: n.graceSlash || n.marks?.some((m) => m.startsWith("graceNoteSlash")) ? "yes" : undefined }) : null;
  const durEl = n.grace ? null : h("duration", null, dur);
  // `<chord/>` 紧跟在 `<grace/>` 之后（没有倚音时它就是第一个子元素）
  const chord = n.chordExtra ? h("chord") : null;
  // `<alter>` 是**发声**的升降（含调号），`<accidental>` 是谱面上**印出来**的那个记号。
  // 两者不是一回事：G 调里一个没印记号的 F 也要写 `<alter>1</alter>`。
  const pitch = n.unpitched
    ? h("unpitched", null, h("display-step", null, n.step), h("display-octave", null, n.octave))
    : h("pitch", null, h("step", null, n.step), n.alter !== 0 && h("alter", null, n.alter), h("octave", null, n.octave));
  const acc = n.accidental !== null ? h("accidental", null, accidentalName(n.accidental)) : null;
  // 符干端点照原图（`<stem default-y>`）：排版不再按缺省 3.5 格重算，长短与符杠斜度跟原谱走
  const tip = withSourceLayout && n.stemTip !== undefined ? staffY(n.staff, n.sym.px, n.stemTip) : undefined;
  const stem = n.stemUp === null ? null : h("stem", { "default-y": tip }, n.stemUp ? "up" : "down");
  // `<lyric>` 是 `<note>` 的最后一批子元素，排在 `<stem>`/`<accidental>` 之后
  // 一字多音收尾的那个音：只出一个带 `<extend type="stop"/>` 的空 `<lyric>`（延长线画到这里）
  const lyric = [
    ...(n.lyrics ?? []).map((l) => lyricEl(l, withSourceLayout && l.baseY !== undefined && n.staff ? staffY(n.staff, n.sym.box.left, l.baseY) : undefined)),
    ...(n.lyricExtendStop ?? []).map((l) => h("lyric", { number: l.verse }, h("extend", { type: "stop" }))),
  ];
  // `<notations>` 排在 `<lyric>` 之前（MusicXML 的子元素顺序）
  const nots: XmlEl[] = [];
  if (n.tieStop) nots.push(h("tied", { type: "stop" }));
  // 弧的方向：圆滑线写 `placement`、连音线写 `orientation`（两种软件导出的常规写法，读入端两个都认）
  const tieOri = n.tieAbove === undefined ? undefined : n.tieAbove ? "over" : "under";
  if (n.tieStart) nots.push(h("tied", { type: "start", id: idOf(n.tieId), "line-type": n.tieDashed ? "dashed" : undefined, orientation: tieOri }));
  // 编号按谱表号：钢琴两行合一个 part 时同号的弧按编号配对，右手一条长弧还开着、左手又起又止一条，读入端就配串了（宁静 m32–36）；
  // 止端按起端那行编（跨谱表的弧）
  const slurNo = staffNo || 1;
  const stopNo = (n.slurStopFrom && partStaffNo.get(n.slurStopFrom)) || slurNo;
  // 带弧号的（`markSlurNotes` 给的）先记下弧号（`arcInfo`），整个声部写完后由 `renumberSlurs` 配对、重编号
  // 落单半截再带上 `edge`、`above`（几何位置与朝向，见 `slurOrphans`）
  const arcs = (ids: string[] | undefined) => (ids?.length ? ids : [""]);
  const slur = (id: string, attrs: Record<string, string | number | undefined>): XmlEl => {
    const el = h("slur", attrs);
    if (id) {
      const o = n.slurOrphans?.find((x) => x.id === id);
      arcInfo.set(el, { arc: id, ...(o ? { edge: o.edge, above: o.above } : {}) });
    }
    return el;
  };
  if (n.slurStop) for (const id of arcs(n.slurStopIds)) nots.push(slur(id, { type: "stop", number: stopNo }));
  const slurPl = n.slurAbove === undefined ? undefined : n.slurAbove ? "above" : "below";
  if (n.slurStart)
    for (const id of arcs(n.slurStartIds)) nots.push(slur(id, { type: "start", number: slurNo, "line-type": n.slurDashed ? "dashed" : undefined, placement: slurPl }));
  // 连音组只在头尾两个音上写起止（和弦写在打头那个音上）；读入端按起止配对，只有 start 的会一路顶掉、整组丢
  if (n.tuplet?.start && !n.chordExtra) nots.push(h("tuplet", { type: "start" }));
  if (n.tuplet?.stop && !n.chordExtra) nots.push(h("tuplet", { type: "stop" }));
  // `<notations>` 里子元素有固定次序：tied / slur / tuplet / ornaments / technical / articulations / fermata / arpeggiate
  const arts: XmlEl[] = [];
  const orns: XmlEl[] = [];
  let fermata: XmlEl | null = null;
  let arpeggiate = false;
  const tech: XmlEl[] = [];
  for (const m of n.marks ?? []) {
    const a = ARTICULATION[m];
    if (a) {
      const placement = m.endsWith("Below") ? "below" : "above";
      a.forEach((tag, i) => arts.push(h(tag, { placement: i === 0 ? placement : undefined })));
      continue;
    }
    if (m === "stringsUpBow" || m === "stringsDownBow") {
      tech.push(h(m === "stringsUpBow" ? "up-bow" : "down-bow"));
      continue;
    }
    if (m === "arpeggiato") arpeggiate = true;
    else if (m.startsWith("fermata")) fermata = h("fermata", { type: m === "fermataBelow" ? "inverted" : "upright" });
    else if (m.startsWith("ornamentTrill") || m.startsWith("wiggleTrill")) orns.push(h("trill-mark"));
    else if (m === "ornamentShortTrill") orns.push(h("inverted-mordent"));
    else if (/^tremolo[123]$/.test(m)) {
      const at = n.tremoloAt ? { "default-x": Math.round(n.tremoloAt.x * 100) / 10, "default-y": Math.round(n.tremoloAt.y * 100) / 10 } : {};
      orns.push(h("tremolo", { type: "single", ...at }, m.slice(-1)));
    }
  }
  if (orns.length) nots.push(h("ornaments", null, orns));
  if (tech.length) nots.push(h("technical", null, tech));
  if (arts.length) nots.push(h("articulations", null, arts));
  if (fermata) nots.push(fermata);
  if (arpeggiate) nots.push(h("arpeggiate"));
  const notations = nots.length ? h("notations", null, nots) : null;
  const timeMod = n.tuplet ? h("time-modification", null, h("actual-notes", null, n.tuplet.actual), h("normal-notes", null, n.tuplet.normal)) : null;
  // `<tie>` 是发声用的（与 `<tied>` 的图形标记分开写，MusicXML 两者都要）
  const tie = [n.tieStop && h("tie", { type: "stop" }), n.tieStart && h("tie", { type: "start" })];
  // 斜杠符头（前奏/间奏的「照这个节奏弹和弦」）：音高留着（它就画在第三线上），
  // 但要把符头形状写出来，不然回读时会变成一串真的 B4。`<notehead>` 排在 `<stem>` 之后、
  // `<staff>` 之前——MusicXML 的子元素次序是有规定的。
  const head = n.slash ? h("notehead", null, "slash") : n.xHead ? h("notehead", null, n.xHead) : null;
  // `<beam>` 排在 `<staff>` 之后、`<notations>` 之前；和弦只写在打头那个音上（`emitVoices` 已把整枚和弦的杠挪到它身上）
  const beam = n.chordExtra ? [] : (n.beam ?? []).map((b, i) => h("beam", { number: i + 1 }, b));
  return h("note", { id: currentNoteId?.(n) }, grace, chord, pitch, durEl, tie, voiceEl, type, dots, acc, timeMod, stem, head, staffEl, beam, notations, lyric);
}

/** SMuFL 演奏法名 → MusicXML 的 `<articulations>` 子元素。 */
const ARTICULATION: Record<string, readonly string[]> = {
  articAccentAbove: ["accent"],
  articAccentBelow: ["accent"],
  articStaccatoAbove: ["staccato"],
  articStaccatoBelow: ["staccato"],
  articTenutoAbove: ["tenuto"],
  articTenutoBelow: ["tenuto"],
  articStaccatissimoAbove: ["staccatissimo"],
  articStaccatissimoBelow: ["staccatissimo"],
  articMarcatoAbove: ["strong-accent"],
  articMarcatoBelow: ["strong-accent"],
  // 两件套只给第一件写 placement（同从前的写法）
  articAccentStaccatoAbove: ["accent", "staccato"],
  articAccentStaccatoBelow: ["accent", "staccato"],
  articTenutoStaccatoAbove: ["tenuto", "staccato"],
  articTenutoStaccatoBelow: ["tenuto", "staccato"],
  breathMarkComma: ["breath-mark"],
  caesura: ["caesura"],
};

/**
 * 一个声部的 `<slur>` 按弧号配对、重编 `number`（临时的弧信息 `arcInfo` 随之扔掉）。
 *
 * 原来编号按谱表号给（第 1 行谱 1 号、第 2 行谱 2 号），同一行谱上两条弧交叠（嵌套、上下两声部各一条）
 * 或只认出一端的弧，读入端就配串了：MuseScore 报「No matching end found for start of slur number 2 … Older slur will be ignored」
 * （牵我的手 Synth m24、Piano m12→m18 等五处）。改为：
 *   · 一条弧的两端里**先写出的那端**占一个空闲编号（1 起最小的空号），后写出的那端交还；
 *   · **跨行弧的两个半截**在这里接：同一谱表号上，`end` 半截接**这个声部下一个出现的系统**里的 `begin` 半截
 *     （朝向相同的优先；中间那个系统这个声部的谱表隐藏了也照接——牵我的手 Synth m57→m60）。
 *     `sysOfBar`（每小节第几个系统）没给的，按相隔不过一小节算。识别时页内已接过一遍（`slur.ts::reconnectSlurs`），
 *     剩下的是跨页的、和前后两个系统行数不同的（首系统隐藏了人声谱表）——在这里接，声部归属已定、跨页也连着；
 *   · **接不上的半截不写**：MusicXML 里半截弧没有合法写法，留着就是一个永不闭合的编号（导入端报警告，
 *     后面同号的还会被配串）。照写成另取的编号试过，回归各档一分不差——读入端（`model/fromxml.ts::MarkSink`）
 *     本来就把配不上对的半截丢掉，写了也白写。系统中间缺一端的半截是识别没挂上符头，要在识别那头补。
 * 没有弧号的（不走 `markSlurNotes` 的路）原样不动。
 */
function renumberSlurs(measures: readonly XmlEl[], sysOfBar?: number[], crossTies = false): void {
  // ── 弧标记、所在那个音、第几小节（1 起），按文档序 ──
  interface Tok {
    el: XmlEl;
    note: XmlEl;
    type: string;
    staff: string;
    arc: string;
    edge?: string;
    above: boolean;
    bar: number;
  }
  const notesOfBar = measures.map((m) => m.children.filter((c) => c.tagName === "note"));
  const toks: Tok[] = [];
  notesOfBar.forEach((notes, bi) => {
    for (const note of notes)
      for (const nt of note.children)
        if (nt.tagName === "notations")
          for (const el of nt.children) {
            const info = el.tagName === "slur" ? arcInfo.get(el) : undefined;
            if (info) toks.push({ el, note, type: el.getAttribute("type")!, staff: el.getAttribute("number")!, arc: info.arc, edge: info.edge, above: !!info.above, bar: bi + 1 });
          }
  });
  if (!toks.length) return;
  // 某小节所在系统之后，这个声部下一个出现的系统
  const nextSys = (bar: number): number | undefined => {
    const s0 = sysOfBar![bar - 1];
    return sysOfBar!.find((x) => x > s0);
  };
  const text = (note: XmlEl, tag: string) => note.children.find((c) => c.tagName === tag)?.textContent;
  const pitchOf = (note: XmlEl): string | null => {
    const p = note.children.find((c) => c.tagName === "pitch");
    return p ? `${text(p, "step")}${text(p, "alter") ?? ""}${text(p, "octave")}` : null;
  };
  // 同声部 = 同 `<voice>`、同 `<staff>`；和弦附加音（`<chord/>`）、倚音不算
  const voiceOf = (note: XmlEl) => `${text(note, "voice") ?? "1"}/${text(note, "staff") ?? ""}`;
  const plain = (note: XmlEl) => !note.children.some((c) => c.tagName === "chord" || c.tagName === "grace");
  const lastInSystem = (t: Tok) => {
    if (sysOfBar && sysOfBar[t.bar] === sysOfBar[t.bar - 1]) return false;
    const v = voiceOf(t.note);
    const notes = notesOfBar[t.bar - 1]!;
    return !notes.slice(notes.indexOf(t.note) + 1).some((n) => plain(n) && voiceOf(n) === v);
  };
  const firstInSystem = (t: Tok) => {
    const v = voiceOf(t.note);
    const notes = notesOfBar[t.bar - 1]!;
    return !notes.slice(0, notes.indexOf(t.note)).some((n) => plain(n) && voiceOf(n) === v);
  };
  /** 一前一后两个半截像不像一条跨系统的**延音线**：两头同音高、起端是本系统末一个音、止端是下一系统头一个音
   *（跨页的长圆滑线两头碰巧同音高，牵我的手 m24、m36、m47 那几条，不相邻） */
  const tieLike = (a: Tok, b: Tok) => {
    const pa = pitchOf(a.note);
    return !!pa && pa === pitchOf(b.note) && lastInSystem(a) && firstInSystem(b);
  };

  const starts = new Set(toks.filter((t) => t.type === "start").map((t) => t.arc));
  const stops = new Set(toks.filter((t) => t.type === "stop").map((t) => t.arc));
  const alias = new Map<string, string>(); // 后半截的弧号 → 接上的前半截弧号
  const orphan = new Set<string>();
  const pending = new Map<string, Tok[]>(); // 谱表号 → 还没接上的 `end` 半截
  const pairedTies = new Set<string>(); // 矢量路几条同处断开时先配上的延音线（前半截弧号）
  for (const t of toks) {
    if (t.type === "start" && !stops.has(t.arc)) {
      orphan.add(t.arc);
      if (t.edge !== "end") continue;
      const q = pending.get(t.staff) ?? [];
      q.push(t);
      pending.set(t.staff, q);
    } else if (t.type === "stop" && !starts.has(t.arc)) {
      orphan.add(t.arc);
      if (t.edge !== "begin") continue;
      const q = (pending.get(t.staff) ?? []).filter((p) => (sysOfBar ? sysOfBar[t.bar - 1] === nextSys(p.bar) : t.bar - p.bar <= 1));
      // 先配延音线（同音高、紧挨着），再按朝向配：行尾行首各有一条延音线、一条圆滑线的半截时，
      // 按朝向先到先得会配串（破碎 p2→p3 m16–17 钢琴右手：E4 延音线的后半截排在圆滑线前面，抢走了朝向相同的圆滑线前半截）
      // 矢量路：同一行同一处断开的不止一条（一条延音线外面罩着一条圆滑线）时也先配延音线，配上的记下来、写成延音线（见下 `tieArcs`）
      const tieHit = crossTies || q.length >= 2 ? q.find((p) => tieLike(p, t)) : undefined;
      if (tieHit && !crossTies) pairedTies.add(tieHit.arc);
      const hit = tieHit ?? q.find((p) => p.above === t.above) ?? q[0];
      pending.set(t.staff, q.filter((p) => p !== hit));
      if (hit) {
        alias.set(t.arc, hit.arc);
        orphan.delete(t.arc);
        orphan.delete(hit.arc);
      }
    }
  }
  // **接上的两个半截两头同音高、紧挨着的是延音线**（页内跨行的已在 `slur.ts::reconnectSlurs` 按音级判过，这里是跨页的：
  // 破碎 p2→p3 m16–17、p5→p6 m59–60、p10→p11 m93–94 钢琴右手）
  const tieArcs = new Set<string>();
  // 矢量路不开 `crossTies`（同音高相邻两音间也有记圆滑线的），但**起音上同时起着两个跨行半截**的，其中接到同音高下一音的那条是延音线：
  // 同两个音之间不会有两条圆滑线（牵我的手 W m36→37 F4）
  const twoOn = (a: Tok) => toks.some((o) => o !== a && o.type === a.type && o.edge === a.edge && orphan.has(o.arc) === orphan.has(a.arc) && o.note === a.note);
  for (const [stopArc, startArc] of alias) {
    const a = toks.find((t) => t.type === "start" && t.arc === startArc), b = toks.find((t) => t.type === "stop" && t.arc === stopArc);
    if (a && b && tieLike(a, b) && (crossTies || twoOn(a) || pairedTies.has(startArc))) tieArcs.add(startArc);
  }
  // **页内跨行接上的同音两截**（位图路 `pagefinish.ts` 先一律当圆滑线写）：起音是这个声部本系统最后一个音、止音是它下一系统第一个音、
  // 同音高——时间上紧挨着，是延音线；中间隔着别的音的是跨行的长圆滑线（宁静 p8 m97→m103 女高 E5…E5）
  if (crossTies && sysOfBar)
    for (const a of toks) {
      if (a.type !== "start" || orphan.has(a.arc) || alias.has(a.arc)) continue;
      const b = toks.find((t) => t.type === "stop" && t.arc === a.arc);
      if (!b || sysOfBar[b.bar - 1] !== nextSys(a.bar)) continue;
      if (tieLike(a, b)) tieArcs.add(a.arc);
    }
  // **只找到一半的跨系统弧**：另一半没认出来，但相邻系统同声部紧挨着的那个音同音高，就当延音线，那一头补上
  //（行尾的延音线头常只有半格多宽、贴着谱线，行首那截又常与圆滑线起笔粘在一起）。
  // 补的先记下、判完再一并插（判的时候看的都是没补之前的样子）
  const inserts: { note: XmlEl; type: string; above: boolean }[] = [];
  if (crossTies && sysOfBar) {
    const hasTie = (note: XmlEl, type: string) => note.children.some((c) => c.tagName === "tie" && c.getAttribute("type") === type);
    for (const t of toks) {
      if (!orphan.has(t.arc)) continue;
      const v = voiceOf(t.note), p = pitchOf(t.note);
      if (!p) continue;
      let target: XmlEl | undefined;
      if (t.type === "start" && t.edge === "end" && lastInSystem(t)) {
        const ns = nextSys(t.bar);
        const k = ns === undefined ? -1 : sysOfBar.indexOf(ns);
        if (k >= 0) target = notesOfBar[k]?.find((n) => plain(n) && voiceOf(n) === v);
      } else if (t.type === "stop" && t.edge === "begin" && firstInSystem(t)) {
        const s0 = sysOfBar[t.bar - 1]!;
        const prev = Math.max(...sysOfBar.filter((x) => x >= 0 && x < s0));
        const k = sysOfBar.lastIndexOf(prev);
        if (k >= 0) target = notesOfBar[k]?.filter((n) => plain(n) && voiceOf(n) === v).pop();
      }
      if (!target || pitchOf(target) !== p || hasTie(target, t.type === "start" ? "stop" : "start")) continue;
      if (!target.children.some((c) => c.tagName === "duration")) continue;
      inserts.push({ note: target, type: t.type === "start" ? "stop" : "start", above: t.above });
      orphan.delete(t.arc);
      tieArcs.add(t.arc);
    }
  }
  // 同一处补几条时按补的先后排：`<tie>` 接在 `<duration>`（与之前补的）后面，`<tied>` 接在 `<notations>` 开头（与之前补的）后面
  const tieCursor = new Map<XmlEl, XmlEl>();
  const tiedCursor = new Map<XmlEl, XmlEl>();
  const after = (parent: XmlEl, node: XmlEl, prevNode: XmlEl | null) => {
    const i = prevNode ? parent.childNodes.indexOf(prevNode) : -1;
    parent.insertBefore(node, parent.childNodes[i + 1] ?? null);
  };
  for (const { note, type, above } of inserts) {
    const tie = h("tie", { type });
    after(note, tie, tieCursor.get(note) ?? note.children.find((c) => c.tagName === "duration")!);
    tieCursor.set(note, tie);
    const tied = h("tied", { type, orientation: type === "start" ? (above ? "over" : "under") : undefined });
    let nots = note.children.find((c) => c.tagName === "notations");
    if (!nots) {
      nots = h("notations");
      note.insertBefore(nots, note.children.find((c) => c.tagName === "lyric") ?? null);
    }
    after(nots, tied, tiedCursor.get(nots) ?? null);
    tiedCursor.set(nots, tied);
  }
  // 识别对照的 id 写在同一端的**最后一份**上：和弦各音都起着同一条弧时（同一个弧号写了几遍），读入端并成一条、绑的是最后那个标签
  const lastOf = new Map<string, Tok>();
  for (const t of toks) lastOf.set(`${t.type}:${t.arc}`, t);
  const num = new Map<string, number>();
  const used = new Set<number>();
  const restAttrs = (el: XmlEl) => Object.fromEntries(el.attributes.filter((a) => a.name !== "type" && a.name !== "number").map((a) => [a.name, a.value]));
  for (const t of toks) {
    const key = alias.get(t.arc) ?? t.arc;
    const parent = t.el.parentElement!;
    if (orphan.has(key)) {
      t.el.remove();
      continue;
    }
    if (tieArcs.has(key)) {
      // `<tie>` 紧跟在这个音的 `<duration>` 后面（MusicXML 的子元素顺序），`<tied>` 顶替弧标记
      const d = t.note.children.find((c) => c.tagName === "duration");
      if (d) after(t.note, h("tie", { type: t.type }), d);
      // 弧的上下方照抄成延音线的朝向（读入端照 `orientation` 定方向，不写就由排版去猜）
      const ori = t.type === "start" ? (t.above || t.el.getAttribute("placement") === "above" ? "over" : "under") : undefined;
      const tid = lastOf.get(`${t.type}:${t.arc}`) === t && (t.type === "start" || alias.has(t.arc)) ? currentArcId?.(t.arc) : undefined;
      parent.insertBefore(h("tied", { type: t.type, id: idOf(tid), orientation: ori }), t.el);
      t.el.remove();
      continue;
    }
    let n = num.get(key);
    if (n === undefined) {
      n = 1;
      while (used.has(n)) n++;
      used.add(n);
      num.set(key, n);
    } else {
      used.delete(n);
      num.delete(key);
    }
    // 识别对照的 id：起端写这条弧的；跨行接上的后半截另是一个弧对象，它的 id 写在止端
    const sid = lastOf.get(`${t.type}:${t.arc}`) !== t ? undefined : t.type === "start" || alias.has(t.arc) ? currentArcId?.(t.arc) : undefined;
    parent.insertBefore(h("slur", { type: t.type, number: n, id: idOf(sid), ...restAttrs(t.el) }), t.el);
    t.el.remove();
  }
  for (const note of notesOfBar.flat()) for (const nt of note.children.filter((c) => c.tagName === "notations" && !c.children.length)) nt.remove();
}

/** `y`：写源谱版面时这一行词的基线（tenths，相对谱表顶线），原图上量的 */
function lyricEl(l: { verse: number; text: string; hyphen: boolean; cont: boolean; extend?: boolean; above?: boolean; id?: string; label?: string }, y?: number): XmlEl {
  const syllabic = l.cont ? (l.hyphen ? "middle" : "end") : l.hyphen ? "begin" : "single";
  // 首字前印的段号并进字前（`1.道`；不带点的隔空格 `1 Be`，读入端 `model/fromxml.ts::readLyrics` 拆回 `verseLabel`）
  const label = l.label === undefined ? "" : /\d$/.test(l.label) ? `${l.label} ` : l.label;
  return h(
    "lyric",
    { number: l.verse, id: idOf(l.id), "default-y": y, placement: l.above ? "above" : undefined },
    h("syllabic", null, syllabic),
    h("text", null, label + l.text),
    l.extend && h("extend", { type: "start" }),
  );
}

function accidentalName(alter: number): string {
  switch (alter) {
    case -2:
      return "flat-flat";
    case -1:
      return "flat";
    case 1:
      return "sharp";
    case 2:
      return "double-sharp";
    default:
      return "natural";
  }
}

/** SMuFL 谱号名 → `<clef>` 的符号、线、八度移位 */
function clefSpec(code: string): { sign: string; line?: number; octave?: number } {
  switch (code) {
    case "fClef":
      return { sign: "F", line: 4 };
    case "fClef8vb":
      return { sign: "F", line: 4, octave: -1 };
    case "cClef":
      return { sign: "C", line: 3 };
    case "gClef8vb":
      return { sign: "G", line: 2, octave: -1 };
    case "gClef8va":
      return { sign: "G", line: 2, octave: 1 };
    case "unpitchedPercussionClef1":
    case "unpitchedPercussionClef2":
      return { sign: "percussion" };
    default:
      return { sign: "G", line: 2 };
  }
}

/** 谱号的比较键：同一个 `<clef>` 的谱号名（几个名字写出来一样，如两种打击乐谱号）算同一个 */
const clefKey = (code: string): string => {
  const c = clefSpec(code);
  return `${c.sign}${c.line ?? ""}${c.octave ?? ""}`;
};

/** SMuFL 谱号名 → `<clef>`（`number`：多谱表声部的第几行谱） */
export function clefEl(code: string, number?: number): XmlEl {
  const c = clefSpec(code);
  return h("clef", { number }, h("sign", null, c.sign), c.line !== undefined && h("line", null, c.line), c.octave !== undefined && h("clef-octave-change", null, c.octave));
}

// ── 按声部导出 ──────────────────────────────────────────────────────────────

/**
 * 整首曲子（跨页、可含多谱表声部）→ MusicXML 文本。
 *
 * 走 `score.ts` 认出来的 `Part`/`ScoreStaff` 结构，**钢琴谱的两行会合成一个 `<part>`**（`<staves>2` + 每个音符带 `<staff>`），
 * 而不是丢掉伴奏那行。建树 → `scoreDocFromXml` → `scoreDocToMusicXml`（见文件头）。
 */
export function scoreToMusicXml(
  score: StaffScore,
  notesOf: (staff: Staff) => StaffNote[],
  opts: StaffXmlOptions = {},
): string {
  currentNoteId = opts.noteId ?? null;
  currentArcId = opts.arcId ?? null;
  withSourceLayout = opts.layout !== false;
  let root: XmlEl;
  try {
    root = scoreTree(score, notesOf, opts);
  } finally {
    currentNoteId = null;
    currentArcId = null;
    writtenIds.clear();
    withSourceLayout = false;
  }
  return scoreDocToMusicXml(scoreDocFromXml(root));
}

function scoreTree(
  score: StaffScore,
  notesOf: (staff: Staff) => StaffNote[],
  opts: StaffXmlOptions,
): XmlEl {
  const divisions = opts.divisions ?? 24;
  const ticks = (dur: number) => Math.max(1, Math.round(dur * 4 * divisions));

  const partList: XmlEl[] = [];
  const parts: XmlEl[] = [];
  const layout = opts.layout === false ? null : sourceLayout(score);
  /** 系统首小节的 `<print>`：源谱版面那份，第一声部首小节再带上 `<measure-numbering>`（子元素次序里排在 `staff-layout` 之后） */
  const printEl = (si: number, pi: number): XmlEl | null => {
    const p = layout ? layout.print(si, pi) : null;
    if (si !== 0 || pi !== 0 || !opts.measureNumbering) return p;
    const mn = h("measure-numbering", null, opts.measureNumbering);
    if (!p) return h("print", null, mn);
    p.appendChild(mn);
    return p;
  };
  const defaults = [...(layout?.defaults() ?? []), ...fontDefaults(score, notesOf)];
  score.parts.forEach((part, pi) => {
    const id = `P${pi + 1}`;
    // 方括号分组：组首声部之前起、组尾声部之后收（`<part-group>` 夹在 `<score-part>` 之间，number 按组编）
    score.groups?.forEach((g, gi) => {
      if (g.first === pi)
        partList.push(h("part-group", { type: "start", number: gi + 1 }, h("group-symbol", null, g.symbol), h("group-barline", null, g.barline ? "yes" : "no")));
    });
    const nameSize = layout && part.nameSize ? pageTextPt(part.nameSize.page, part.nameSize.size) : undefined;
    // `<score-part>`：不给乐器名——Dorico/MuseScore 会把 `<part-name>` 当乐器名显示在谱前。空内容 + print-object="no"，两种软件都不显示
    partList.push(
      h(
        "score-part",
        { id },
        part.name ? h("part-name", { "font-size": nameSize || undefined }, part.name) : h("part-name", { "print-object": "no" }),
        part.abbr && h("part-abbreviation", null, part.abbr),
      ),
    );
    score.groups?.forEach((g, gi) => {
      if (g.last === pi) partList.push(h("part-group", { type: "stop", number: gi + 1 }));
    });
    const measures: XmlEl[] = [];
    let measureNo = 0;
    /** 每一小节属于第几个系统（`renumberSlurs` 接跨行弧用） */
    const sysOfBar: number[] = [];
    let prevFifths: number | null = null;
    let prevTime: string | null = null;
    /** 各行谱上一次写出的谱号（`clefKey`；隐藏的行为空串） */
    let prevClef: string[] = [];
    const nStaves = part.scoreStaves.length;
    /** 各谱表当前印不印（`<staff-details>` 的状态跨小节延续，只在变的时候写） */
    const shown: boolean[] = Array(nStaves).fill(true);
    /** 各谱表的可见性改成 `want`，变了的谱表写 `<staff-details>`（单谱表声部不带 number） */
    const staffDetails = (want: boolean[]): XmlEl[] =>
      want.flatMap((v, k) => {
        if (v === shown[k]) return [];
        shown[k] = v;
        return [h("staff-details", { number: nStaves > 1 ? k + 1 : undefined, "print-object": v ? "yes" : "no" })];
      });
    /** 写过 `<staff-lines>1` 的谱表（下标） */
    const oneLineDone = new Set<number>();
    /** 多谱表声部的 `<clef number>`：单谱表不带 number */
    const clefOf = (code: string, k: number) => clefEl(code, nStaves > 1 ? k + 1 : undefined);

    /**
     * **这一系统里这个声部的谱表全隐藏了**（Finale「隐藏空谱表」：牵我的手首系统只印了器乐，W / M 两行人声没印）。
     * 原来整段跳过不写小节，这个声部从第二个系统起算第 1 小节，整体往前错了一个系统（W / M 少开头 6 小节）。
     * 照样按这一系统的小节数写整小节休止：拍号、调号取同一系统别的谱表的，谱号取这个声部第一次露面那一系统的；
     * 头一个隐藏小节写 `<staff-details print-object="no"/>`，重新露面时写回 `yes`（逐谱表记，见 `staffDetails`）。
     * `sysOfBar` 记 -1：隐藏的系统不算这个声部「出现过」，接跨行弧时跳过它（见 `renumberSlurs`）。
     */
    /** 一行谱这一小节要写的音：跨谱表书写的音（`crossTo`）按借的那一行写——同一 part 里另一行借这一行地方写的剔出去，
     *  这一行借别行写的收进来（`<staff>` 仍按符头所在那行，见 `noteEl`）。借到别的 part 的照旧留在符头那行 */
    const barNotes = (st: Staff, staves: readonly (Staff | null | undefined)[], bar: Bar): StaffNote[] => {
      const inPart = (s0?: Staff) => !!s0 && staves.includes(s0);
      return [
        ...notesOf(st).filter((n) => !(n.crossTo && n.crossTo !== st && inPart(n.crossTo))),
        ...staves.filter((s0) => s0 && s0 !== st).flatMap((s0) => notesOf(s0!).filter((n) => n.crossTo === st)),
      ].filter((n) => n.x >= bar.left && n.x < bar.right);
    };
    /** 曲首弱起（`Bar.pickup`）的实长（ticks）：系统里各行除整小节休止以外的音写出来最长的那行。
     *  有一行写满了拍号（弱起认错了）就不算弱起，返回 undefined；整个系统只有一个音（或一个休止）撑着的也不算——
     *  多半是长音认短了（望十架 m1 长笛全音符读成四分，其余几行整小节休止），宁静的伯利恒那种真弱起是两个八分加一个四分休止 */
    const pickupTicks = (entry: (typeof score.systems)[number], bi: number, full: number): number | undefined => {
      if (!entry.sys.staves.some((st) => st.bars[bi]?.pickup)) return undefined;
      let len = 0;
      let count = 0;
      for (const st of entry.sys.staves) {
        const bar = st.bars[bi];
        if (!bar) continue;
        const own = barNotes(st, entry.sys.staves, bar).filter((n) => n.sym.code !== "restHBar");
        count += own.filter((n) => !n.chordExtra && !n.grace).length;
        len = Math.max(len, voiceTicks(own, ticks));
      }
      return count >= 2 && len > 0 && len < full ? len : undefined;
    };
    /** 这一小节是不是多小节休止：印出来的各行都只有一个带数字的 `restHBar`、数字一致，返回小节数（不是返回 0） */
    const multiRestOf = (staves: readonly (Staff | null | undefined)[], bi: number): number => {
      let n = 0;
      for (const st of staves) {
        if (!st) continue;
        const bar = st.bars[bi];
        if (!bar) return 0;
        const own = barNotes(st, staves, bar).filter((x) => !x.chordExtra);
        const m = own.length === 1 && own[0].sym.code === "restHBar" ? (own[0].sym.multiRest ?? 0) : 0;
        if (!m || (n && n !== m)) return 0;
        n = m;
      }
      return n;
    };
    /** 曲首 / 转调 / 变拍：这一小节 `<attributes>` 里打头的 divisions、key、time（`timeChanges` 从 `tc` 起吃掉落在这一小节里的） */
    const meterAttrs = (ctx: StaffContext | undefined, bar0: Bar | undefined, timeChanges: TimeSig[], tc: { i: number }): XmlEl[] => {
      const out: XmlEl[] = [];
      if (measureNo === 1) out.push(h("divisions", null, divisions));
      // 行中转调（`keyChanges`）：小节里有新调号的从这一小节起写
      // 单线谱（打击乐）不印调号，系统里共享来的调号不作数
      const fifths = ctx && !ctx.staff.oneLine ? fifthsAt(ctx, bar0 ? bar0.right - 1 : -Infinity) : 0;
      if (ctx && fifths !== prevFifths) {
        out.push(h("key", null, h("fifths", null, fifths)));
        prevFifths = fifths;
      }
      while (bar0 && tc.i < timeChanges.length && timeChanges[tc.i].x < bar0.right) {
        const t = timeChanges[tc.i++];
        const k = `${t.beats}/${t.beatType}${t.symbol ?? ""}`;
        if (k !== prevTime) {
          out.push(timeEl(t));
          prevTime = k;
        }
      }
      return out;
    };
    const hiddenSystem = (entry: (typeof score.systems)[number], si: number): void => {
      const ref = entry.sys.staves.find((st) => st.bars.length);
      if (!ref) return;
      const barCount = Math.max(...entry.sys.staves.map((st) => st.bars.length));
      const ctx = entry.ctx.get(ref);
      const timeChanges = timeSignatures(ctx?.time ?? [], ref.stepDistance() * 2);
      const tc = { i: 0 };
      for (let bi = 0; bi < barCount; bi++) {
        measureNo++;
        sysOfBar.push(-1);
        const attrs = meterAttrs(ctx, ref.bars[bi], timeChanges, tc);
        if (bi === 0 && !prevClef.length) {
          // 还没写过谱号（曲首就隐藏）：取这个声部第一次露面那一系统的行首谱号
          const at = score.systems.findIndex((_, sj) => part.scoreStaves.some((ss) => ss.staves[sj]));
          if (at >= 0) {
            const codes = part.scoreStaves.map((ss) => (ss.staves[at] ? rowStartClef(score.systems[at], ss.staves[at]!) : null));
            if (nStaves > 1) attrs.push(h("staves", null, nStaves), partSymbolEl());
            codes.forEach((c, k) => c && attrs.push(clefOf(c, k)));
            prevClef = codes.map((c) => (c ? clefKey(c) : ""));
          }
        }
        attrs.push(...staffDetails(Array(nStaves).fill(false)));
        const [beats, beatType] = (prevTime ?? "4/4").split("/").map((v) => parseInt(v));
        const pickup = pickupTicks(entry, bi, ticks(beats / beatType));
        const dur = pickup ?? ticks(beats / beatType);
        const notes: XmlEl[] = [];
        for (let k = 0; k < nStaves; k++) {
          if (k) notes.push(backupEl(dur));
          notes.push(h("note", null, h("rest", { measure: "yes" }), h("duration", null, dur), h("voice", null, k * 4 + 1), nStaves > 1 && h("staff", null, k + 1)));
        }
        measures.push(h("measure", { number: measureNo, implicit: pickup ? "yes" : undefined }, bi === 0 && printEl(si, pi), attrs.length && h("attributes", null, attrs), notes));
      }
    };

    score.systems.forEach((entry, si) => {
      // 这个声部在这一系统里的各行谱（隐藏的为 null）
      const staves = part.scoreStaves.map((ss) => ss.staves[si]);
      const lead = staves.find((x) => x) ?? null;
      if (!lead) {
        hiddenSystem(entry, si);
        return;
      }
      const barCount = Math.max(...staves.map((st) => st?.bars.length ?? 0));
      const ctx = entry.ctx.get(lead);
      const timeChanges = timeSignatures(ctx?.time ?? [], lead.stepDistance() * 2);
      const tc = { i: 0 };

      for (let bi = 0; bi < barCount; bi++) {
        measureNo++;
        sysOfBar.push(si);
        const bar0 = lead.bars[bi];
        const attrs = meterAttrs(ctx, bar0, timeChanges, tc);
        if (bi === 0) {
          // 多谱表声部：`<staves>` 与逐谱表的 `<clef number=n>`。
          // 行首的谱号与读音高时用的同一个（`clefFor`）：这一行没认出谱号的沿用上一系统的，不是一律高音谱号
          const codes = staves.map((st) => (st ? rowStartClef(entry, st) : null));
          const keys = codes.map((c) => (c ? clefKey(c) : ""));
          if (keys.join("|") !== prevClef.join("|")) {
            if (staves.length > 1) attrs.push(h("staves", null, staves.length), ...(prevClef.length ? [] : [partSymbolEl()]));
            codes.forEach((c, k) => c && attrs.push(clefOf(c, k)));
            prevClef = keys;
          }
          // 单线谱（打击乐，位图路 `Staff.oneLine`）：头一回露面写 `<staff-lines>1`
          staves.forEach((st, k) => {
            if (!st?.oneLine || oneLineDone.has(k)) return;
            oneLineDone.add(k);
            attrs.push(h("staff-details", { number: nStaves > 1 ? k + 1 : undefined }, h("staff-lines", null, 1)));
          });
          // 隐藏了一段之后重新露面；多谱表声部只印了其中几行的（望十架第三页长笛那行没印、钢琴右手照印），没印的那行单独藏
          attrs.push(...staffDetails(staves.map((st) => !!st)));
        }
        // 多小节休止：这个声部印出来的每行谱这一小节都只有一个带数字的 `restHBar`（数字一致），展开成那么多小节
        const multi = multiRestOf(staves, bi);
        if (multi > 1) attrs.push(h("measure-style", null, h("multiple-rest", null, multi)));
        // 被系统换行劈开的小节的后半截：系统里任一行谱配得上就算（一行认漏了音、凑不满，别的行照样配得上，232 主也爱我歌）
        const splitTail = entry.sys.staves.some((st) => st.bars[bi]?.splitTail);
        const [beats, beatType] = (prevTime ?? "4/4").split("/").map((v) => parseInt(v));
        const pickup = pickupTicks(entry, bi, ticks(beats / beatType));
        const m = h(
          "measure",
          { number: measureNo, implicit: splitTail || pickup ? "yes" : undefined },
          bi === 0 && printEl(si, pi),
          attrs.length && h("attributes", null, attrs),
          bar0 && barlineEl("left", { style: bar0.leftStyle, repeat: bar0.leftRepeat, ending: bar0.endingStart ? bar0.endingNumber : null }),
        );

        partStaffNo.clear();
        if (staves.length > 1) staves.forEach((st, k) => st && partStaffNo.set(st, k + 1));
        staves.forEach((st, k) => {
          if (!st) return;
          const bar = st.bars[bi];
          if (!bar) return;
          // 弱起小节里的整小节休止按弱起的实长写
          // 整小节休止（`restHBar`，或一小节里只有一个全休止）按拍号的实长写：2/4 小节里印的全休止是两拍（八段锦 m52）
          const own0 = barNotes(st, staves, bar);
          const whole = own0.length === 1 && own0[0].rest && (own0[0].sym.code === "restHBar" || own0[0].base === 1);
          const inBar = own0.map((n) => (pickup && n.sym.code === "restHBar" ? { ...n, duration: pickup / ticks(1) } : whole && !pickup ? { ...n, duration: beats / beatType } : n));
          // 行中换谱号（读音高时已经按它读了，`clefFor`）：写进这一小节，下一行行首要不要再写照它比
          const mids = midRowClefs(entry, st).filter((c) => c.box.left >= bar.left && c.box.left < bar.right);
          const midEls = mids.map((c) => ({ x: c.box.left, el: () => clefEl(c.code, staves.length > 1 ? k + 1 : undefined) }));
          if (mids.length) prevClef[k] = clefKey(mids[mids.length - 1].code);
          // 谱面上整小节什么都没印（八段锦钢片琴 m12）：写一个不显示的整小节休止占住时值
          if (!inBar.length && !midEls.length) {
            const dur = pickup ?? ticks(beats / beatType);
            const multiStaff = staves.length > 1;
            m.appendChild(h("note", { "print-object": "no" }, h("rest", { measure: "yes" }), h("duration", null, dur), multiStaff && h("voice", null, k * 4 + 1), multiStaff && h("staff", null, k + 1)));
            if (k < staves.length - 1) m.appendChild(backupEl(dur));
            return;
          }
          for (const x of emitVoices(inBar, ticks, staves.length > 1 ? k + 1 : 0, midEls, bar.right)) m.appendChild(x);
          const used = voiceTicks(inBar, ticks);
          // 换到下一行谱之前要把时间**倒回**小节头（MusicXML 的 `<backup>`）
          if (k < staves.length - 1 && used > 0) m.appendChild(backupEl(used));
        });

        const rightBar = () => (bar0 ? barlineEl("right", { style: bar0.rightStyle, repeat: bar0.rightRepeat, ending: bar0.endingStop ? bar0.endingNumber : null }) : null);
        if (multi <= 1) {
          const rb = rightBar();
          if (rb) m.appendChild(rb);
        }
        measures.push(m);
        // 多小节休止后面那几小节：各行一个整小节休止，右边的小节线挪到最后一小节
        for (let k = 1; k < multi; k++) {
          measureNo++;
          sysOfBar.push(si);
          const dur = ticks(beats / beatType);
          const rests = staves.flatMap((st, j) =>
            st ? [j ? backupEl(dur) : null, h("note", null, h("rest", { measure: "yes" }), h("duration", null, dur), h("voice", null, j * 4 + 1), staves.length > 1 && h("staff", null, j + 1))] : [],
          );
          measures.push(h("measure", { number: measureNo }, rests, k === multi - 1 && rightBar()));
        }
      }
    });
    renumberSlurs(measures, sysOfBar, opts.crossPageTies);
    parts.push(h("part", { id }, measures));
  });

  const doc = h(
    "score-partwise",
    { version: "3.0" },
    opts.title && h("work", null, h("work-title", null, opts.title)),
    defaults.length && h("defaults", null, defaults),
    creditEls(opts.credits, layout),
    h("part-list", null, partList),
    parts,
  );
  return doc;
}

/** 页边距至少这么多（pt，5mm）：墨迹贴边的扫描件量出来的边距是零 */
const MIN_PAGE_MARGIN_PT = (5 * 72) / 25.4;

/** 源谱版面：`<defaults>` 与各系统首小节的 `<print>`。 */
interface SourceLayout {
  /** `<defaults>` 里的 `<scaling>` 与 `<page-layout>`（每次新建一份：节点只能挂一处） */
  defaults(): XmlEl[];
  /** 首个系统那一页上的一个框 → credit 的落点（tenths：`default-x` 按对齐取左缘 / 中线 / 右缘，`default-y` 是框底离页底） */
  creditPos(box: { x: number; y: number; w: number; h: number }, justify?: string): { x: number; y: number };
  /** 第 `si` 个系统、第 `pi` 个声部首小节的 `<print>` */
  print(si: number, pi: number): XmlEl;
}

/**
 * **识别结果照原谱的分行、分页、纸张与谱表大小排**（排版端见 `mixed/layoutpass.ts` 的源谱版面档）：
 * scaling 取全曲谱表高的中位数（tenths 40 = 谱表高）；纸取首页，左右边距取各系统谱表左右缘的最外值，
 * 上边距取各页墨迹顶的最小值、下边距取最小值；每个系统首小节写 `new-system` / `new-page`、系统左右缩进、
 * 离上一系统（页首：离上边距）与各谱表离上一谱表的距离。横向与纵向的实际间距仍由引擎自己算、只撑不压。
 * `<system-layout>` 只写在第一声部：排版端认它当「源谱真实排出的行」（与简谱视图写出的优选断点区分）。
 */
function sourceLayout(score: StaffScore): SourceLayout | null {
  if (!score.systems.length) return null;
  // 页面坐标 → 点：尺寸不可信的页（图片）按页宽 = A4 宽折，原点 0
  const ppu = ptPerUnit;
  const ox = (pg: SPage) => (pg.sizeKnown ? pg.originPt.x : 0);
  const oy = (pg: SPage) => (pg.sizeKnown ? pg.originPt.y : 0);
  const X = (pg: SPage, x: number) => ox(pg) + x * ppu(pg);
  const Y = (pg: SPage, y: number) => oy(pg) + y * ppu(pg);
  const pageW = (pg: SPage) => (pg.sizeKnown && pg.sizePt ? pg.sizePt.w : pg.width * ppu(pg));
  const pageH = (pg: SPage) => (pg.sizeKnown && pg.sizePt ? pg.sizePt.h : pg.height * ppu(pg));
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
  const heights = score.systems.flatMap(({ page, sys }) =>
    sys.staves.filter((st) => st.lineYs.length === 5 && st.box.bottom > st.box.top).map((st) => (st.box.bottom - st.box.top) * ppu(page)),
  );
  if (!heights.length) return null;
  const staffPt = median(heights);
  const t = (pt: number) => Math.round((pt * 40) / staffPt);
  const first = score.systems[0]!.page;

  const ordered = score.systems.map(({ sys }) => [...sys.staves].sort((a, b) => a.box.top - b.box.top));
  // 引擎按声部次序自上而下叠谱表（声部次序是识别定的，未必与原图上下一致）：谱表距离按这个次序取「上一谱表」，
  // 与原图上下颠倒的（量出负数）用本谱相邻谱表距离的中位数
  const drawOrder = score.systems.map((_, si) =>
    score.parts.flatMap((part) => part.scoreStaves.map((ss) => ss.staves[si]).filter((st): st is Staff => !!st)),
  );
  const gaps = score.systems.flatMap(({ page }, si) =>
    ordered[si]!.slice(1).map((st, k) => (st.box.top - ordered[si]![k]!.box.bottom) * ppu(page)),
  ).filter((g) => g > 0);
  const typicalGap = gaps.length ? median(gaps) : staffPt * 2;
  const sysL = score.systems.map(({ page }, si) => X(page, Math.min(...ordered[si]!.map((st) => st.box.left))));
  const sysR = score.systems.map(({ page }, si) => X(page, Math.max(...ordered[si]!.map((st) => st.box.right))));
  const left = Math.max(0, Math.min(...sysL));
  const right = Math.max(0, Math.min(...score.systems.map(({ page }, si) => pageW(page) - sysR[si]!)));
  // 上边距：各页墨迹顶的最小值。下边距一律取最小值：末行的歌词本就印在最低谱表线以下，
  // 识别侧没有可靠的歌词墨迹框，量「最低谱表线到页底」会把末行的歌词当成出界（引擎不画页脚，用不着那片地方）
  const inkTops: number[] = [];
  for (const pg of new Set(score.systems.map((e) => e.page))) {
    const ys = [...pg.objs.map((o) => o.box.top), ...pg.staves.map((st) => st.box.top)];
    if (ys.length) inkTops.push(Y(pg, Math.min(...ys)));
  }
  const top = Math.max(MIN_PAGE_MARGIN_PT, inkTops.length ? Math.min(...inkTops) : 0);
  const bottom = MIN_PAGE_MARGIN_PT;
  const mm = Math.round(((staffPt * 25.4) / 72) * 100) / 100;

  return {
    defaults: () => [
      h("scaling", null, h("millimeters", null, mm), h("tenths", null, 40)),
      h(
        "page-layout",
        null,
        h("page-height", null, t(pageH(first))),
        h("page-width", null, t(pageW(first))),
        h(
          "page-margins",
          { type: "both" },
          h("left-margin", null, t(left)),
          h("right-margin", null, t(right)),
          h("top-margin", null, t(top)),
          h("bottom-margin", null, t(bottom)),
        ),
      ),
    ],
    creditPos(box, justify) {
      const x = justify === "right" ? box.x + box.w : justify === "center" ? box.x + box.w / 2 : box.x;
      return { x: t(X(first, x)), y: t(pageH(first) - Y(first, box.y + box.h)) };
    },
    print(si, pi) {
      const e = score.systems[si]!;
      const k = ppu(e.page);
      const prev = si > 0 ? score.systems[si - 1]! : null;
      const pageStart = !prev || prev.page !== e.page;
      const staves = ordered[si]!;
      const kids: XmlEl[] = [];
      if (pi === 0) {
        const lm = t(sysL[si]! - left);
        const rm = t(pageW(e.page) - right - sysR[si]!);
        const dist = pageStart
          ? h("top-system-distance", null, t(Y(e.page, staves[0]!.box.top) - top))
          : h("system-distance", null, t((staves[0]!.box.top - Math.max(...ordered[si - 1]!.map((st) => st.box.bottom))) * k));
        kids.push(h("system-layout", null, h("system-margins", null, h("left-margin", null, Math.max(0, lm)), h("right-margin", null, Math.max(0, rm))), dist));
      }
      const inOrder = drawOrder[si]!;
      score.parts[pi]!.scoreStaves.forEach((ss, n) => {
        const st = ss.staves[si];
        const at = st ? inOrder.indexOf(st) : -1;
        if (at <= 0) return;
        const gap = st!.box.top - inOrder[at - 1]!.box.bottom;
        kids.push(h("staff-layout", { number: n + 1 }, h("staff-distance", null, t(gap > 0 ? gap * k : typicalGap))));
      });
      return h("print", { "new-page": prev && pageStart ? "yes" : undefined, "new-system": prev && !pageStart ? "yes" : undefined }, kids);
    },
  };
}

/**
 * 歌词与文字指示的字号：全曲各字量出来的字号取中位数，写成 `<word-font>` / `<lyric-font>`（逐字写会把量的噪声也带进去；
 * 文字指示另在各自的 `<words font-size>` 上写，速度记号常比表情记号大）。
 */
function fontDefaults(score: StaffScore, notesOf: (staff: Staff) => StaffNote[]): XmlEl[] {
  const lyric: number[] = [];
  const word: number[] = [];
  for (const { sys } of score.systems)
    for (const st of sys.staves)
      for (const n of notesOf(st)) {
        for (const l of n.lyrics ?? []) {
          const pt = textPt(n, l.size);
          if (pt) lyric.push(pt);
        }
        for (const w of n.words ?? []) {
          const pt = textPt(n, w.size);
          if (pt) word.push(pt);
        }
      }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
  return [word.length ? h("word-font", { "font-size": median(word) }) : null, lyric.length ? h("lyric-font", { "font-size": median(lyric) }) : null].filter((x): x is XmlEl => !!x);
}

/** 页眉页脚 → `<credit page>`，一条一个（页眉在第 1 页，页脚每页一份）。 */
function creditEls(credits: StaffXmlOptions["credits"], layout?: SourceLayout | null): XmlEl[] {
  return (credits ?? []).map((c) => {
    // 写源谱版面时照原图的位置（框底对齐：OCR 的框底比字的基线更稳）
    const pos = layout && c.box ? layout.creditPos(c.box, c.justify) : null;
    const at = pos ? { "default-x": pos.x, "default-y": pos.y, valign: "bottom" } : {};
    return h(
      "credit",
      { page: c.page ?? 1 },
      c.type && h("credit-type", null, c.type),
      h("credit-words", { ...at, justify: c.justify || undefined, "font-size": c.size ? roundPt(c.size) : undefined }, c.text),
    );
  });
}

/** 跳转记号文字的播放语义（`<sound>`）：D.S. → 回到 segno、D.C. → 回到曲首、Fine → 收在这里、To Coda → 跳到 coda。别的文字不出 */
export function jumpSound(text: string): XmlEl | null {
  const t = text.trim();
  if (/^D\.?\s*S\b/i.test(t)) return h("sound", { dalsegno: "segno" });
  if (/^D\.?\s*C\b/i.test(t)) return h("sound", { dacapo: "yes" });
  if (/^fine\.?$/i.test(t)) return h("sound", { fine: "yes" });
  if (/^to\s*coda/i.test(t)) return h("sound", { tocoda: "coda" });
  return null;
}
