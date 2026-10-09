// 识别结果 → MusicXML。对应 musicpp `qtomr/toxml.cpp::Score::exportXml`。
//
// 字符串拼装一律复用 `src/score/xmlutil.ts`（escape / 外壳 / `<barline>` 子元素顺序），
// **别在这里另写一套** ——那份是简谱导出、文本谱导出与本文件的公共件。
import { barlineXml, escapeXml, scorePartXml, workXml, wrapPartwise } from "../score/xmlutil";
import { harmonyXml } from "../score/harmonyxml";
import type { StaffNote } from "./notedata";
import { clefFor, fifthsAt, timeSignatures, type StaffContext } from "./notedata";
import { Bar, type Staff } from "./model";
import type { StaffScore } from "./score";

/** 一行谱在一页上的识别结果，拼成一首曲子要按「系统顺序」把这些串起来。 */
export interface StaffLineResult {
  staff: Staff;
  ctx: StaffContext | undefined;
  notes: StaffNote[];
}

export interface StaffXmlOptions {
  title?: string;
  /** 每四分音符多少 tick。取 24 能整除 2/3/4/6/8 分音符与三连音。 */
  divisions?: number;
  partId?: string;
  /** 给 `<note>` 写 `id`（编辑器的识别对照按它把模型里的音对回源图坐标）；返回 undefined 不写 */
  noteId?: (n: StaffNote) => string | undefined;
  /** 页眉各条（位图路 OCR 读出的标题、词曲作者），写成曲首页的 `<credit>` */
  credits?: { text: string; type?: string; justify?: string }[];
}

/** 本次写出的 `noteId`（`scoreToMusicXml` 进出时设、清；写出是同步的） */
let currentNoteId: StaffXmlOptions["noteId"] | null = null;

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

/**
 * 一首曲子（按系统顺序排好的若干行谱）→ MusicXML。
 *
 * 小节由**已认的小节线**切开（`Staff.bars`）。谱面上的一行谱可能只有半个小节
 * （跨行的小节），这里不做跨行合并——那是 `Score::connectSystems` 那一层的事，
 * 尚未移植，故行末与行首各算一个小节，`<measure number>` 顺序编号。
 */
export function toMusicXml(lines: StaffLineResult[], opts: StaffXmlOptions = {}): string {
  const divisions = opts.divisions ?? 24;
  const partId = opts.partId ?? "P1";
  const ticks = (dur: number) => Math.max(1, Math.round(dur * 4 * divisions));

  let body = "";
  let measureNo = 0;
  let prevFifths: number | null = null;
  let prevTime: string | null = null;
  let prevClef: string | null = null;

  for (const line of lines) {
    const { staff, ctx, notes } = line;
    // 拍号**逐小节**生效：一行谱上可能变拍好几次（见 notedata.ts::timeSignatures）
    const timeChanges = timeSignatures(ctx?.time ?? [], staff.stepDistance() * 2);
    let tc = 0;
    // 一行谱一个小节都没切出来时（谱线找到了但没认出小节线），整行当一个小节
    const bars: Bar[] = staff.bars.length ? staff.bars : [Object.assign(new Bar(staff), { left: staff.box.left, right: staff.box.right })];
    for (let bi = 0; bi < bars.length; bi++) {
      const bar = bars[bi];
      const inBar = notes.filter((n) => n.x >= bar.left && n.x < bar.right);
      measureNo++;
      let attrs = "";
      if (measureNo === 1) attrs += `<divisions>${divisions}</divisions>`;
      // 行中转调（`keyChanges`）：小节里有新调号的从这一小节起写
      const fifths = ctx ? fifthsAt(ctx, bar.right - 1) : 0;
      if (ctx && fifths !== prevFifths) {
        attrs += `<key><fifths>${fifths}</fifths></key>`;
        prevFifths = fifths;
      }
      while (tc < timeChanges.length && timeChanges[tc].x < bar.right) {
        const t = timeChanges[tc++];
        const key = `${t.beats}/${t.beatType}`;
        if (key !== prevTime) {
          attrs += `<time><beats>${t.beats}</beats><beat-type>${t.beatType}</beat-type></time>`;
          prevTime = key;
        }
      }
      const clef = ctx?.clef ? clefXml(ctx.clef.code) : null;
      if (bi === 0 && clef && clef !== prevClef) {
        attrs += clef;
        prevClef = clef;
      }
      body += `<measure number="${measureNo}">`;
      if (attrs) body += `<attributes>${attrs}</attributes>`;
      // 正向反复（`|:`）挂在小节的**左端**
      body += barlineXml("left", { style: bar.leftStyle, repeat: bar.leftRepeat, ending: bar.endingStart ? bar.endingNumber : null });
      // 一行谱上写两个声部时要分开写，中间用 `<backup>` 把时间倒回小节头
      body += emitVoices(inBar, ticks, 0);
      // 终止线/复纵线/反向反复（`:|`）挂在小节的**右端**
      body += barlineXml("right", {
        style: bar.rightStyle,
        repeat: bar.rightRepeat,
        ending: bar.endingStop ? bar.endingNumber : null,
      });
      body += `</measure>`;
    }
  }

  return wrapPartwise({
    work: workXml(opts.title),
    credits: creditsXml(opts.credits),
    partList: scorePartXml(partId),
    body: `<part id="${partId}">${renumberSlurs(body)}</part>`,
  });
}

/**
 * 一个小节里的音符 → `<note>` 串，按声部分开写。
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
function emitVoices(inBar: StaffNote[], ticks: (d: number) => number, staffNo: number, midClefs: { x: number; xml: string }[] = []): string {
  // **起点不能用 `ticks`**：那个函数有 `Math.max(1, …)` 的下限（时值再短也得占一格），
  // 拿它换算 offset=0 会得到 1，于是每个从小节头起的声部都白白多出一个 1 格的 `<forward>`。
  const at = (dur: number) => Math.round(ticks(1) * dur);
  let body = "";
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
  const voices = [...new Set(inBar.map((n) => n.voice))].sort((a, b) => a - b);
  const withVoice = voices.length > 1 || staffNo > 0;
  const voiceBase = staffNo > 0 ? (staffNo - 1) * 4 : 0;
  // **合成一个 part 的钢琴两行，`<direction>` 也要带 `<staff>`**：不带的话读入端把它算到整个 part（两行都有一份，
  // 或一律落到第一行），松叶两行都用 1 号还会互相套住
  const dirStaff = staffNo ? `<staff>${staffNo}</staff>` : "";
  const wedgeNo = staffNo || 1;
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
    const movedLyrics = new Set<NonNullable<StaffNote["lyrics"]>[number]>();
    // 行中换谱号写在第一个声部里、它右边第一个音之前（`<attributes>` 按时间位置对整个谱表生效）
    const clefsLeft = vi === 0 ? midClefs.slice() : [];
    for (const n0 of vn) {
      while (clefsLeft.length && !n0.chordExtra && n0.x > clefsLeft[0].x) body += `<attributes>${clefsLeft.shift()!.xml}</attributes>`;
      // **`<chord/>` 按写出的次序定**，不按 `chordExtra`：那个标记是按和弦数组的下标给的
      //（下标 0 的不带），上面按音高重排之后，带标记的常常排到了第一个——
      // `<chord/>` 的意思是「与前一个音同时」，于是和弦的顶音被挂到了**前一拍**上
      //（实测《善牧恩慈歌》每个 SATB 和弦的女高都前移一拍）。
      const extra = timed || grouped ? !n0.grace && !!prev && !prev.grace && prev.group === n0.group : !!n0.chordExtra;
      let n = extra === !!n0.chordExtra ? n0 : { ...n0, chordExtra: extra || undefined };
      prev = n0;
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
      // 符杠同理：整枚和弦共一根干，杠记在哪个头上都一样，写在打头的那个音上
      if (!extra && n0.group && !n.beam) {
        const bm = vn.find((m) => m.group === n0.group && m.beam)?.beam;
        if (bm) n = { ...n, beam: bm };
      }
      if (timed && !n.chordExtra && !n.grace) {
        const off = at(n.group!.offset);
        if (off > cur) {
          body += `<forward><duration>${off - cur}</duration></forward>`;
          cur = off;
        }
      }
      // `<harmony>` 与 `<direction>` 都排在它们所属的 `<note>` **之前**（MusicXML 规定）
      if (n.chord) body += harmonyXml(n.chord);
      // 音内换和弦：偏移取整到拍（二分及更长的音按四分、短音按八分），谱面上和弦不会落在拍子中间
      for (const h of n.chordLater ?? []) {
        const grid = n.duration >= 0.5 ? 0.25 : 0.125;
        const off = Math.round((n.duration * h.frac) / grid) * grid;
        if (off > 0 && off < n.duration) body += harmonyXml(h.text, ticks(off));
      }
      // 速度文字与节拍器印在一条上的（`Andante ♩ = c. 76`）合进同一个 `<direction>`：先文字、后节拍器，一个对象
      if (n.metronome || n.tempoText) {
        const m = n.metronome;
        // 文字后面接节拍器时末尾留一个空格（`Andante ♩ = c. 76`），不然排出来文字与音符字形贴在一起
        const words = n.tempoText ? `<direction-type><words>${escapeXml(m ? `${n.tempoText.trimEnd()} ` : n.tempoText)}</words></direction-type>` : "";
        const metro = m ? `<direction-type><metronome><beat-unit>${m.unit}</beat-unit><per-minute>${escapeXml(m.text ?? String(m.bpm))}</per-minute></metronome></direction-type>` : "";
        body += `<direction placement="above">${words}${metro}${dirStaff}${m ? `<sound tempo="${m.bpm}"/>` : ""}</direction>`;
      }
      for (const w of n.words ?? [])
        body += `<direction placement="${w.above ? "above" : "below"}"><direction-type><words>${escapeXml(w.text)}</words></direction-type>${dirStaff}</direction>`;
      if (n.dynamic)
        body += `<direction placement="below"><direction-type><dynamics><${n.dynamic}/></dynamics></direction-type>${dirStaff}</direction>`;
      // 松叶：**止排在起之前**——同一个音符上前一条松叶收尾、下一条起头是常事，
      // 反过来写会让两条重叠（MusicXML 里同号的 wedge 不能套嵌）。
      if (n.wedgeStop) body += `<direction placement="below"><direction-type><wedge number="${wedgeNo}" type="stop"/></direction-type>${dirStaff}</direction>`;
      if (n.wedgeStart)
        body += `<direction placement="below"><direction-type><wedge number="${wedgeNo}" type="${n.wedgeStart}"/></direction-type>${dirStaff}</direction>`;
      body += noteXml(n, ticks(n.duration), staffNo, withVoice, voiceBase);
      if (!n.chordExtra && !n.grace) cur += ticks(n.duration);
    }
    // 按拍位排满的小节里，提前收尾的声部补 `<forward>` 到小节末：合唱谱的女低、男低常常
    // 唱半小节就并回主声部的和弦（共用符干）。不补的话，换行谱前按最长声部写的 `<backup>`
    // 会倒过小节头，下一行谱整体前移。
    if (timed && cur > 0 && cur < full) {
      body += `<forward><duration>${full - cur}</duration></forward>`;
      cur = full;
    }
    for (const c of clefsLeft) body += `<attributes>${c.xml}</attributes>`;
    if (vi < voices.length - 1 && cur > 0) body += `<backup><duration>${cur}</duration></backup>`;
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

/** 正在写的 part 里各行谱的谱表号（`<staff>`）：跨谱表的弧止端按起端那行编号用。 */
const partStaffNo = new Map<Staff, number>();

function noteXml(n: StaffNote, dur: number, staffNo = 0, withVoice = false, voiceBase = 0): string {
  const id = currentNoteId?.(n);
  const xml = noteXmlRaw(n, dur, staffNo, withVoice, voiceBase);
  return id ? xml.replace(/^<note>/, `<note id="${escapeXml(id)}">`) : xml;
}

function noteXmlRaw(n: StaffNote, dur: number, staffNo = 0, withVoice = false, voiceBase = 0): string {
  const type = noteType(n.base);
  const dots = "<dot/>".repeat(n.dots);
  // `<staff>` 排在 `<notations>` 之前、`<stem>` 之后（MusicXML 的子元素顺序）
  const staffEl = staffNo ? `<staff>${staffNo}</staff>` : "";
  // `<voice>` 排在 `<duration>`/`<tie>` 之后、`<type>` 之前
  const voiceEl = withVoice ? `<voice>${n.voice + voiceBase}</voice>` : "";
  if (n.rest)
    return `<note><rest/><duration>${dur}</duration>${voiceEl}<type>${type}</type>${dots}${staffEl}</note>`;
  // **倚音不占拍子**：MusicXML 的 `<grace/>` 排在最前（`<chord/>` 之前），
  // 而且这种音**不许写 `<duration>`**——写了小节就超时长，回读的软件多半直接报错。
  const grace = n.grace ? "<grace/>" : "";
  const durEl = n.grace ? "" : `<duration>${dur}</duration>`;
  // `<chord/>` 紧跟在 `<grace/>` 之后（没有倚音时它就是第一个子元素）
  const chord = n.chordExtra ? "<chord/>" : "";
  // `<alter>` 是**发声**的升降（含调号），`<accidental>` 是谱面上**印出来**的那个记号。
  // 两者不是一回事：G 调里一个没印记号的 F 也要写 `<alter>1</alter>`。
  const alter = n.alter !== 0 ? `<alter>${n.alter}</alter>` : "";
  const acc = n.accidental !== null ? `<accidental>${accidentalName(n.accidental)}</accidental>` : "";
  const stem = n.stemUp === null ? "" : `<stem>${n.stemUp ? "up" : "down"}</stem>`;
  // `<lyric>` 是 `<note>` 的最后一批子元素，排在 `<stem>`/`<accidental>` 之后
  // 一字多音收尾的那个音：只出一个带 `<extend type="stop"/>` 的空 `<lyric>`（延长线画到这里）
  const lyric = (n.lyrics ?? []).map((l) => lyricXml(l)).join("") +
    (n.lyricExtendStop ?? []).map((l) => `<lyric number="${l.verse}"><extend type="stop"/></lyric>`).join("");
  // `<notations>` 排在 `<lyric>` 之前（MusicXML 的子元素顺序）
  const nots: string[] = [];
  if (n.tieStop) nots.push(`<tied type="stop"/>`);
  // 弧的方向：圆滑线写 `placement`、连音线写 `orientation`（两种软件导出的常规写法，读入端两个都认）
  const tieOri = n.tieAbove === undefined ? "" : ` orientation="${n.tieAbove ? "over" : "under"}"`;
  if (n.tieStart) nots.push(`<tied type="start"${n.tieDashed ? ` line-type="dashed"` : ""}${tieOri}/>`);
  // 编号按谱表号：钢琴两行合一个 part 时同号的弧按编号配对，右手一条长弧还开着、左手又起又止一条，读入端就配串了（宁静 m32–36）；
  // 止端按起端那行编（跨谱表的弧）
  const slurNo = staffNo || 1;
  const stopNo = (n.slurStopFrom && partStaffNo.get(n.slurStopFrom)) || slurNo;
  // 带弧号的（`markSlurNotes` 给的）先写成临时的 `arc` 属性，整个声部写完后由 `renumberSlurs` 配对、重编号
  // 落单半截再带上 `edge`、`ab`（几何位置与朝向，见 `slurOrphans`）
  const arcs = (ids: number[] | undefined) => (ids?.length ? ids : [0]);
  const arcAttr = (id: number) => {
    if (!id) return "";
    const o = n.slurOrphans?.find((x) => x.id === id);
    return ` arc="${id}"` + (o ? ` edge="${o.edge}" ab="${o.above ? 1 : 0}"` : "");
  };
  if (n.slurStop) for (const id of arcs(n.slurStopIds)) nots.push(`<slur type="stop" number="${stopNo}"${arcAttr(id)}/>`);
  const slurPl = n.slurAbove === undefined ? "" : ` placement="${n.slurAbove ? "above" : "below"}"`;
  if (n.slurStart)
    for (const id of arcs(n.slurStartIds)) nots.push(`<slur type="start" number="${slurNo}"${arcAttr(id)}${n.slurDashed ? ` line-type="dashed"` : ""}${slurPl}/>`);
  if (n.tuplet) nots.push(`<tuplet type="start"/>`);
  // `<notations>` 里子元素有固定次序：tied / slur / tuplet / ornaments / articulations / fermata / arpeggiate
  const arts: string[] = [];
  const orns: string[] = [];
  let fermata = "";
  let arpeggiate = false;
  for (const m of n.marks ?? []) {
    const a = ARTICULATION[m];
    if (a) {
      arts.push(a);
      continue;
    }
    if (m === "arpeggiato") arpeggiate = true;
    else if (m.startsWith("fermata")) fermata = `<fermata type="${m === "fermataBelow" ? "inverted" : "upright"}"/>`;
    else if (m.startsWith("ornamentTrill") || m.startsWith("wiggleTrill")) orns.push(`<trill-mark/>`);
  }
  if (orns.length) nots.push(`<ornaments>${orns.join("")}</ornaments>`);
  if (arts.length) nots.push(`<articulations>${arts.join("")}</articulations>`);
  if (fermata) nots.push(fermata);
  if (arpeggiate) nots.push(`<arpeggiate/>`);
  const notations = nots.length ? `<notations>${nots.join("")}</notations>` : "";
  const timeMod = n.tuplet
    ? `<time-modification><actual-notes>${n.tuplet.actual}</actual-notes><normal-notes>${n.tuplet.normal}</normal-notes></time-modification>`
    : "";
  // `<tie>` 是发声用的（与 `<tied>` 的图形标记分开写，MusicXML 两者都要）
  const tie = (n.tieStop ? `<tie type="stop"/>` : "") + (n.tieStart ? `<tie type="start"/>` : "");
  // 斜杠符头（前奏/间奏的「照这个节奏弹和弦」）：音高留着（它就画在第三线上），
  // 但要把符头形状写出来，不然回读时会变成一串真的 B4。`<notehead>` 排在 `<stem>` 之后、
  // `<staff>` 之前——MusicXML 的子元素次序是有规定的。
  const head = n.slash ? `<notehead>slash</notehead>` : "";
  // `<beam>` 排在 `<staff>` 之后、`<notations>` 之前；和弦只写在打头那个音上（`emitVoices` 已把整枚和弦的杠挪到它身上）
  const beam = n.chordExtra ? "" : (n.beam ?? []).map((b, i) => `<beam number="${i + 1}">${b}</beam>`).join("");
  return (
    `<note>${grace}${chord}<pitch><step>${escapeXml(n.step)}</step>${alter}<octave>${n.octave}</octave></pitch>` +
    `${durEl}${tie}${voiceEl}<type>${type}</type>${dots}${acc}${timeMod}${stem}${head}${staffEl}${beam}${notations}${lyric}</note>`
  );
}

/** SMuFL 演奏法名 → MusicXML 的 `<articulations>` 子元素。 */
const ARTICULATION: Record<string, string> = {
  articAccentAbove: "<accent/>",
  articAccentBelow: "<accent/>",
  articStaccatoAbove: "<staccato/>",
  articStaccatoBelow: "<staccato/>",
  articTenutoAbove: "<tenuto/>",
  articTenutoBelow: "<tenuto/>",
  articStaccatissimoAbove: "<staccatissimo/>",
  articStaccatissimoBelow: "<staccatissimo/>",
  articMarcatoAbove: "<strong-accent/>",
  articMarcatoBelow: "<strong-accent/>",
  articAccentStaccatoAbove: "<accent/><staccato/>",
  articAccentStaccatoBelow: "<accent/><staccato/>",
  articTenutoStaccatoAbove: "<tenuto/><staccato/>",
  articTenutoStaccatoBelow: "<tenuto/><staccato/>",
  breathMarkComma: "<breath-mark/>",
  caesura: "<caesura/>",
};

/**
 * 单个 `<lyric>`。五线谱的拉丁歌词要分**词内的四种位置**
 * （简谱逐字挂词没有词内断音节这回事，一律 `single`）：
 * `hyphen` = 这个音节后面还有连字符，`cont` = 前面来的也是同一个词。
 * `a-bid-eth` 三段正好走遍 begin / middle / end。
 */
/**
 * 一个声部的 `<slur>` 按弧号配对、重编 `number`（临时的 `arc` / `edge` / `ab` 属性随之删掉）。
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
export function renumberSlurs(body: string, sysOfBar?: number[]): string {
  const re = /<slur type="(start|stop)" number="(\d+)" arc="(\d+)"(?: edge="(\w+)" ab="(\d)")?([^>]*)\/>/g;
  // 第几小节（按 `<measure` 计数）
  const bars = [...body.matchAll(/<measure[ >]/g)].map((m) => m.index!);
  const barAt = (at: number) => {
    let k = 0;
    while (k < bars.length && bars[k] < at) k++;
    return k;
  };
  const toks = [...body.matchAll(re)].map((m) => ({
    type: m[1], staff: m[2], arc: Number(m[3]), edge: m[4], above: m[5] === "1", rest: m[6], at: m.index!, len: m[0].length, bar: barAt(m.index!),
  }));
  if (!toks.length) return body;
  // 某小节所在系统之后，这个声部下一个出现的系统
  const nextSys = (bar: number): number | undefined => {
    const s0 = sysOfBar![bar - 1];
    return sysOfBar!.find((x) => x > s0);
  };
  const starts = new Set(toks.filter((t) => t.type === "start").map((t) => t.arc));
  const stops = new Set(toks.filter((t) => t.type === "stop").map((t) => t.arc));
  const alias = new Map<number, number>(); // 后半截的弧号 → 接上的前半截弧号
  const orphan = new Set<number>();
  const pending = new Map<string, { arc: number; bar: number; above: boolean }[]>(); // 谱表号 → 还没接上的 `end` 半截
  for (const t of toks) {
    if (t.type === "start" && !stops.has(t.arc)) {
      orphan.add(t.arc);
      if (t.edge !== "end") continue;
      const q = pending.get(t.staff) ?? [];
      q.push({ arc: t.arc, bar: t.bar, above: t.above });
      pending.set(t.staff, q);
    } else if (t.type === "stop" && !starts.has(t.arc)) {
      orphan.add(t.arc);
      if (t.edge !== "begin") continue;
      const q = (pending.get(t.staff) ?? []).filter((p) => (sysOfBar ? sysOfBar[t.bar - 1] === nextSys(p.bar) : t.bar - p.bar <= 1));
      const hit = q.find((p) => p.above === t.above) ?? q[0];
      pending.set(t.staff, q.filter((p) => p !== hit));
      if (hit) {
        alias.set(t.arc, hit.arc);
        orphan.delete(t.arc);
        orphan.delete(hit.arc);
      }
    }
  }
  const num = new Map<number, number>();
  const used = new Set<number>();
  let out = "";
  let last = 0;
  for (const t of toks) {
    const key = alias.get(t.arc) ?? t.arc;
    out += body.slice(last, t.at);
    last = t.at + t.len;
    if (orphan.has(key)) continue;
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
    out += `<slur type="${t.type}" number="${n}"${t.rest}/>`;
  }
  out += body.slice(last);
  return out.replace(/<notations><\/notations>/g, "");
}

function lyricXml(l: { verse: number; text: string; hyphen: boolean; cont: boolean; extend?: boolean }): string {
  const syllabic = l.cont ? (l.hyphen ? "middle" : "end") : l.hyphen ? "begin" : "single";
  return `<lyric number="${l.verse}"><syllabic>${syllabic}</syllabic><text>${escapeXml(l.text)}</text>${l.extend ? '<extend type="start"/>' : ""}</lyric>`;
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

/** SMuFL 谱号名 → `<clef>`。 */
export function clefXml(code: string): string {
  switch (code) {
    case "fClef":
      return `<clef><sign>F</sign><line>4</line></clef>`;
    case "fClef8vb":
      return `<clef><sign>F</sign><line>4</line><clef-octave-change>-1</clef-octave-change></clef>`;
    case "cClef":
      return `<clef><sign>C</sign><line>3</line></clef>`;
    case "gClef8vb":
      return `<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>`;
    case "gClef8va":
      return `<clef><sign>G</sign><line>2</line><clef-octave-change>1</clef-octave-change></clef>`;
    case "unpitchedPercussionClef1":
    case "unpitchedPercussionClef2":
      return `<clef><sign>percussion</sign></clef>`;
    default:
      return `<clef><sign>G</sign><line>2</line></clef>`;
  }
}


// ── 按声部导出 ──────────────────────────────────────────────────────────────

/**
 * 整首曲子（跨页、可含多谱表声部）→ MusicXML。
 *
 * 与 `toMusicXml` 的分工：那份把「一串谱行」当单声部串起来（领唱谱够用）；
 * 这份走 `score.ts` 认出来的 `Part`/`ScoreStaff` 结构，
 * **钢琴谱的两行会合成一个 `<part>`**（`<staves>2` + 每个音符带 `<staff>`），
 * 而不是丢掉伴奏那行。
 */
export function scoreToMusicXml(
  score: StaffScore,
  notesOf: (staff: Staff) => StaffNote[],
  opts: StaffXmlOptions = {},
): string {
  currentNoteId = opts.noteId ?? null;
  try {
    return scoreToMusicXmlRaw(score, notesOf, opts);
  } finally {
    currentNoteId = null;
  }
}

function scoreToMusicXmlRaw(
  score: StaffScore,
  notesOf: (staff: Staff) => StaffNote[],
  opts: StaffXmlOptions,
): string {
  const divisions = opts.divisions ?? 24;
  const ticks = (dur: number) => Math.max(1, Math.round(dur * 4 * divisions));

  const partList: string[] = [];
  const bodies: string[] = [];
  score.parts.forEach((part, pi) => {
    const id = `P${pi + 1}`;
    // 方括号分组：组首声部之前起、组尾声部之后收（`<part-group>` 夹在 `<score-part>` 之间，number 按组编）
    score.groups?.forEach((g, gi) => {
      if (g.first === pi)
        partList.push(`<part-group type="start" number="${gi + 1}"><group-symbol>${g.symbol}</group-symbol><group-barline>${g.barline ? "yes" : "no"}</group-barline></part-group>`);
    });
    partList.push(scorePartXml(id, part.name, part.abbr));
    score.groups?.forEach((g, gi) => {
      if (g.last === pi) partList.push(`<part-group type="stop" number="${gi + 1}"/>`);
    });
    let body = "";
    let measureNo = 0;
    /** 每一小节属于第几个系统（`renumberSlurs` 接跨行弧用） */
    const sysOfBar: number[] = [];
    let prevFifths: number | null = null;
    let prevTime: string | null = null;
    let prevClef: string[] = [];

    score.systems.forEach((entry, si) => {
      // 这个声部在这一系统里的各行谱（隐藏的为 null）
      const staves = part.scoreStaves.map((ss) => ss.staves[si]);
      const lead = staves.find((x) => x) ?? null;
      if (!lead) return;
      const barCount = Math.max(...staves.map((st) => st?.bars.length ?? 0));
      const ctx = entry.ctx.get(lead);
      const timeChanges = timeSignatures(ctx?.time ?? [], lead.stepDistance() * 2);
      let tc = 0;

      for (let bi = 0; bi < barCount; bi++) {
        measureNo++;
        sysOfBar.push(si);
        let attrs = "";
        if (measureNo === 1) attrs += `<divisions>${divisions}</divisions>`;
        const bar0 = lead.bars[bi];
        // 行中转调（`keyChanges`）：小节里有新调号的从这一小节起写
        const fifths = ctx ? fifthsAt(ctx, bar0 ? bar0.right - 1 : -Infinity) : 0;
        if (ctx && fifths !== prevFifths) {
          attrs += `<key><fifths>${fifths}</fifths></key>`;
          prevFifths = fifths;
        }
        while (bar0 && tc < timeChanges.length && timeChanges[tc].x < bar0.right) {
          const t = timeChanges[tc++];
          const k = `${t.beats}/${t.beatType}`;
          if (k !== prevTime) {
            attrs += `<time><beats>${t.beats}</beats><beat-type>${t.beatType}</beat-type></time>`;
            prevTime = k;
          }
        }
        if (bi === 0) {
          // 多谱表声部：`<staves>` 与逐谱表的 `<clef number=n>`。
          // 行首的谱号与读音高时用的同一个（`clefFor`）：这一行没认出谱号的沿用上一系统的，不是一律高音谱号
          const clefs = staves.map((st) => (st ? clefXml(rowStartClef(entry, st)) : ""));
          if (clefs.join("|") !== prevClef.join("|")) {
            if (staves.length > 1) attrs += `<staves>${staves.length}</staves>`;
            clefs.forEach((c, k) => {
              if (!c) return;
              attrs += staves.length > 1 ? c.replace("<clef>", `<clef number="${k + 1}">`) : c;
            });
            prevClef = clefs;
          }
        }
        body += `<measure number="${measureNo}">`;
        if (attrs) body += `<attributes>${attrs}</attributes>`;
        if (bar0)
        body += barlineXml("left", {
          style: bar0.leftStyle,
          repeat: bar0.leftRepeat,
          ending: bar0.endingStart ? bar0.endingNumber : null,
        });

        partStaffNo.clear();
        if (staves.length > 1) staves.forEach((st, k) => st && partStaffNo.set(st, k + 1));
        staves.forEach((st, k) => {
          if (!st) return;
          const bar = st.bars[bi];
          if (!bar) return;
          const inBar = notesOf(st).filter((n) => n.x >= bar.left && n.x < bar.right);
          // 行中换谱号（读音高时已经按它读了，`clefFor`）：写进这一小节，下一行行首要不要再写照它比
          const mids = midRowClefs(entry, st).filter((c) => c.box.left >= bar.left && c.box.left < bar.right);
          const midXml = mids.map((c) => {
            const x = clefXml(c.code);
            return { x: c.box.left, xml: staves.length > 1 ? x.replace("<clef>", `<clef number="${k + 1}">`) : x };
          });
          if (mids.length) prevClef[k] = clefXml(mids[mids.length - 1].code);
          body += emitVoices(inBar, ticks, staves.length > 1 ? k + 1 : 0, midXml);
          const used = voiceTicks(inBar, ticks);
          // 换到下一行谱之前要把时间**倒回**小节头（MusicXML 的 `<backup>`）
          if (k < staves.length - 1 && used > 0) body += `<backup><duration>${used}</duration></backup>`;
        });

        if (bar0)
          body += barlineXml("right", {
            style: bar0.rightStyle,
            repeat: bar0.rightRepeat,
            ending: bar0.endingStop ? bar0.endingNumber : null,
          });
        body += `</measure>`;
      }
    });
    bodies.push(`<part id="${id}">${renumberSlurs(body, sysOfBar)}</part>`);
  });

  return wrapPartwise({
    work: workXml(opts.title),
    credits: creditsXml(opts.credits),
    partList: partList.join(""),
    body: bodies.join("\n"),
  });
}

/** 页眉 → `<credit page="1">`，一条一个。 */
function creditsXml(credits: StaffXmlOptions["credits"]): string {
  return (credits ?? [])
    .map((c) => `<credit page="1">${c.type ? `<credit-type>${escapeXml(c.type)}</credit-type>` : ""}<credit-words${c.justify ? ` justify="${c.justify}"` : ""}>${escapeXml(c.text)}</credit-words></credit>`)
    .join("");
}
