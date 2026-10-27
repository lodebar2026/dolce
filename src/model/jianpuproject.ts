// MusicXML 形状的 `Song` → **简谱形状**的 `Song`：简谱排版（`jianpu/slots.ts`）与 123 写出端之前的投影。
// 与 `xmlproject.ts` 方向相反，判据同一条（`xmlproject.ts::isXmlShaped`）。
//
// ## 为什么要有这一层
//
// `fromxml.ts` 读进来的是 MusicXML 的表达：时值是 `<type>` + `<dot>` + 以 `attrs.divisions` 为分母的
// `divisions`，`beams` 是 `<beam>` 元素（没连杠的八分音符、八分休止根本没有），和弦是结构化的
// `<harmony>`、长音中途换的和弦带 `offset`。简谱侧读的却是：`beams` = 减时线条数、`dots` = 简谱附点、
// 四分以上的长音拆成增时线（`sustains`）、和弦是原文。直接喂过去，附点二分 `5 - -` 会画成附点四分、
// 单个八分音符画成四分、和弦一个都不显示——这里把前者投成后者。
//
// 模型本身不动（`.musicxml` 重写要逐字节稳定），在克隆上投影，按 `Song` 对象缓存。
//
// 原生 ABC（`abcfamily/parse.ts::parseAbc`）是第三种：时值只在 `divisions`（分母 `SIMPLE_DIVISIONS`，与简谱来源同口径），
// 却没有 `attrs.divisions`，也不带 `beams`/`sustains`。不投的话全曲一律画成四分音符（减时线、增时线全丢），
// 所以同走这一层（`isDurationShaped`）；音上的延音线顺带配成 `tied` 记号。
//
// 判据对照：简谱输入模型的 MusicXML 形状分支（`jianpuinput.ts::xmlDuration`）读时值的口径，
// 回归 `scripts/jianpu-shape-check.mjs` 逐音比对。

import { SIMPLE_DIVISIONS, type Chord, type Element, type ElementId, type Harmony, type Measure, type PageText, type Song } from "./doc";
import { harmonyText, jianpuShape, nominalQuarters } from "./jianpu";
import { isXmlShaped, tiesToMarks } from "./xmlproject";
import { creatorTypeOf } from "./metakeys";
import { carryLateDirections } from "./directionmarks";

/** 简谱来源的时值单位（四分音符的 divisions） */
const Q = SIMPLE_DIVISIONS;

const cache = new WeakMap<Song, Song>();

/** 时值只记在 `divisions` 里的简谱来源（原生 ABC）：全曲没有一条减时线、一个增时线，
 *  却有不是四分的音。123/文本谱/识别产物只要有一个八分或长音就带着 `beams`/`sustains`，不会被认错；
 *  全是四分的那种认不认都一样。 */
function isDurationShaped(song: Song): boolean {
  let offShape = false;
  for (const p of song.parts) {
    for (const m of p.measures) {
      for (const el of m.elements) {
        if (el.kind !== "chord" || el.grace || el.continued) continue;
        if (el.beams?.length || el.sustains?.length) return false;
        if (!offShape) {
          const s = jianpuShape(nominalQuarters(el, Q));
          offShape = s.beams > 0 || s.sustains > 0 || s.dots !== el.duration.dots;
        }
      }
    }
  }
  return offShape;
}

export function projectForJianpu(src: Song): Song {
  const hit = cache.get(src);
  if (hit) return hit;
  const xml = isXmlShaped(src);
  if (!xml && !isDurationShaped(src)) return src;
  const song: Song = structuredClone(src);
  // 同一谱表上的几个声部（ABC/123 的 `&`、MusicXML 的 `<voice>`）都留着：123 写出端按 `&` 写回，
  // 简谱行视图把主声部以外的收成并排块（`jianpu/slots.ts::overlayLayers`）。MusicXML 靠 `<forward>` 留的空拍
  // 这里补成不可见休止，好让每个声部各自从小节起点线性排下去。
  if (xml) {
    creatorsFromCredits(song);
    headerFromCredits(song);
    // 落在小节末的力度、文字挂到下一小节头（简谱视图、文本谱写出都按 `directionMarks` 挂靠，与 123 / ABC 写出端同一口径）
    carryLateDirections(song);
  }
  // ABC 的延音线只标在音上（`C3- C3`），简谱画成弧要按 id 配成 `tied` 记号（`slots.ts` 归弧线）
  else tiesToMarks(song);
  let nextId = maxId(song) + 1;
  const newId = (): ElementId => nextId++;
  if (xml) for (const part of song.parts) fillVoiceGaps(part, newId);
  for (const part of song.parts) {
    let divisions = xml ? 1 : Q;
    let carry: Harmony[] = [];
    for (const m of part.measures) {
      if (m.attrs?.divisions !== undefined) divisions = m.attrs.divisions;
      carry = projectMeasure(m, divisions, newId, carry);
      if (m.attrs) delete m.attrs.divisions;
      // MusicXML 的普通小节不写 `<barline>`，模型里就没有右线；简谱这边「没有右线」是行末开口的小节
      // （文本谱/123 跨行接着写同一小节），行视图不出小节线元素（`jianpu/slots.ts::buildRow`），展开档就整行并成一个大小节
      if (xml) {
        const right = (m.barlines ?? []).find((bl) => bl.location === "right");
        if (!right) (m.barlines ??= []).push({ location: "right", style: "regular" });
        else if (right.style === undefined) right.style = "regular";
      }
    }
    // 曲末还欠着的和弦：挂回最后一个音符（记为落不到拍位）
    const last = part.measures.flatMap((m) => m.elements).reverse().find((e): e is Chord => e.kind === "chord");
    if (carry.length && last) last.laterHarmonies = [...(last.laterHarmonies ?? []), ...carry];
  }
  cache.set(src, song);
  return song;
}

/** 各声部的空拍（`onset` 晚于本声部游标）补不可见休止，并去掉 `onset`（单位是 MusicXML 的 divisions，原样用）。
 *  只有一个声部的也补：拆开的大谱表（`staves.ts::splitStaves`）里跨谱表的声部前半在另一条谱表上，留下的音从小节中间起；
 *  后半在另一条谱表上的，按记下的小节长（`Measure.duration`）在首个声部末尾补齐，读回各谱表小节等长。 */
function fillVoiceGaps(part: Song["parts"][number], newId: () => ElementId): void {
  for (const m of part.measures) {
    const voices = new Set(m.elements.filter((e) => e.kind === "chord").map((e) => e.voice));
    if (voices.size < 2 && !m.duration && !m.elements.some((e) => e.kind === "chord" && e.onset)) continue;
    const out: Element[] = [];
    const cursor = new Map<number, number>();
    let end = 0;
    for (const el of m.elements) {
      if (el.kind !== "chord") {
        out.push(el);
        continue;
      }
      const start = el.onset ?? end;
      const at = cursor.get(el.voice) ?? 0;
      if (start > at + 1e-9 && !el.grace) {
        const gap = start - at;
        out.push({ kind: "chord", id: newId(), notes: [], rest: {}, printObject: false, duration: { divisions: gap, dots: 0 }, voice: el.voice, staff: el.staff });
      }
      delete el.onset;
      out.push(el);
      end = start + (el.grace ? 0 : el.duration.divisions);
      cursor.set(el.voice, end);
    }
    const first = out.find((e): e is Chord => e.kind === "chord");
    const lack = (m.duration ?? 0) - (first ? cursor.get(first.voice) ?? 0 : 0);
    if (first && lack > 1e-9) {
      let at = out.length;
      while (at > 0 && !(out[at - 1]!.kind === "chord" && out[at - 1]!.voice === first.voice)) at--;
      out.splice(at, 0, { kind: "chord", id: newId(), notes: [], rest: {}, printObject: false, duration: { divisions: lack, dots: 0 }, voice: first.voice, staff: first.staff });
    }
    // 小节长已落成休止；它的单位是 MusicXML 的 divisions，留着会被当成投影后的口径
    delete m.duration;
    m.elements = out;
  }
}

/** 123 的 `C:` 取自 `identification`。识别出的与不少排版软件导出的 MusicXML 把词曲只写在 `<credit>` 里：
 *  没有 creator 时，把标题、副标题、版权以外的 credit 当作者行（`.jpwabc` 那一路的 `WordsByAndMusicBy` 同口径） */
export function creatorsFromCredits(song: Song): void {
  if (song.identification?.creators.length) {
    printedCreators(song);
    return;
  }
  const skip = new Set(["title", "subtitle", "rights", "page-number"]);
  const title = song.work.title?.trim();
  const creators = (song.credits ?? [])
    .filter((c) => !(c.type && skip.has(c.type)) && c.text.trim() && c.text.trim() !== title)
    .map((c) => ({ type: c.type ?? "composer", text: c.text.replace(/\n/g, " ").trim() }));
  if (creators.length) song.identification = { ...(song.identification ?? {}), creators };
}

/**
 * 副标题与页脚：MusicXML 只写在 `<credit>` 里的（`credit-type` 是 subtitle 的；页面下四分之一的那几条），
 * 123 / 文本谱有对应字段（`T:` 第二行起、`I:bottomcenter`），以前转出去就没了（《八段锦》的「（民乐合奏）」与页脚）。
 * 页脚每页一条、只差末尾页码的（「《八段锦》（民乐合奏） 1」「… 2」）去掉页码记一条——简谱页脚只在末页印一次、不带页码。
 */
export function headerFromCredits(song: Song): void {
  const credits = song.credits ?? [];
  if (!song.work.subtitles.length) {
    const subs = credits.filter((c) => c.type === "subtitle" && c.text.trim()).map((c) => c.text.trim());
    if (subs.length) song.work.subtitles = [...new Set(subs)];
  }
  headTextFromCredits(song);
  const pt = song.pageText;
  if (pt && (pt.bottomLeft.length || pt.bottomCenter.length || pt.bottomRight.length)) return;
  const h = song.defaults?.pageLayout?.pageHeight;
  const head = new Set(["title", "subtitle", "composer", "lyricist", "arranger", "poet"]);
  const feet = credits.filter((c) => c.text.trim() && !(c.type && head.has(c.type)) && h !== undefined && c.y !== undefined && c.y < h / 4);
  if (!feet.length) return;
  const strip = (t: string): string => t.trim().replace(/\s*\d+$/, "");
  const side = (c: (typeof feet)[number]): "bottomLeft" | "bottomCenter" | "bottomRight" =>
    c.justify === "left" ? "bottomLeft" : c.justify === "right" ? "bottomRight" : "bottomCenter";
  const out: PageText = { topLeft: [], topRight: [], bottomLeft: [], bottomCenter: [], bottomRight: [], ...(pt ?? {}) };
  for (const c of feet) {
    // 带页码的那几条按去掉页码后的文字并一条；不带的照原文
    // 末尾的数字就是本页页码（单页的谱也照样去掉）
    const pageNo = /(\d+)$/.exec(c.text.trim())?.[1];
    const many = feet.filter((o) => strip(o.text) === strip(c.text)).length > 1;
    const text = many || (pageNo !== undefined && Number(pageNo) === (c.page ?? 1)) ? strip(c.text) : c.text.trim();
    if (text && !out[side(c)].includes(text)) out[side(c)].push(text);
  }
  song.pageText = out;
}

const CREATOR_TYPES = new Set(["composer", "lyricist", "arranger", "translator", "poet", "words-and-music", "transcriber"]);

/** 第一页上半页的 credit（页脚、页码不算）。 */
function headCredits(song: Song): NonNullable<Song["credits"]> {
  const h = song.defaults?.pageLayout?.pageHeight;
  return (song.credits ?? []).filter((c) => (c.page ?? 1) === 1 && c.text.trim() && !/^\d+$/.test(c.text.trim()) && !(h !== undefined && c.y !== undefined && c.y < h / 2));
}

/** 比对用：去空白与标点、不分大小写（「Dudley-Smith」与「Dudley Smith」算同一个） */
const looseNorm = (t: string): string => t.toLowerCase().replace(/[\s\p{P}]/gu, "");

/** 署名照谱面印的写：`<creator>` 的每个词都出现在页眉某条 credit 里（「Timothy Dudley-Smith词 1926」、几位合印一行
 *  「词：John Newton 曲：American Melody」），`C:` 就写那条印出来的文字——123 / ABC 的 `C:` 是印在谱上的署名行。
 *  只含一位的沿用它的类型，合印的按标签认（`metakeys.ts::creatorTypeOf`），认不出取第一位的。没被哪条包含的照旧 */
function printedCreators(song: Song): void {
  const creators = song.identification!.creators;
  // 按空白与标点切词（「陈尚哲编曲（Ricardo Chan）」切成三个）
  const words = (t: string): string[] => t.split(/[\s\p{P}]+/u).map(looseNorm).filter(Boolean);
  const covers = (line: string, cr: (typeof creators)[number]): boolean => words(cr.text).length > 0 && words(cr.text).every((w) => line.includes(w));
  // 一条 credit 里分几行印的保留换行（`C:` 逐行写，读回各是一行）
  const lines = headCredits(song).filter((c) => !c.type || CREATOR_TYPES.has(c.type)).map((c) => c.text.trim());
  const used = new Set<(typeof creators)[number]>();
  /** 第几条 credit → 写成的署名 */
  const out = new Map<number, (typeof creators)[number]>();
  lines.forEach((text, i) => {
    const hit = creators.filter((cr) => !used.has(cr) && covers(looseNorm(text), cr));
    if (!hit.length) return;
    for (const cr of hit) used.add(cr);
    out.set(i, { ...hit[0]!, type: hit.length === 1 ? hit[0]!.type : creatorTypeOf(text) ?? hit[0]!.type, text });
  });
  // 一位署名分印在两行（「陈尚哲编曲」/「Arranged by Ricardo Chan」；左右两栏交错排的不相邻）：两行各写一条，类型同这一位
  for (const cr of creators) {
    if (used.has(cr)) continue;
    let pair: [number, number] | null = null;
    for (let i = 0; i < lines.length && !pair; i++) {
      for (let j = i + 1; j < lines.length && !pair; j++) {
        if (!out.has(i) && !out.has(j) && covers(looseNorm(lines[i]! + lines[j]!), cr)) pair = [i, j];
      }
    }
    if (!pair) continue;
    used.add(cr);
    for (const k of pair) out.set(k, { ...cr, text: lines[k]! });
  }
  if (out.size) song.identification!.creators = [...[...out].sort((a, b) => a[0] - b[0]).map(([, c]) => c), ...creators.filter((c) => !used.has(c))];
}

/** 页眉里没写类型、标题/副标题/署名又没包含的几条 credit（左上的出处、右上的诗歌本名、标题下的英文标题）：
 *  靠左的进左上、靠右的进右上（`I:topleft` / `I:topright`），居中的当副标题。署名那几条合印成一行的（「词：… 曲：…」）算已包含。
 *  只看第一页上半页（页脚另由 `headerFromCredits` 收）；原文已有页面文字的（123 读进来又投成 MusicXML 的）不动 */
function headTextFromCredits(song: Song): void {
  if (song.pageText?.topLeft.length || song.pageText?.topRight.length) return;
  const norm = (t: string): string => t.replace(/\s+/g, "");
  const creators = (song.identification?.creators ?? []).map((c) => norm(c.text)).filter(Boolean);
  const known = new Set([song.work.title, song.work.movementTitle, ...song.work.subtitles, ...creators].filter((t): t is string => !!t).map(norm));
  const covered = (t: string): boolean => known.has(norm(t)) || (creators.length > 1 && creators.every((c) => norm(t).includes(c)));
  const left: string[] = [], right: string[] = [], subs: string[] = [];
  for (const c of headCredits(song)) {
    const text = c.text.trim();
    if (c.type || covered(text)) continue;
    (c.justify === "left" ? left : c.justify === "right" ? right : subs).push(text);
    known.add(norm(text));
  }
  if (left.length || right.length) {
    const pt: PageText = { topLeft: [], topRight: [], bottomLeft: [], bottomCenter: [], bottomRight: [], ...(song.pageText ?? {}) };
    pt.topLeft.push(...left);
    pt.topRight.push(...right);
    song.pageText = pt;
  }
  song.work.subtitles.push(...subs);
}

function maxId(song: Song): number {
  let max = 0;
  for (const p of song.parts) {
    for (const m of p.measures) {
      for (const el of m.elements) {
        max = Math.max(max, el.id);
        if (el.kind === "chord") for (const su of el.sustains ?? []) max = Math.max(max, su.id);
      }
    }
  }
  return max;
}

const textOf = (h: Harmony): Harmony => (h.text !== undefined ? h : { ...h, text: harmonyText(h) });

/** @returns 小节末尾挂不进本小节、要顺延给下一小节第一个音的和弦 */
function projectMeasure(m: Measure, divisions: number, newId: () => ElementId, carryIn: Harmony[]): Harmony[] {
  const out: Element[] = [];
  /** 每个音符的实际起点（四分音符为 1），小节末的 `y` 和弦按它找落点 */
  const startOf = new Map<Chord, number>();
  /** 各声部各自的游标（多声部小节里第二声部从小节起点重新算） */
  const posOf = new Map<number, number>();
  const trailing: Harmony[] = [];
  for (const el of m.elements) {
    const pos = posOf.get(el.voice) ?? 0;
    if (el.kind === "space" && el.spacer === "y") {
      // `fromxml.ts` 只在小节末尾造 `y`：音符后面还欠着的 `<harmony>`。简谱侧的 `y` 会画成一拍隐藏休止，这里拆掉
      if (el.harmony) trailing.push(el.harmony);
      continue;
    }
    if (el.kind === "chord" && !el.grace) {
      startOf.set(el, pos);
      posOf.set(el.voice, pos + el.duration.divisions / divisions);
    } else if (el.kind === "space" && el.duration) {
      posOf.set(el.voice, pos + el.duration.divisions / divisions);
    }
  }
  const measureEnd = Math.max(0, ...posOf.values());
  const firstChord = m.elements.find((e): e is Chord => e.kind === "chord" && !e.grace);
  if (firstChord && carryIn.length) {
    for (const h of carryIn) {
      if (!firstChord.harmony) firstChord.harmony = { ...h, offset: 0 };
      else (firstChord.laterHarmonies ??= []).push({ ...h, offset: 0 });
    }
  }
  for (const el of m.elements) {
    if (el.kind === "space" && el.spacer === "y") continue;
    if (el.harmony) el.harmony = textOf(el.harmony);
    if (el.kind === "space") {
      if (el.duration) {
        const s = jianpuShape(nominalQuarters(el, divisions));
        el.duration = { divisions: Math.round(nominalQuarters(el, divisions) * Q), dots: s.dots };
        el.beams = s.beams ? Array.from({ length: s.beams }, () => "continue" as const) : undefined;
        if (!el.beams) delete el.beams;
      }
      out.push(el);
      continue;
    }
    const ch = el;
    const q = nominalQuarters(ch, divisions);
    // ABC 的倚音不带时值（`{/D}`）：原样留着，`slots.ts` 按八分画（与 123 的倚音同）
    if (ch.grace && q <= 0) {
      out.push(ch);
      continue;
    }
    const s = jianpuShape(q);
    const shaped: Chord["duration"] = { divisions: ch.grace ? 0 : Math.round(q * Q), dots: s.dots };
    if (ch.duration.type) shaped.type = ch.duration.type;
    ch.duration = shaped;
    if (s.beams) ch.beams = Array.from({ length: s.beams }, () => "continue" as const);
    else delete ch.beams;

    if (ch.grace || s.sustains === 0) {
      placeLaterHarmonies(ch, [], divisions);
      out.push(ch);
      continue;
    }
    if (ch.rest) {
      // 简谱的长休止写成几个 0，不写增时线
      const beats = Math.floor(q + 1e-9);
      ch.duration = { divisions: Q, dots: 0 };
      const later = [...(ch.laterHarmonies ?? [])];
      delete ch.laterHarmonies;
      out.push(ch);
      for (let k = 1; k < beats; k++) {
        const r: Chord = { kind: "chord", id: newId(), notes: [], rest: {}, duration: { divisions: Q, dots: 0 }, voice: ch.voice, staff: ch.staff };
        if (ch.printObject === false) r.printObject = false;
        // 长休止中途换的和弦落到对应那个 0 上
        const h = later.findIndex((x) => Math.abs((x.offset ?? 0) / divisions - k) < 1e-6);
        if (h >= 0) {
          const [placed] = later.splice(h, 1);
          r.harmony = { ...textOf(placed!) };
          delete r.harmony.offset;
        }
        out.push(r);
      }
      if (later.length) ch.laterHarmonies = later.map(textOf);
      const rest = q - beats;
      if (rest > 1e-9) {
        const r = jianpuShape(rest);
        const tail: Chord = { kind: "chord", id: newId(), notes: [], rest: {}, duration: { divisions: Math.round(rest * Q), dots: r.dots }, voice: ch.voice, staff: ch.staff };
        if (ch.printObject === false) tail.printObject = false;
        if (r.beams) tail.beams = Array.from({ length: r.beams }, () => "continue" as const);
        out.push(tail);
      }
      continue;
    }
    ch.sustains = Array.from({ length: s.sustains }, () => ({ id: newId() }));
    placeLaterHarmonies(ch, ch.sustains, divisions);
    out.push(ch);
  }
  m.elements = out;

  // 小节末的和弦：位置 = 小节末 + offset（负值往回数）。落进哪个音就交给那个音去挂（音符起点 / 增时线），
  // offset 不为负的是给下一小节第一个音的
  const carryOut: Harmony[] = [];
  for (const h of trailing) {
    const at = measureEnd + (h.offset ?? 0) / divisions;
    if (at >= measureEnd - 1e-9) {
      carryOut.push(textOf(h));
      continue;
    }
    let host: Chord | undefined;
    for (const [c, st] of startOf) if (st <= at + 1e-9) host = c;
    if (!host) {
      carryOut.push(textOf(h));
      continue;
    }
    const rel = at - startOf.get(host)!;
    if (Math.abs(rel) < 1e-9 && !host.harmony) {
      host.harmony = { ...textOf(h), offset: 0 };
      delete host.harmony.offset;
      continue;
    }
    const k = Math.round(rel - (host.duration.divisions - (host.sustains?.length ?? 0) * Q) / Q);
    const su = host.sustains?.[k];
    const onBeat = Math.abs(rel - (host.duration.divisions / Q - (host.sustains?.length ?? 0)) - k) < 1e-6;
    if (su && onBeat && !su.harmony) {
      su.harmony = { ...textOf(h) };
      delete su.harmony.offset;
    } else {
      // 长休止拆成的几个 0 里找对应那一拍
      const idx = out.indexOf(host);
      const beat = Math.round(rel);
      const r = out[idx + beat];
      if (host.rest && Math.abs(rel - beat) < 1e-9 && r?.kind === "chord" && r.rest && !r.harmony) {
        r.harmony = { ...textOf(h) };
        delete r.harmony.offset;
      } else {
        (host.laterHarmonies ??= []).push(textOf(h));
      }
    }
  }
  return carryOut;
}

/** 长音中途换的和弦（`offset`）挂到对应拍位的增时线上；落不到整拍上的留在原处（简谱写不出） */
function placeLaterHarmonies(ch: Chord, sustains: NonNullable<Chord["sustains"]>, divisions: number): void {
  const later = [...(ch.laterHarmonies ?? [])];
  // 只有一个和弦、但它本身带 offset（落在长音中间）的也一样处理
  if (ch.harmony?.offset && ch.harmony.offset > 0) {
    later.unshift(ch.harmony);
    delete ch.harmony;
  }
  const bodyQuarters = (ch.duration.divisions - sustains.length * Q) / Q;
  const left: Harmony[] = [];
  for (const h of later) {
    const at = (h.offset ?? 0) / divisions;
    const k = Math.round(at - bodyQuarters);
    const su = sustains[k];
    if (Math.abs(at - bodyQuarters - k) < 1e-6 && su && !su.harmony) {
      const placed = textOf(h);
      delete placed.offset;
      su.harmony = placed;
    } else if (!ch.harmony && (h.offset ?? 0) <= 0) {
      ch.harmony = textOf(h);
    } else {
      left.push(textOf(h));
    }
  }
  // 挂不到增时线上、音符本身又没有和弦的：退一步挂在音符上（位置提前了，但和弦还在谱上）
  if (!ch.harmony && left.length) {
    ch.harmony = left.shift()!;
    delete ch.harmony.offset;
  }
  if (left.length) ch.laterHarmonies = left;
  else delete ch.laterHarmonies;
}
