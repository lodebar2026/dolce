// 小节里的 `<direction>`（MusicXML / `.jpwabc` 来的力度、术语、跳转、文字、渐强渐弱）→ 简谱那套「挂在符号上的记号」。
//
// 简谱一路（文本谱视图 `jianpu/slots.ts::docView`、文本谱写出 `tofanqie.ts`）的记号都挂在音符/小节线上（`&mp` `&fine`），
// MusicXML 却是小节里独立的 direction，靠「游标位置 + `<offset>`」定拍位。两边在这里对齐，一份规则：
//   - 挂哪个符号：按**拍位**找——力度、术语、segno/coda、文字、渐强起点挂在拍位上（或之后）的第一个占时值的符号；
//     渐强收尾挂在拍位**之前**的最后一个（写出端 `xmlproject.ts::wedgeDirections` 把收尾写在收尾音的终点）；
//   - Fine / D.C. / D.S.：挂本小节的右线（唱到这里才跳）；
//   - 不是术语的文字（`副歌`）当段落词。
import type { Direction, DirectionPart, Element, Measure, Song, SourceOrnament } from "./doc";
import { TERMS, isDynamicName } from "./marknames";
import { decoKey } from "./deconames";
import { melodyLane } from "./jianpu";

/** 文字术语 → 记号名（MusicXML 的 `<words>rit.</words>`）。 */
export const TERM_OF: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TERMS).map(([name, text]) => [text, name]),
);

/** 挂在小节右线上的跳转记号（唱到这里才跳）。 */
const AT_BAR_END = new Set(["fine", "dc", "ds"]);

export interface DirectionMarks {
  /** 挂在本小节第几个元素上的记号（下标是 `Measure.elements` 的下标） */
  byElement: Map<number, SourceOrnament[]>;
  /** 挂在本小节右线上的（Fine / D.C. / D.S.） */
  barEnd: SourceOrnament[];
  /** 不是术语的文字：挂在第几个元素上当段落词 */
  words: Map<number, string>;
  /** 渐强渐弱的起止：按出现顺序，`index` 同 `byElement` */
  wedges: ({ edge: "start"; type: "crescendo" | "diminuendo"; index: number } | { edge: "stop"; index: number })[];
}

const timed = (el: Element): boolean => (el.kind === "chord" ? !el.grace : el.spacer === "x");

export function directionMarks(mea: Measure): DirectionMarks {
  const out: DirectionMarks = { byElement: new Map(), barEnd: [], words: new Map(), wedges: [] };
  const dirs = mea.directions ?? [];
  if (!dirs.length) return out;
  // 各元素的起点、终点（divisions）：多声部一小节里各声部从头排（`<backup>` 记在 `onset` 上），缺省接前一个元素的终点
  const onset: number[] = [];
  const end: number[] = [];
  let pos = 0;
  for (const el of mea.elements) {
    const at = (el.kind === "chord" || el.kind === "space" ? el.onset : undefined) ?? pos;
    onset.push(at);
    pos = at + (timed(el) ? Math.round(el.duration?.divisions ?? 0) : 0);
    end.push(pos);
  }
  // 挂靠只挑旋律那一路（简谱印的那一路；别的声部写出端不写，挂上去就丢了）
  const lane = melodyLane(mea);
  const inLane = (el: Element): boolean => !lane || el.kind !== "chord" || (el.staff === lane.staff && el.voice === lane.voice);
  const timedIdx = mea.elements.map((el, i) => (timed(el) && inLane(el) ? i : -1)).filter((i) => i >= 0);
  if (!timedIdx.length) return out;
  const posOf = (dir: { afterElements?: number; offset?: number; onset?: number }): number => {
    const k = dir.afterElements;
    const base = dir.onset ?? (k === undefined || k === 0 ? 0 : end[Math.min(k, end.length) - 1]!);
    const p = base + (dir.offset ?? 0);
    // 落在某个音中间的（`<offset>` 多是排版软件的微调，破碎 m30 渐强 offset 1/8 个八分）取最近的拍位：前半段算这个音、后半段算下一个。
    // 不取整就被推到下一个音，转成简谱文本再读回挪了一个音
    const i = timedIdx.find((j) => onset[j]! < p - 1e-6 && p < end[j]! - 1e-6);
    return i === undefined ? p : p - onset[i]! < (end[i]! - onset[i]!) / 2 ? onset[i]! : end[i]!;
  };
  /** 拍位上（或之后）的第一个占时值的符号 */
  const atOrAfter = (p: number): number => timedIdx.find((i) => onset[i]! >= p - 1e-6) ?? timedIdx[timedIdx.length - 1]!;
  /** 拍位之前的最后一个 */
  const before = (p: number): number => {
    let best = timedIdx[0]!;
    for (const i of timedIdx) if (onset[i]! < p - 1e-6) best = i;
    return best;
  };
  const push = (i: number, name: string): void => {
    const list = out.byElement.get(i) ?? [];
    if (!list.some((o) => o.name === name)) list.push({ name, level: 0 });
    out.byElement.set(i, list);
  };
  for (const dir of dirs) {
    const p = posOf(dir);
    for (const part of [dir, ...(dir.more ?? [])]) {
      if (part.type === "wedge") {
        if (part.spanType === "start" && part.wedgeType) out.wedges.push({ edge: "start", type: part.wedgeType, index: atOrAfter(p) });
        else if (part.spanType === "stop") out.wedges.push({ edge: "stop", index: before(p) });
        continue;
      }
      let name: string | undefined;
      if (part.type === "dynamics" && part.text && isDynamicName(part.text)) name = part.text;
      else if (part.type === "segno" || part.type === "coda") name = decoKey(part.type);
      // 排练号（方框字母）挂在拍位上的音上，记号名带内容：`rehearsal=A`（123 的 `!rehearsal=A!`，`deconames.ts::rehearsalOf`）
      else if (part.type === "rehearsal" && part.text?.trim()) name = `rehearsal=${part.text.trim()}`;
      else if (part.type === "words" && part.text) {
        const t = part.text.trim();
        name = TERM_OF[t] ?? decoKey(t);
        // 同一拍上两段文字（曲首「欢快 热烈地」与「pizz」）分行挂在同一个音上（换行隔开、先出现的在上，ABC §4.19）；
        // 以前空格连成一行、再早后一段直接丢了
        if (!name && t) {
          const at = atOrAfter(p);
          const had = out.words.get(at);
          if (had === undefined) out.words.set(at, t);
          // 括号两侧不加空格：「(」与「副歌)」拆成两段写的（500 首 006）并回「(副歌)」
          else if (!had.split("\n").includes(t)) out.words.set(at, /[(（\[【《“]$/.test(had) || /^[)）\]】》”,，.。;；:：!！?？]/.test(t) ? had + t : `${had}\n${t}`);
        }
      }
      if (!name) continue;
      if (AT_BAR_END.has(name)) {
        if (!out.barEnd.some((o) => o.name === name)) out.barEnd.push({ name, level: 0 });
      } else push(atOrAfter(p), name);
    }
  }
  return out;
}

/**
 * 落在小节末、后面已经没有音的 direction（`<offset>` 把它推过了最后一个音，望十架 m57 的 f、m68 的 mp）挪到下一小节开头：
 * 它管的是下一小节的头一个音。不挪的话挂靠找不到之后的音，退回挂在本小节最后一个音上，转成简谱文本读回提前了。
 * 只挪力度：文字、渐强渐弱、跳转（Fine / D.S. / To Coda 是写在小节末的）、速度不挪。最后一小节不挪。就地改。
 */
export function carryLateDirections(song: Song): void {
  // 文字（cresc.、dim. poco a poco）与渐强起点写在小节末多半就是管小节末的，挪了反而错（望十架、破碎实测）
  const movable = (x: DirectionPart): boolean => x.type === "dynamics";
  for (const part of song.parts) {
    part.measures.forEach((mea, mi) => {
      const next = part.measures[mi + 1];
      if (!next || !mea.directions?.length) return;
      const end: number[] = [];
      let pos = 0;
      for (const el of mea.elements) {
        pos = ((el.kind === "chord" || el.kind === "space" ? el.onset : undefined) ?? pos) + (timed(el) ? Math.round(el.duration?.divisions ?? 0) : 0);
        end.push(pos);
      }
      const measureEnd = Math.max(0, ...end);
      if (!measureEnd) return;
      const late = (d: Direction): boolean => {
        if (![d, ...(d.more ?? [])].every(movable)) return false;
        const k = d.afterElements;
        const base = d.onset ?? (k === undefined || k === 0 ? 0 : end[Math.min(k, end.length) - 1]!);
        const p = base + (d.offset ?? 0);
        // 最后一个音的后半段同 `directionMarks` 的取整：算下一个拍位，也就是小节末
        const lastStart = measureEnd - Math.round(([...mea.elements].reverse().find((el) => timed(el))?.duration?.divisions) ?? 0);
        return p >= measureEnd - 1e-6 || (p > lastStart + 1e-6 && p - lastStart >= (measureEnd - lastStart) / 2);
      };
      const moved = mea.directions.filter(late);
      if (!moved.length) return;
      mea.directions = mea.directions.filter((d) => !moved.includes(d));
      if (!mea.directions.length) delete mea.directions;
      next.directions = [...moved.map((d) => {
        const nd: Direction = { ...d, afterElements: 0 };
        delete nd.onset;
        delete nd.offset;
        return nd;
      }), ...(next.directions ?? [])];
    });
  }
}

/** 拍单位 → 占几分之几全音符（附点另乘 3/2） */
const BEAT_UNIT: Readonly<Record<string, { num: number; den: number }>> = {
  whole: { num: 1, den: 1 }, half: { num: 1, den: 2 }, quarter: { num: 1, den: 4 }, eighth: { num: 1, den: 8 }, "16th": { num: 1, den: 16 },
};

const isTempo = (p: DirectionPart): boolean => p.type === "metronome" && !!p.tempo?.perMinute;

/** 曲首速度在哪：第几声部、第几小节、第几条 direction、其中第几个子元素（0 = 主体，k ≥ 1 = `more[k-1]`）。
 *  全曲第一个速度落在头两个小节里才算（识别出来的常挂在第一个音之后、弱起曲子落在第二小节）。 */
function leadTempoAt(song: Song): { pi: number; mi: number; i: number; k: number } | null {
  for (let pi = 0; pi < song.parts.length; pi++) {
    const part = song.parts[pi]!;
    const mi = part.measures.findIndex((m) => (m.directions ?? []).some((d) => [d, ...(d.more ?? [])].some(isTempo)));
    if (mi < 0 || mi > 1) continue;
    const dirs = part.measures[mi]!.directions!;
    const i = dirs.findIndex((d) => [d, ...(d.more ?? [])].some(isTempo));
    return { pi, mi, i, k: [dirs[i]!, ...(dirs[i]!.more ?? [])].findIndex(isTempo) };
  }
  return null;
}

/** 歌的曲首速度：`tempos` 里的数字（123 `Q:`、文本谱 `J:`），没有就取 MusicXML 曲首的 `<metronome>`。
 *  `beat` 是拍单位占几分之几全音符（四分 = 1/4）。 */
export function leadTempo(song: Song): { perMinute: number; beat: { num: number; den: number } } | null {
  const n = song.tempos?.find((t): t is number => typeof t === "number");
  if (n !== undefined) return { perMinute: n, beat: song.tempoBeat ?? { num: 1, den: 4 } };
  const at = leadTempoAt(song);
  if (!at) return null;
  const d = song.parts[at.pi]!.measures[at.mi]!.directions![at.i]!;
  const t = [d, ...(d.more ?? [])][at.k]!.tempo!;
  const u = BEAT_UNIT[t.beatUnit ?? "quarter"] ?? BEAT_UNIT.quarter!;
  return { perMinute: t.perMinute!, beat: t.beatUnitDot ? { num: u.num * 3, den: u.den * 2 } : u };
}

/**
 * 曲首的速度 `<metronome>`（MusicXML 写在第一小节的 direction 里）→ 歌的 `tempos`（123 `Q:`、文本谱 `J:` 写的就是它）。
 * 歌已有 `tempos` 或全曲头一个速度不在头两小节里的不动——曲中变速简谱文本格式写不出（以前曲首这条也一起丢了）。
 */
function liftLeadTempo(song: Song): void {
  if (song.tempos?.length) return;
  const at = leadTempoAt(song);
  const lead = leadTempo(song);
  if (!at || !lead) return;
  song.tempos = [lead.perMinute];
  if (lead.beat.num * 4 !== lead.beat.den) song.tempoBeat = lead.beat;
  const dirs = song.parts[at.pi]!.measures[at.mi]!.directions!;
  const dir = dirs[at.i]!;
  // 速度常与表情术语同在一个 `<direction>` 里（「欢快 热烈地」+ ♩=144，落在 `more`）：只摘掉速度那一个。
  // 主体那份要拷一份：下面顶替主体时会先删掉 `dir` 自己的字段
  const rest = [{ ...dir } as DirectionPart, ...(dir.more ?? [])].filter((_, j) => j !== at.k);
  if (!rest.length) dirs.splice(at.i, 1);
  else {
    // 剩下的子元素顶上来当这条 direction 的主体
    const [head, ...more] = rest;
    for (const key of ["type", "text", "tempo", "spanType", "wedgeType", "line", "shift"] as const) delete dir[key];
    Object.assign(dir, head);
    if (more.length) dir.more = more;
    else delete dir.more;
  }
}

/** 跳转目标记号的短名 → 123 / ABC 的写法（`!segno!`，见 `abcfamily/jumpmarks.ts`）。 */
const TEXT_NAME: Readonly<Record<string, string>> = { hs: "segno", ty: "coda" };

/**
 * 简谱文本写出端（123 / ABC / jcx）用：小节里的 `<direction>` 换成简谱那套写法——力度、术语、segno/coda
 * 进挂靠符号的 `notations.articulations`（`!mf!`），Fine / D.C. / D.S. 进右线的 `ornaments`（`!D.S.!|`），
 * 不是术语的文字当段落词，渐强渐弱换成 `wedge` 记号；之后删掉 `directions`。
 * 挂靠规则与排版视图同一份（`directionMarks`）。没有 direction 的歌原样返回，有的先克隆、不动原件。
 * 以前不换：MusicXML 转出来的 123 丢了全部力度与跳转（064《啊！圣善夜》的 D.S. / D.C.）。
 */
export function directionsAsMarks(src: Song): Song {
  if (!src.parts.some((p) => p.measures.some((m) => m.directions?.length))) return src;
  const song: Song = structuredClone(src);
  liftLeadTempo(song);
  carryLateDirections(song);
  for (const part of song.parts) {
    // 渐强渐弱常跨小节：起点留着等后面小节的收尾
    const open: { type: "crescendo" | "diminuendo"; id: number }[] = [];
    for (const mea of part.measures) {
      if (!mea.directions?.length) continue;
      const dm = directionMarks(mea);
      for (const [i, orns] of dm.byElement) {
        const el = mea.elements[i];
        if (el?.kind !== "chord") continue;
        // 小节第一个符号上的 segno / coda 是左线上的跳转目标（123 读 `| !segno! 5` 就这么记，`abcfamily/parse.ts`），照它记才往返不变
        if (i === 0) {
          for (const o of orns.filter((x) => x.name in TEXT_NAME)) {
            const bls = (mea.barlines ??= []);
            const left = bls.find((b) => b.location === "left");
            if (left) (left.ornaments ??= []).push({ name: o.name, level: 0 });
            else bls.push({ location: "left", ornaments: [{ name: o.name, level: 0 }] });
          }
        }
        const arts = (el.notations ??= {}).articulations ??= [];
        for (const o of orns) {
          if (i === 0 && o.name in TEXT_NAME) continue;
          const name = TEXT_NAME[o.name] ?? o.name;
          if (!arts.includes(name)) arts.push(name);
        }
      }
      if (dm.barEnd.length) {
        let right = (mea.barlines ?? []).find((b) => b.location === "right");
        if (!right) (mea.barlines ??= []).push((right = { location: "right", style: "regular" }));
        const own = (right.ornaments ??= []);
        for (const o of dm.barEnd) if (!own.some((x) => x.name === o.name)) own.push({ name: o.name, level: 0 });
      }
      for (const [i, text] of dm.words) {
        const el = mea.elements[i];
        if (el?.kind === "chord" && el.sectionWord === undefined) el.sectionWord = text;
      }
      for (const w of dm.wedges) {
        const el = mea.elements[w.index];
        if (!el) continue;
        if (w.edge === "start") open.push({ type: w.type, id: el.id });
        else {
          const st = open.shift();
          if (st) song.marks.push({ type: "wedge", start: st.id, end: el.id, wedgeType: st.type });
        }
      }
      delete mea.directions;
    }
  }
  return song;
}
