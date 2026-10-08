// 文本层：歌词 / 和弦 / 速度 / 表情 / 乐器名 / 文本框 / 方框字 / 小节号。
// 移植自 musicpp `qtomr/TextAnalyze.cpp`（+ `qomr.cpp::findHarmonies` 的调用顺序）。
//
// musicpp 到**打标为止**就结束了——它的 `toxml.cpp` 并不导出歌词与和弦。
// 「把歌词逐字挂到音符上」那一段是本仓新加的（`buildLyricLines` / `attachLyrics`），
// 口径照简谱那条路（`src/omr/lyrics.ts`）：**逐字挂音符**，一行歌词 = 一个 verse。
import type { VecGlyph } from "../omrkit/vectext";
import type { TextGlyphLookup } from "./textglyphs";
import type { StaffNote } from "./notedata";
import { isWholeChord } from "../omrkit/chordgrammar";
import { type Box, PObj, SPage, Staff, between, overlapX, overlapY, xSpace, ySpace } from "./model";

/** 一段文本的纯文字内容（ToUnicode 的结果，可能是乱码，见文档「坏 ToUnicode」一节）。
 *  名字带 `objText` 前缀是为了不与 `pdflayout/bookmeta.ts::runText` 撞——那份收的是
 *  500 首那条转曲路的 `TextRun`，两边的入参类型完全不同。 */
export function objText(o: PObj): string {
  return o.run ? o.run.glyphs.map((g) => g.unicode).join("") : "";
}

/** 文字对象里切出来的一段：原文、墨迹盒、逐字右缘（升降号插在哪个字母后面靠它）。 */
interface TextPiece {
  text: string;
  box: Box;
  chars: { c: string; right: number }[];
}

/**
 * 一个文字对象按**字形间隙**切段（间隙超过 `gap`）。和弦带里同一次 TJ 常印着好几个和弦，
 * 中间只隔一大段空白（牵我的手 `A    E/G♯`、`A    B`）：当一个对象判，拼成 `AE/G` 解不出、`AB` 不合文法被收成歌词。
 * 位图路合成的对象（`#` 字体）一个就是一个记号，不切。
 */
function glyphPieces(o: PObj, gap: number): TextPiece[] {
  const run = o.run;
  if (!run || run.font.startsWith("#")) {
    const t = objText(o);
    // 拿不到逐字位置：第一个字右缘记成盒左缘、其余记成无穷远，升降号就照旧插在第一个字母后面
    return [{ text: t, box: { ...o.box }, chars: [...t].map((c, i) => ({ c, right: i ? Infinity : o.box.left })) }];
  }
  const out: TextPiece[] = [];
  let cur: TextPiece | null = null;
  for (const g of run.glyphs) {
    if (!g.unicode.trim()) continue;
    const left = g.bbox.x;
    const right = g.bbox.x + g.bbox.w;
    const top = Math.min(g.bbox.y, g.bbox.y + g.bbox.h);
    const bottom = Math.max(g.bbox.y, g.bbox.y + g.bbox.h);
    if (!cur || left - cur.box.right > gap) {
      cur = { text: "", box: { left, right, top, bottom }, chars: [] };
      out.push(cur);
    }
    cur.text += g.unicode;
    cur.chars.push({ c: g.unicode, right });
    cur.box = { left: Math.min(cur.box.left, left), right: Math.max(cur.box.right, right), top: Math.min(cur.box.top, top), bottom: Math.max(cur.box.bottom, bottom) };
  }
  return out;
}

/**
 * `TextAnalyze` 的构造：收「不在谱表五线之内」的文字对象与非虚线的水平段。
 * 落在谱线之间的文字是谱内元素（力度、指法），不进这一摊。
 */
function collectTexts(pg: SPage): { texts: PObj[]; hlines: Box[] } {
  const texts: PObj[] = [];
  for (const o of pg.objs) {
    if (!o.run) continue;
    if (o.symbols.length) continue; // 音乐字体的对象归 findSymbols
    let inStaff = false;
    const cy = (o.box.top + o.box.bottom) / 2;
    for (const st of pg.staves) {
      // 横向也要落在谱表里：谱表**左边**同高的是声部名（「Soprano」「T. & B.」），不是谱内元素
      // （宣主荣耀那种声部名正对着谱行印的，原来整列被挡在外面，只认出印在两行之间的「Piano」）
      if (o.box.right <= st.box.left || o.box.left >= st.box.right) continue;
      if (Math.abs(st.middleStep(cy)) <= 4) {
        inStaff = true;
        break;
      }
    }
    if (inStaff) continue;
    texts.push(o);
  }
  const hlines = pg.segs.filter((s) => s.isH && !s.hasAnyTag()).map((s) => s.box);
  return { texts, hlines };
}

const isStepChar = (c: string): boolean => c >= "A" && c <= "G";

/** 一个汉字（可带句读）成一段：中文歌词逐字一个文本对象的样子。 */
const LYRIC_CJK_SINGLE = /^[㐀-鿿豈-﫿][!,.?;:！，。？；：、]?$/;


export interface TextAnalysis {
  lyric: PObj[];
  harmony: PObj[];
  tempo: PObj[];
  expression: PObj[];
  instrument: PObj[];
  measureNumber: PObj[];
  boxed: PObj[];
  textFrame: PObj[];
}

/** `Page::findHarmonies` 的调用顺序，**别调**：先歌词、再和弦、再和弦后缀…… */
export function analyzeText(pg: SPage): TextAnalysis {
  const { texts, hlines } = collectTexts(pg);
  const kind = new Map<PObj, keyof TextAnalysis>();
  const sp = pg.normalStaffSpace || pg.space;

  // ── 和弦记号（**先于**歌词判） ────────────────────────────────────────────
  //
  // 这一步是本仓加的，musicpp 没有。原因：musicpp 的 `markHarmony` 只认三种形状
  // （含 `/`、单个大写音名、`X Y`），本书的 `D m7` / `B♭Maj7` / `A dim/E♭` 一个都不沾边；
  // 而歌词那一步的判据（纵向跨过某条水平线的 y）会把和弦一并收成歌词
  // ——实测 p100 的 `G` 被挂成了第二段歌词。所以先把**明确是和弦记号**的挑出来。
  // 记号语法用三路共用的 `omrkit/chordgrammar.ts::CHORD_TOKEN_RE`（根音必须大写，理由见那边的注释）。
  // ── 页脚文字块（本仓加的） ──────────────────────────────────────────────
  // 版权声明（牵我的手每页四行：`Copyright © 2013 …`、两行中文、网址）印在最后一行谱下面，
  // 这首最后一行是钢琴，下面那条「正上方一个符头都没有」的页脚判据用不上；中文那两行又是一字一个对象，
  // 被「一字一段排成一排」收成歌词锚，`(www…/copyright)` 带 `/` 还会被当和弦。先挑出来归文本框。
  // 判据：最后一行谱以下、**整行连排**（相邻两段间隙不到一个字号）、**行中心在页面中线上**（两格内）。
  // 歌词对着音符散开排，整行连在一起的只有成段文字；居中这一条再挡住偶然连排的短歌词行
  const lastStaff = pg.staves.reduce<Staff | null>((m, st) => (!m || st.box.bottom > m.box.bottom ? st : m), null);
  if (lastStaff) {
    const rows: PObj[][] = [];
    for (const t of texts.filter((t) => t.run && t.box.top > lastStaff.box.bottom && objText(t).trim()).sort((a, b) => a.box.top - b.box.top)) {
      const row = rows.find((r) => r.some((u) => overlapY(u.box, t.box) && Math.min(u.box.bottom, t.box.bottom) - Math.max(u.box.top, t.box.top) > (t.box.bottom - t.box.top) * 0.5));
      if (row) row.push(t);
      else rows.push([t]);
    }
    for (const row of rows) {
      row.sort((a, b) => a.box.left - b.box.left);
      const em = Math.max(...row.map((t) => t.run!.sizeDev));
      if (row.some((t, i) => i > 0 && t.box.left - row[i - 1].box.right > em)) continue;
      const cx = (row[0].box.left + Math.max(...row.map((t) => t.box.right))) / 2;
      if (Math.abs(cx - pg.width / 2) > sp * 2) continue;
      for (const t of row) kind.set(t, "textFrame");
    }
  }

  // 贴身描边框圈住的字是排练号（`[A]` `[B]`），单个大写字母合和弦文法，不挡掉就被收成和弦
  // （牵我的手 Violin 上三个）。只认框比字大不出两格的：大框（整段文字框、版面边框）里的和弦照收；
  // 框里的字留给后面 findBoxedText 打标。这本的框是**填充**画的（外矩形套内矩形的一圈），不限描边
  const frames = pg.objs.filter((o) => !o.hasAnyTag() && o.path && !o.path.curves);
  const framed = (t: PObj) =>
    frames.some(
      (f) =>
        f.box.left <= t.box.left && f.box.right >= t.box.right && f.box.top <= t.box.top && f.box.bottom >= t.box.bottom &&
        f.box.right - f.box.left < t.box.right - t.box.left + 4 * sp && f.box.bottom - f.box.top < t.box.bottom - t.box.top + 4 * sp,
    );
  for (const t of texts) {
    if (kind.has(t) || framed(t)) continue;
    const raw = objText(t).replace(/\s+/g, "");
    if (!raw) continue;
    if (isWholeChord(raw)) kind.set(t, "harmony");
    else {
      // 一个对象里隔着大段空白印了几个和弦（`A    B`）：逐段都合文法才算
      const ps = glyphPieces(t, 2 * sp);
      if (ps.length > 1 && ps.every((p) => isWholeChord(p.text.replace(/\s+/g, "")))) kind.set(t, "harmony");
    }
  }

  // ── markHarmonySuffix（**提前到歌词之前**） ────────────────────────────────
  //
  // musicpp 把它排在 markLyric 之后。本书不行：`Maj7` / `m7` / `sus4` 这些后缀是独立的
  // 文本对象，歌词那一步会先把它们收成第二段歌词（实测 p100 的第二段唱出了「26 7 m7」），
  // 于是和弦只剩一个光根音。挪到歌词之前，两边都对。
  // `m7` / `sus4` / `maj7` 是紧跟在和弦根音**右边、同一行**的另一个文本对象。
  for (const t of texts) {
    if (kind.has(t)) continue;
    for (const [h, k] of kind) {
      if (k !== "harmony") continue;
      if (!overlapY(t.box, h.box)) continue;
      const dist = t.box.left - h.box.right;
      const hh = h.box.bottom - h.box.top;
      // musicpp 的上限是根音盒高的一半（≈0.7 格）。本书的和弦印成 `A dim/E♭`——
      // 根音与后缀之间**有一个空格**，实测间隙 10pt ≈ 2 格，那条门槛全卡掉。
      // 放到两格：同一行里相邻的两个和弦间隔十格开外，不会误并。
      if (dist < -hh / 4 || dist > Math.max(hh / 2, 2 * sp)) continue;
      kind.set(t, "harmony");
      break;
    }
  }

  // ── markLyric（含 markHyphen） ─────────────────────────────────────────────
  // 判据照原文：先找**带连字符且不含数字**的文本，记下它们的中心 y；
  // 再把水平线（歌词的延长线）的上沿也记进去；凡纵向跨过这些 y 的文本都是歌词。
  // 「不含数字」那条是要害——`D m7/C` 这类和弦也带 `-` 之外的记号，数字一票否决。
  const cys: number[] = [];
  for (const t of texts) {
    const s = objText(t);
    if (!s.includes("-")) continue;
    if (/[0-9]/.test(s)) continue;
    cys.push((t.box.top + t.box.bottom) / 2);
    kind.set(t, "lyric");
  }
  for (const l of hlines) cys.push(l.top);
  // 下面两路（延长线锚、自校准）都只看纵向，横向不管：**谱表左边**的声部名（第二个系统起的「A.」「T. & B.」）
  // 与**表情术语**（印在歌词带里的 `rit.`）会被收成歌词（宣主荣耀 p2 女高唱出了「來A.敬拜」）。先挡掉
  const firstX = Math.min(...pg.staves.map((st) => st.box.left));
  // 声部名：在**同一高度那几行谱**的左边线以左（首系统缩进，「Piano」「Synthesizer」在全页最左那条线右边，
  // 只比 `firstX` 挡不住，牵我的手首页的乐器全名被收成了 Synth / Piano 的歌词）。同高 = 纵向离谱表不到一个谱表高
  const rowLeft = (t: PObj) => {
    const near = pg.staves.filter((st) => {
      const h = st.box.bottom - st.box.top;
      return t.box.bottom > st.box.top - h && t.box.top < st.box.bottom + h;
    });
    return near.length ? Math.min(...near.map((st) => st.box.left)) : firstX;
  };
  const notLyric = (t: PObj) => {
    const s = objText(t).trim();
    // 页脚（宣主荣耀 p2「宣主榮耀 2」）：最后一行谱以下、整句一段的汉字，**正上方那行谱在它的横向范围里一个符头都没有**。
    // 光凭「最后一行谱以下、两字以上」会挡掉赞美之泉印在末行谱下的成段歌词（「耀、尊」「高臺，」，歌词档 −0.06）
    // ——歌词总对着音符印，页脚不是
    const footer =
      !!lastStaff && t.box.top > lastStaff.box.bottom && (s.match(/[\u3400-\u9fff]/g)?.length ?? 0) >= 2 &&
      !pg.symbols.some((h) => h.code.startsWith("notehead") && overlapY(h.box, lastStaff.box) && h.box.right > t.box.left && h.box.left < t.box.right);
    // 纯数字（小节号）不在这里挡：后面拼音节时会剔掉；在这里挡了它们会转去别的类，赞美之泉切曲目跟着变（少配上一首）
    return t.box.right <= firstX || t.box.right <= rowLeft(t) || footer;
  };

  for (const t of texts) {
    if (kind.has(t) || notLyric(t)) continue;
    // 纵向跨过锚线（`between(值, 端, 端)`：y 落在字顶与字底之间）。这里曾把参数写反成「字顶在 y 以下」，
    // 等于任何一条水平线下方的文字都算歌词，赞美之泉的中文歌词大半靠它收进来；改正后由下面「对着符头的一排」
    // 「同一排里换了字体的字」与补锚的符头那一路接住（见 docs/实现/五线谱矢量识别.md「中文歌词的锚」）
    if (cys.some((y) => between(y, t.box.top, t.box.bottom))) kind.set(t, "lyric");
  }

  // ── 中文歌词行的起锚（本仓新加） ──────────────────────────────────────────
  //
  // 下面那道补锚要先有**一个**认定的歌词才能自校准；一页里中文歌词既不连字、也没有延长线时（宣主荣耀 p1
  // 三行人声全是一字一段），一个锚都没有，整页歌词全丢。中文歌词的样子本身就是锚：**一个汉字（可带句读）一段**，
  // 同字体同字号、同一条基线上排成一排（三段以上），排在某行谱下方。标题、页眉、署名都是整句一段，碰不上这条。
  {
    const single = texts.filter((t) => !kind.has(t) && t.run && LYRIC_CJK_SINGLE.test(objText(t).trim()));
    const underStaff = (t: PObj) => pg.staves.some((st) => st.box.bottom <= t.box.top && t.box.left < st.box.right && t.box.right > st.box.left);
    for (const t of single) {
      if (kind.has(t) || !underStaff(t)) continue;
      const h = t.box.bottom - t.box.top;
      const cy = (t.box.top + t.box.bottom) / 2;
      const row = single.filter(
        (u) => u.run!.font === t.run!.font && Math.abs(u.run!.sizeDev - t.run!.sizeDev) <= t.run!.sizeDev * 0.05 && Math.abs((u.box.top + u.box.bottom) / 2 - cy) <= h * 0.5,
      );
      if (row.length < 3) continue;
      for (const u of row) kind.set(u, "lyric");
    }
  }

  const heads = pg.symbols.filter((h) => h.code.startsWith("notehead"));
  /** 这段文字正上方（横向放半格）有 `st` 这行谱的符头：歌词逐字对着音符印。 */
  const underHead = (t: PObj, st: Staff) =>
    heads.some((h) => {
      const hx = (h.box.left + h.box.right) / 2, hy = (h.box.top + h.box.bottom) / 2;
      return hx >= t.box.left - sp / 2 && hx <= t.box.right + sp / 2 && hy < t.box.top && hy > st.box.top - 4 * sp;
    });

  // ── 对着符头的一排（本仓新加） ────────────────────────────────────────────
  //
  // 上面那条要认得出汉字；赞美之泉的中文歌词多是坏 ToUnicode 的子集字体（抽出来是乱码，要等 `textLookup` 才解得出字），
  // 正则一个都碰不上。不看字面看排法：同字体同字号、同一条基线上三段以上，排在某行谱下方、没越过下一行谱，
  // **过半的段正上方有那行谱的符头**（歌词逐字对着音符印）。标题、页脚、版权行、段落词都碰不上「对着符头」。
  {
    const staffAbove = (t: PObj): Staff | null => {
      let best: Staff | null = null;
      for (const st of pg.staves) {
        if (st.box.bottom > t.box.top || t.box.right <= st.box.left || t.box.left >= st.box.right) continue;
        if (!best || st.box.bottom > best.box.bottom) best = st;
      }
      return best && !pg.staves.some((q) => q.box.top > best!.box.bottom && q.box.top < t.box.bottom) ? best : null;
    };
    const cand = texts.filter((t) => !kind.has(t) && t.run && !notLyric(t) && objText(t).trim());
    const above = new Map(cand.map((t) => [t, staffAbove(t)] as const));
    for (const t of cand) {
      const st = above.get(t);
      if (kind.has(t) || !st) continue;
      const h = t.box.bottom - t.box.top;
      const row = cand.filter(
        (u) =>
          !kind.has(u) && above.get(u) === st && u.run!.font === t.run!.font &&
          Math.abs(u.run!.sizeDev - t.run!.sizeDev) <= t.run!.sizeDev * 0.05 && Math.abs(u.box.bottom - t.box.bottom) <= h * 0.25,
      );
      if (row.length < 3) continue;
      if (row.filter((u) => underHead(u, st)).length * 2 <= row.length) continue;
      for (const u of row) kind.set(u, "lyric");
    }
  }

  // ── 中文歌词行的补锚（本仓新加） ──────────────────────────────────────────
  //
  // 上面那两个锚点都是**西文**的：带连字符的音节、音节之间的延长线。
  // 这本书的中文歌词逐字一个音节、字与字之间既不连字也不拉线，
  // 一整行下来一个锚点都没有——整行歌词就此丢掉
  // （实测 p27 第一行谱下的「田中的白鷺鷥無欠缺什麼」，那一首歌词只剩后五行）。
  //
  // 补的这一道是**自校准**的：拿这一页已经认定的歌词学出「字体 + 字号 + 离谱表底多远」，
  // 同字体同字号、落在同一条带里的未定文本也算歌词。不写绝对几何——
  // 那会把版权行、段落词、表情记号一并收进来。
  const known = texts.filter((t) => kind.get(t) === "lyric" && t.run);
  if (known.length) {
    /** 这段文本上方最近的那行谱（没有就是 null）。 */
    const staffAbove = (t: PObj): Staff | null => {
      let best: Staff | null = null;
      for (const st of pg.staves) {
        if (st.box.bottom > (t.box.top + t.box.bottom) / 2) continue;
        if (!best || st.box.bottom > best.box.bottom) best = st;
      }
      return best;
    };
    const fonts = new Set(known.map((t) => t.run!.font));
    const sizes = known.map((t) => t.run!.sizeDev).sort((a, b) => a - b);
    const size = sizes[sizes.length >> 1];
    let maxOff = 0;
    for (const t of known) {
      const st = staffAbove(t);
      if (st) maxOff = Math.max(maxOff, t.box.top - st.box.bottom);
    }
    if (maxOff > 0) {
      for (const t of texts) {
        // 表情术语只在这一路挡（钢琴 `rit.` 落在男声歌词带里，宣主荣耀 p2）；在延长线那一路也挡，
        // 赞美之泉的配对会连锁变（多两对歌词否决、少配上一首）
        if (kind.has(t) || !t.run || notLyric(t) || EXPRESSIONS.has(objText(t).trim().toLowerCase())) continue;
        const st = staffAbove(t);
        if (!st) continue;
        // 另一条路：正对着符头、字号与某个已知歌词相同（不比中位数：中英对照页中位数落在英文字号上），字体不论。
        // 行尾弱起那一个「祢」常是另一种字体单印一段（沙仑的玫瑰 p197）
        const z = t.run.sizeDev;
        const sameFont = fonts.has(t.run.font) && Math.abs(z - size) <= size * 0.05;
        if (!sameFont && !(underHead(t, st) && sizes.some((k) => Math.abs(z - k) <= k * 0.05))) continue;
        const off = t.box.top - st.box.bottom;
        // 落在已知歌词那条带里（宽一格的余量），且没越过下一行谱
        if (off < 0 || off > maxOff + sp) continue;
        const next = pg.staves.find((q) => q.box.top > st.box.bottom && q.box.top < t.box.bottom);
        if (next) continue;
        kind.set(t, "lyric");
      }
    }
  }

  // ── 同一排里换了字体的字（本仓新加） ────────────────────────────────────────
  //
  // 「祢」这类字常另印一段：造字区字体（EUDC），或是抽不出文字的图像蒙版字（`#mask`，文本为空，靠 `textLookup` 按字形认）。
  // 字体与同排歌词不同，上面几路都按字体成排、全漏（赞美之泉几十首「祢」整首缺）。已认定的歌词排里：
  // 同一条基线、横向落在谱表左右两端之内的，不论字体、有没有文字都并进来。
  // 横向不按这一排两端卡：行尾的「祢」常常离同排上一个字隔着几拍（我爱祢，我主 p153）。
  {
    const lyr = texts.filter((t) => kind.get(t) === "lyric");
    for (const t of texts) {
      if (kind.has(t) || !t.run || notLyric(t)) continue;
      // 同排＝竖向落在那几个字的盒子之内（放四分之一字高）：只比底边不行，有的字盒比同排短一截（深触我心 p167「们」底边高 4pt）
      const mates = lyr.filter((u) => {
        const tol = (u.box.bottom - u.box.top) * 0.25;
        return t.box.top >= u.box.top - tol && t.box.bottom <= u.box.bottom + tol;
      });
      if (mates.length < 2) continue;
      if (!pg.staves.some((st) => t.box.left >= st.box.left && t.box.right <= st.box.right)) continue;
      // 不跨谱表：这一段与那一排之间不能隔着一行谱的竖向范围
      if (pg.staves.some((st) => st.box.top < t.box.bottom && st.box.bottom > t.box.top)) continue;
      kind.set(t, "lyric");
    }
  }

  // 延长线那一路（水平线以下都算歌词）会把印在歌词带与下一行谱之间的表情术语也收进来（宣主荣耀 p2 钢琴的 `rit.`
  // 唱进了男声歌词）。改归表情只认这一种：斜体、整段是术语、**离下面那行谱比离上面那行谱近**（是给下面那行的）。
  // 放宽到「斜体术语一律退回」，赞美之泉的配对会连锁变（歌词里少一个拉丁词，汉字占比跨过歌词否决的门槛，少配上一首）
  for (const [t, k] of kind) {
    if (k !== "lyric" || !t.run || !/italic|oblique/i.test(t.run.font)) continue;
    if (!EXPRESSIONS.has(objText(t).trim().toLowerCase())) continue;
    const up = Math.min(...pg.staves.filter((st) => st.box.bottom <= t.box.top).map((st) => t.box.top - st.box.bottom));
    const down = Math.min(...pg.staves.filter((st) => st.box.top >= t.box.bottom).map((st) => st.box.top - t.box.bottom));
    if (down < up) kind.set(t, "expression");
  }

  // ── markHarmony ───────────────────────────────────────────────────────────
  // 判据照原文：含 `/`（转位和弦）；或整段就是一个大写音名；或 `X Y` 两个音名夹一个空格。
  for (const t of texts) {
    if (kind.has(t) || framed(t)) continue;
    let s = objText(t);
    let harm = s.includes("/");
    if (s.endsWith(" ")) s = s.slice(0, -1);
    if (s.length === 1 && isStepChar(s)) harm = true;
    if (s.length === 3 && s[1] === " " && isStepChar(s[0]) && isStepChar(s[2])) harm = true;
    if (harm) kind.set(t, "harmony");
  }

  // ── findInstrumentName ────────────────────────────────────────────────────
  // 系统线**左边**、纵向相交、离得不远的文字是声部名。
  for (const l of pg.segsWithTag("SysLine")) {
    for (const t of texts) {
      if (kind.has(t)) continue;
      if (t.box.left > l.box.right) continue;
      if (!overlapY(l.box, t.box)) continue;
      if (xSpace(l.box, t.box) > 6 * sp) continue;
      kind.set(t, "instrument");
    }
  }

  // ── findTempo ─────────────────────────────────────────────────────────────
  // 带 `=` 的那一段（`♩= 72`）连同同一行里**间距不超过三格**的左右邻居。
  for (const eq of pg.objs) {
    if (!eq.run || eq.hasAnyTag() || kind.has(eq)) continue;
    if (!objText(eq).includes("=")) continue;
    const row = pg.objs.filter((o) => o.run && overlapY(o.box, eq.box)).sort((a, b) => a.box.left - b.box.left);
    const idx = row.indexOf(eq);
    if (idx < 0) continue;
    let first = idx;
    for (let i = idx; i > 0; i--) {
      if (xSpace(row[i].box, row[i - 1].box) > 3 * sp) break;
      first = i - 1;
    }
    let last = idx;
    for (let i = idx; i < row.length - 1; i++) {
      if (xSpace(row[i].box, row[i + 1].box) > 3 * sp) break;
      last = i + 1;
    }
    for (let i = first; i <= last; i++) if (!kind.has(row[i])) kind.set(row[i], "tempo");
  }

  // ── findExpression ────────────────────────────────────────────────────────
  for (const t of texts) {
    if (kind.has(t)) continue;
    if (EXPRESSIONS.has(objText(t).trim().toLowerCase())) kind.set(t, "expression");
  }

  // ── findMeasureNumber ─────────────────────────────────────────────────────
  // 纯数字（或数字加连字符），且与某条系统线上下相邻。
  const syslines = pg.segsWithTag("SysLine");
  for (const o of pg.objs) {
    if (!o.run || o.hasAnyTag() || kind.has(o)) continue;
    const s = objText(o).trim();
    if (!/^[\d-]+$/.test(s)) continue;
    for (const l of syslines) {
      if (!overlapX(o.box, l.box)) continue;
      if (ySpace(o.box, l.box) > 3 * sp) continue;
      kind.set(o, "measureNumber");
      break;
    }
  }

  // ── findBoxedText ─────────────────────────────────────────────────────────
  // 描边矩形里圈住的文字（段落名「Chorus」之类）。
  for (const o of pg.objs) {
    if (o.hasAnyTag() || !o.path) continue;
    if (!o.path.paint.toLowerCase().includes("stroke")) continue;
    if (o.path.curves) continue;
    const inside = texts.filter((t) => !kind.has(t) && overlapX(t.box, o.box) && overlapY(t.box, o.box));
    if (!inside.length) continue;
    for (const t of inside) kind.set(t, "boxed");
  }

  // ── findTextFrames ────────────────────────────────────────────────────────
  // 同字体同字号、上下相接、左/右/中任一对齐的若干行 = 一个文本框（版权声明之类）。
  const poss = pg.objs.filter((o) => o.run && !o.hasAnyTag() && !kind.has(o) && !o.symbols.length).sort((a, b) => a.box.top - b.box.top);
  const usedIdx = new Set<number>();
  for (let i = 0; i < poss.length; i++) {
    if (usedIdx.has(i)) continue;
    const arr = [i];
    let boxI = poss[i].box;
    let cxI = (boxI.left + boxI.right) / 2;
    const szI = poss[i].run!.sizeDev;
    const fnI = poss[i].run!.font;
    for (let j = i + 1; j < poss.length; j++) {
      if (usedIdx.has(j)) continue;
      if (Math.abs(szI - poss[j].run!.sizeDev) > sp / 10) continue;
      if (fnI !== poss[j].run!.font) continue;
      const boxJ = poss[j].box;
      const cxJ = (boxJ.left + boxJ.right) / 2;
      if (ySpace(boxJ, boxI) > 2 * sp) continue;
      if (Math.abs(boxI.left - boxJ.left) < sp || Math.abs(boxI.right - boxJ.right) < sp || Math.abs(cxI - cxJ) < sp) {
        arr.push(j);
        boxI = boxJ;
        cxI = cxJ;
      }
    }
    if (arr.length <= 1) continue;
    for (const k of arr) {
      usedIdx.add(k);
      kind.set(poss[k], "textFrame");
    }
  }

  const out: TextAnalysis = { lyric: [], harmony: [], tempo: [], expression: [], instrument: [], measureNumber: [], boxed: [], textFrame: [] };
  const TAG = {
    lyric: "Lyric",
    harmony: "Harmony",
    tempo: "Tempo",
    expression: "Expression",
    instrument: "Instrument",
    measureNumber: "MeasureNumber",
    boxed: "Boxed",
    textFrame: "TextFrame",
  } as const;
  for (const [o, k] of kind) {
    out[k].push(o);
    o.addTag(TAG[k]);
  }
  return out;
}

/** `findExpression` 的表情术语表，照抄 musicpp 原文（小写比对）。 */
const EXPRESSIONS = new Set(
  [
    "a tempo", "unis.", "cresc.", "sub.", "sim.", "l.h.", "r.h.", "rubato",
    "cresc. al fine", "no rit.", "poco rit.", "dim. e rit.", "molto rall.",
    "molto rit.", "poco rall.", "rit.", "n.c.", "s.a.", "t.b.", "rall.",
    "cresc. poco a poco", "driving to the end", "slightly slower",
    "slightly broader", "with great rejoicing", "soprano", "alto", "freely",
    "slowly", "with motion", "s.a. unison", "t.b. unison", "c instrument",
    "expressively", "handbells", "tambourine", "gradually building",
    "(a few sopranos)", "(l.h. over)",
  ].map((s) => s.toLowerCase()),
);

// ── 歌词 → 音节 ─────────────────────────────────────────────────────────────

/** 一个音节：文字 + 它在页面上的中心 x。 */
export interface Syllable {
  text: string;
  cx: number;
  left: number;
  right: number;
  /** 后面跟着连字符（与下一个音节同属一个词）。 */
  hyphen: boolean;
  /** 组成它的字形。拿 GT 自举字形字典要用（见 `textglyphs.ts`）：
   *  ToUnicode 坏掉的那几档字体里 `text` 是乱码，字形轮廓才是唯一可信的身份。 */
  glyphs: VecGlyph[];
  /** 字形所属的字体家族与设备字号（查字典与建库都要，别再回头去 objs 里找）。 */
  font: string;
  sizeDev: number;
}

/**
 * 去掉**重描**出来的重复音节。
 *
 * 这一批 PDF 会把同一段文字画两遍（小节线也是这么画的，见 page.ts::mergeRedrawn）。
 * 不去重的话歌词里会冒出「春天现现香」「呼呼」「地上地上」这种叠字。
 *
 * 判据：**同一个字**且横向几乎重合（中心差不到自身宽度的三成）。
 * 只按位置不看字的话，会把「一一」「永永远远」这种真叠字也压掉。
 */
function dedupeSyllables(list: Syllable[]): Syllable[] {
  const out: Syllable[] = [];
  for (const s of list) {
    const prev = out[out.length - 1];
    if (prev && prev.text === s.text && Math.abs(prev.cx - s.cx) < (s.right - s.left) * 0.3) continue;
    out.push(s);
  }
  return out;
}

/** 这个字符是不是「认得出来的正文字符」：汉字、ASCII 可打印、常见中文标点。
 *  不在其列的多半是坏 ToUnicode 漏出来的乱码。 */
function isKnownChar(c: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff65\x20-\x7e]/.test(c);
}

/** 一行歌词：属于某一行谱的一段（第几段由行的上下顺序定）。 */
export interface LyricLine {
  staff: Staff;
  verse: number;
  top: number;
  syllables: Syllable[];
  /** 只挂这个声部的音（1 = 上声部，2 = 其余声部）；不设挂全行。位图路两声部一行谱、上下各印一行词时设（`splitVoiceLyrics`）。 */
  voice?: 1 | 2;
}

/**
 * 歌词文本 → 逐音节。
 *
 * 汉字一字一音节；拉丁文按空格断词、词内按 `-` 再断音节。
 * **连字符与延长线本身不是音节**（`-`、`--`、`__`），照 musicpp `replaceLrc` 的做法跳过。
 */
export function splitSyllables(o: PObj, dict?: TextGlyphLookup): Syllable[] {
  const run = o.run;
  if (!run) return [];
  const em = run.sizeDev || 1;
  /** 合成字体（`#` 打头）：位图路自己造的文本对象，没有真字体那些字形上的讲究。 */
  const synth = run.font.startsWith("#");
  const out: Syllable[] = [];
  let cur: { chars: string[]; left: number; right: number; glyphs: VecGlyph[] } | null = null;
  const flush = (hyphen: boolean) => {
    if (!cur) return;
    const text = cur.chars.join("").trim();
    // **半角标点紧贴在前一个音节后面的，并回去**（「祂!」「拜,」）：另起一个音节就占掉下一个音，
    // 后面的字整体错一格（宣主荣耀 m6 起女高唱成「祂 ! 哈 利」）
    const last = out[out.length - 1];
    if (last && /^[!,.?;:]+$/.test(text) && cur.left - last.right < em * 0.6) {
      last.text += text;
      last.right = cur.right;
      last.glyphs = [...last.glyphs, ...cur.glyphs];
      cur = null;
      return;
    }
    // 纯数字的不是歌词：那是**小节号**（`findMeasureNumber` 只认得贴着系统线的那些，
    // 印在框里的漏网）与行首的段号「1.」。GT 那边也把段号剔掉了。
    if (text && !/^[-_–—]+$/.test(text) && !/^\d+[.．、]?$/.test(text)) {
      out.push({ text, cx: (cur.left + cur.right) / 2, left: cur.left, right: cur.right, hyphen, glyphs: cur.glyphs, font: run.font, sizeDev: run.sizeDev });
    }
    cur = null;
  };
  for (const g of run.glyphs) {
    // 字形字典优先于 ToUnicode：本书几档 CJK 字体的 ToUnicode 是坏的（见 textglyphs.ts）
    const c = dict ? dict.lookup(run.font, g) : g.unicode;
    // **认不出来的小墨迹一律不输出**。那些是标点（「，」「。」之类）：
    // 字形字典按 GT 的歌词自举，而 GT 那侧的标点被归一掉了，所以标点的类永远定不了案，
    // 只能带着坏 ToUnicode 的乱码漏出来——实测占了中文歌词错字的一大半。
    // 吐一个乱码字比不吐更糟：不吐至少不会把后面的字顶偏。
    if (c && !isKnownChar(c) && g.bbox.w < em * 0.5 && g.bbox.h < em * 0.5) {
      flush(false);
      continue;
    }
    // **没有 ToUnicode 的 CJK 字体**（牵我的手的 PMingLiU 子集）：吐出来的是 CID 当码位，
    // `ĭ`、`ㇳ`、`Ἀ` 之类，大半落在下面「是不是汉字」那个区段外，被当成拉丁字母连成一个词，
    // 字间没空格的一段（「恩惠慈愛」）整段挂到一个音上，后面的字跟着错位。
    // 按墨迹认：乱码字形墨迹宽过 0.6 em 的是全角字，一字一音节（汉字墨迹实测 ≥0.77 em）；
    // 紧跟在这种字后面、宽不到 0.4 em 的乱码是半角标点（`;` `?` 偏高，上一条拦不住），
    // 另起音节会白占一个音，丢掉。拉丁词中间的重音字母（`cur` 非空）不受影响。
    if (c && !synth && !g.bboxEstimated && !isKnownChar(c)) {
      if (g.bbox.w >= em * 0.6) {
        flush(false);
        out.push({ text: c, cx: g.bbox.x + g.bbox.w / 2, left: g.bbox.x, right: g.bbox.x + g.bbox.w, hyphen: false, glyphs: [g], font: run.font, sizeDev: run.sizeDev });
        continue;
      }
      const last = out[out.length - 1];
      if (!cur && last?.glyphs.length === 1 && last.glyphs[0].bbox.w >= em * 0.6 && g.bbox.w < em * 0.4) continue;
    }
    // **整字见方的墨迹，却只读出一个 ASCII 字符：那是这套字体的全角空格。**
    // 这本书的歌词逐字一个文本对象，每个字后面跟一个这样的字形（全书 1754 个），
    // 它的 ToUnicode 是 `!`、轮廓是个空的字身框，量出来正好一个 em 见方。
    // 真的 ASCII 字母不会填满一个 em 见方，汉字则由字形字典给出汉字——
    // 所以这一条只会打中它。从前是靠形近补字歪打正着把它标成「1」、
    // 再被「纯数字不是歌词」那条剔掉的，字典一重建就露馅（歌词里冒出一串 `!`）。
    // `bboxEstimated` 的不算数：那是没有轮廓、按 advance 估的盒，量不出真墨迹。
    // **合成字体不适用这一条**（位图路造的 `#ocr` / `#raster`）：它讲的是某套 PDF 字体的
    // 全角空格字形，而合成对象的盒是按 OCR 的 `xFrac` 摊出来的，一个拉丁字母的盒
    // 轻易就过 0.8 em——实测《坚固保障》四行英文歌词整片被这条吃掉，一个音节都没剩。
    if (!synth && !g.bboxEstimated && g.bbox.w >= em * 0.8 && g.bbox.h >= em * 0.8 && c && /^[\x20-\x7e]$/.test(c)) {
      flush(false);
      continue;
    }
    if (!c || c === " " || c === "　") {
      flush(false);
      continue;
    }
    if (c === "-" || c === "–" || c === "—") {
      flush(true);
      continue;
    }
    if (c === "_") {
      flush(false);
      continue;
    }
    const cjk = /[㐀-鿿豈-﫿＀-￯]/.test(c);
    if (cjk) {
      flush(false);
      out.push({ text: c, cx: g.bbox.x + g.bbox.w / 2, left: g.bbox.x, right: g.bbox.x + g.bbox.w, hyphen: false, glyphs: [g], font: run.font, sizeDev: run.sizeDev });
      continue;
    }
    if (!cur) cur = { chars: [], left: g.bbox.x, right: g.bbox.x + g.bbox.w, glyphs: [] };
    cur.chars.push(c);
    cur.glyphs.push(g);
    cur.right = g.bbox.x + g.bbox.w;
  }
  flush(false);
  return out;
}

/**
 * 把歌词对象归成「哪一行谱的第几段」。
 *
 * 规则：一行歌词属于**它上方最近的那行谱**；同一行谱下方的歌词行按 y 从上到下
 * 依次是第 1、2、3 段。归行用纵向重叠（同一段歌词可能拆成好几个文本对象）。
 */
/** `buildLyricLines` 交给 `pickBelow` 判的那一行歌词。 */
export interface LyricRowInfo {
  syllables: Syllable[];
  objs: PObj[];
  /** 上方最近的谱（没有为 null）、下方最近的谱。 */
  above: Staff | null;
  below: Staff;
  /** 下方那行谱自己下面已经有词（它与再下一行谱之间、离它最近的就是它）。 */
  belowHasOwn: boolean;
  /** 上方那行谱与这一行之间已有它自己的汉字行。 */
  aboveHasOwn: boolean;
}

export function buildLyricLines(
  pg: SPage,
  lyrics: PObj[],
  dict?: TextGlyphLookup,
  /**
   * 位图路传：一行歌词**改挂到下方那行谱**的判据（印在谱表上方的词），见 `LyricRowInfo`；
   * 返回要挂的那行谱，返回 undefined 照默认（上方最近的那行）。
   */
  pickBelow?: (row: LyricRowInfo) => Staff | undefined,
): LyricLine[] {
  const rows: { top: number; bottom: number; objs: PObj[] }[] = [];
  // **位图路合成的对象（`#` 打头的字体）要纵向重叠过半才并**：那边一条歌词条就是一行，
  // 行距窄的中文段上下两条的盒互相压着十来个像素（标点、偏旁出头），擦边就并，
  // 三段词并成一段、按 x 交错（《倚靠主永远膀臂》第二行谱「遠膀臂；何我每日满等有…」）。
  // 文种不同的也不并：中英混在一条的，位图路已切成汉字、拉丁两个对象，要各成一行、各编各的段号
  const synth = (o: PObj) => !!o.run?.font.startsWith("#");
  const latin = (o: PObj) => {
    const t = objText(o);
    return (t.match(/[A-Za-z]/g)?.length ?? 0) > (t.match(/[\u3400-\u9fff]/g)?.length ?? 0) * 3;
  };
  for (const o of lyrics.slice().sort((a, b) => a.box.top - b.box.top)) {
    const row = rows.find((r) => {
      const ov = Math.min(r.bottom, o.box.bottom) - Math.max(r.top, o.box.top);
      if (!synth(o) || !r.objs.every(synth)) return ov > 0;
      return ov > Math.min(r.bottom - r.top, o.box.bottom - o.box.top) * 0.5 && r.objs.every((q) => latin(q) === latin(o));
    });
    if (row) {
      row.objs.push(o);
      row.top = Math.min(row.top, o.box.top);
      row.bottom = Math.max(row.bottom, o.box.bottom);
    } else rows.push({ top: o.box.top, bottom: o.box.bottom, objs: [o] });
  }
  const byStaff = new Map<Staff, { top: number; bottom: number; objs: PObj[] }[]>();
  // 歌词离它那行谱有多远才算「不是这行的」：**第一段**不过三个谱表高。
  // 不设上限的话，页脚的版权声明会被算成最后一行谱的歌词
  // （实测 p154 的 "Copyright 1953 S. K. Hine…" 就是这么混进去的）。
  const maxGap = Math.max(...pg.staves.map((s) => s.box.bottom - s.box.top), 1) * 3;
  // **后面几段按「接着上一段」收**，不各自量到谱行的距离。
  //
  // 独唱谱一页能印八段（《坚固保障》中文四段 + 英文四段），第五段起就出了三个
  // 谱表高——文本对象造得好好的，这里一条也不收。而单把上限放大到六个谱表高
  // **会打坏合唱谱**：那批多收进来的行让几条谱行凭空「有了词」，
  // `score.ts::assignSlots` 定谱行身份正靠「谱号 + 有没有词 + 音域」三样，
  // 跨系统连接一变，音符档从 85.23% 掉到 82.53%、扫描件从 67.07% 掉到 62.17%。
  // 改成链式：段与段之间本来就是等距排下来的，中间没有空当；
  // 页脚离最后一段远得很，链断在那里。
  // **只在位图路放这一条**（文本对象是合成的，`#` 打头的字体）。矢量路那本
  // 每首最多两段，用不上链式；开着反而收进本不该收的行——实测赞美之泉的歌词档
  // 94.95% → 94.88%，连带「同一版」那一档的曲目集合也动了（时值 97.71% → 97.62%）。
  const chainGap = maxGap / 3 * 0.8;
  // 改挂到下方那行谱的汉字行（`pickBelow` 判的）：同一夹缝里紧挨着它下面的拉丁行跟着走
  const movedBelow = new Map<(typeof rows)[number], Staff>();
  for (const r of rows) {
    // 上方最近的那行谱
    let best: Staff | null = null;
    let bestD = Infinity;
    for (const st of pg.staves) {
      const d = r.top - st.box.bottom;
      if (d < 0) continue;
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    if (pickBelow) {
      let below: Staff | null = null;
      let belowD = Infinity;
      for (const st of pg.staves) {
        const d = st.box.top - r.bottom;
        if (d >= 0 && d < belowD) (belowD = d), (below = st);
      }
      // 只判汉字行：一字一音，音节中心与符头对得齐；拉丁行按词切，词中心落在几个音中间，对位比不出来
      if (below && belowD <= maxGap && !r.objs.some(latin)) {
        const syllables = dedupeSyllables(r.objs.flatMap((o) => splitSyllables(o, dict)));
        // 上方的谱只要有就交出去（多段歌词后几段离谱远、靠链式接上，也是上方那行的）
        // 下方那行谱**自己下面已经有词**（它与再下一行谱之间、离它最近的就是它）：照简谱八度点「下声部脚下已有点，这颗归上声部」的互斥
        const own = rows.some((o) => {
          if (o === r || o.top <= below!.box.bottom) return false;
          const d = o.top - below!.box.bottom;
          return d <= maxGap && !pg.staves.some((st) => st !== below && st.box.bottom <= o.top && o.top - st.box.bottom < d);
        });
        // 上方那行谱与这一行之间**已有它自己的汉字行**：这一行是那串多段歌词往下接的一段（万古磐石歌第 4 段离下一系统近）
        const chained = !!best && rows.some((o) => o !== r && o.top >= best!.box.bottom && o.bottom <= r.top && !o.objs.some(latin));
        const alt = syllables.length ? pickBelow({ syllables, objs: r.objs, above: best, below, belowHasOwn: own, aboveHasOwn: chained }) : undefined;
        if (alt) {
          movedBelow.set(r, alt);
          const a = byStaff.get(alt) ?? [];
          a.push({ top: r.top, bottom: r.bottom, objs: r.objs });
          byStaff.set(alt, a);
          continue;
        }
      }
      // 拉丁行对位比不出来，跟它上面紧挨着的那行汉字走（望十架 p3 页顶：独唱声部的中英两行词都印在谱表上方，
      // 汉字行按对位挂到下方，英文行原来没有上方的谱、整行丢了）
      if (below && belowD <= maxGap && r.objs.some(latin)) {
        const prev = rows
          .filter((o) => o !== r && o.top < r.top && o.bottom <= r.top + (r.bottom - r.top) * 0.5 && !o.objs.some(latin))
          .sort((a, b) => b.bottom - a.bottom)[0];
        if (prev && movedBelow.get(prev) === below && !pg.staves.some((st) => st.box.top >= prev.bottom && st.box.bottom <= r.top)) {
          const a = byStaff.get(below) ?? [];
          a.push({ top: r.top, bottom: r.bottom, objs: r.objs });
          byStaff.set(below, a);
          continue;
        }
      }
    }
    if (!best) continue;
    const a = byStaff.get(best) ?? [];
    if (bestD > maxGap) {
      // 接不上已收的最后一段就不要（`rows` 已按 top 排好，最后一段就是最靠下的那段）
      const prev = a[a.length - 1];
      if (!prev || r.top - prev.bottom > chainGap) continue;
      if (!r.objs.every((o) => o.run?.font.startsWith("#"))) continue;
    }
    a.push({ top: r.top, bottom: r.bottom, objs: r.objs });
    byStaff.set(best, a);
  }
  const out: LyricLine[] = [];
  for (const [staff, rs] of byStaff) {
    rs.sort((a, b) => a.top - b.top);
    rs.forEach((r, i) => {
      const syllables = dedupeSyllables(r.objs.flatMap((o) => splitSyllables(o, dict)).sort((a, b) => a.cx - b.cx));
      if (syllables.length) out.push({ staff, verse: i + 1, top: r.top, syllables });
    });
  }
  return out;
}

// ── 挂到音符上 ──────────────────────────────────────────────────────────────

interface NoteLike {
  staff: Staff;
  rest: boolean;
  x: number;
  voice?: number;
  lyrics?: { verse: number; text: string; hyphen: boolean; cont: boolean }[];
  chord?: string;
  chordLater?: { text: string; frac: number }[];
}

/**
 * 歌词逐音节挂到音符上。
 *
 * **休止不挂词**（谱面上歌词只写在发声的音上）。同一行谱内按 x 双指针就近配对，
 * 保持顺序——不保持顺序的话，一个音节撞上邻音就会把后面整行错位。
 */
export function attachLyrics(notes: NoteLike[], lines: LyricLine[], sameCol = 0): void {
  for (const line of lines) {
    const cand = notes.filter((n) => n.staff === line.staff && !n.rest && (!line.voice || (line.voice === 1) === (n.voice === 1))).sort((a, b) => a.x - b.x);
    if (!cand.length) continue;
    let ni = 0;
    // 上一个音节末尾带连字符 → 这一个是**词中的续段**，MusicXML 的 `syllabic`
    // 要出 `middle`/`end` 而不是 `single`（`a-bid-eth` 的中段）。
    let cont = false;
    for (const syl of line.syllables) {
      // 往前推到「再往前就更远」为止。**同 x 的音（两个声部叠在一起）不算「更远」**，要越过去接着找：
      // 原来碰到距离相等就停，一行从中间起头的词（位图路从主歌行尾拆出来的副歌起句）整串卡在第一个音上
      for (let j = ni + 1; j < cand.length && cand[j].x - syl.cx <= Math.abs(cand[ni].x - syl.cx); j++)
        if (Math.abs(cand[j].x - syl.cx) < Math.abs(cand[ni].x - syl.cx)) ni = j;
      const n = cand[ni];
      (n.lyrics ??= []).push({ verse: line.verse, text: syl.text, hyphen: syl.hyphen, cont });
      cont = syl.hyphen;
      // 同一列（x 差不到 `sameCol`）的其余和弦成员一并跳过：一个和弦只挂一个音节。
      // 位图路才传（0.3 个线距）：只挪一个音，下一个音节常落到同一和弦的另一个成员上，
      // 两个音节挤在同一拍，按拍位展开从高到低排，词序就反了（信心使我得胜「they like a」读成「they a like」）
      while (sameCol > 0 && ni + 1 < cand.length && Math.abs(cand[ni + 1].x - n.x) < sameCol) ni++;
      if (ni + 1 < cand.length) ni++;
    }
  }
}

/**
 * 和弦文本 → 挂到音符上。
 *
 * 谱面把根音与后缀印成**两个文本对象**（`D` + `m7`），`markHarmonySuffix` 已经各自打了标，
 * 这里按「同一行、左右相接」再拼回一个记号；**位图路传 `merge = false`**
 * ——那边一个对象就是一个完整记号（`rasteromr/harmony.ts` 已按和弦文法切好），
 * 再拼一次会把谱面上挨着印的两个和弦并成一个（实测《坚固保障》42 个只剩 32 个）。
 * 根音里的升降号是音乐字体的字形
 * （`accidentalFlat` / `accidentalSharp`），照本仓和弦的写法**提到根音之后**写成 ASCII。
 */
export function attachHarmonies(pg: SPage, notes: NoteLike[], harmonies: PObj[], merge = true): void {
  const sp = pg.normalStaffSpace || pg.space;
  // **先按行归组、行内再按 x 排**。直接 `sort(top, left)` 不行：根音与后缀的
  // 基线差个零点几 pt（`D`@y128 与 `m7`@y127），一排下来会把所有根音排到所有后缀前面，
  // 于是一个都拼不上。
  const rows: { top: number; bottom: number; objs: PObj[] }[] = [];
  for (const o of harmonies.slice().sort((a, b) => a.box.top - b.box.top)) {
    const row = rows.find((r) => o.box.top < r.bottom && r.top < o.box.bottom);
    if (row) {
      row.objs.push(o);
      row.top = Math.min(row.top, o.box.top);
      row.bottom = Math.max(row.bottom, o.box.bottom);
    } else rows.push({ top: o.box.top, bottom: o.box.bottom, objs: [o] });
  }
  const groups: TextPiece[] = [];
  for (const row of rows) {
    // 逐段拼（`glyphPieces`）：一个对象里隔着大段空白的几个和弦先拆开，各拼各的后缀
    const pieces = row.objs.flatMap((o) => (merge ? glyphPieces(o, 2 * sp) : glyphPieces(o, Infinity).slice(0, 1)));
    pieces.sort((a, b) => a.box.left - b.box.left);
    let last: TextPiece | null = null;
    for (const o of pieces) {
      const t = o.text.trim();
      if (!t) continue;
      // 同一个和弦记号的根音与后缀是紧挨着的两个对象（`D` + `m7`、`B` + `Maj7`、`A` + `dim`）。
      // 门槛取两个线距——`A dim` 中间有个空格，实测 10pt ≈ 2 格；
      // 而同一行里相邻的两个和弦间隔十格开外，不会误并。
      if (merge && last && o.box.left - last.box.right < 2 * sp) {
        last.text += t;
        last.chars.push(...o.chars);
        last.box = {
          left: last.box.left,
          right: Math.max(last.box.right, o.box.right),
          top: Math.min(last.box.top, o.box.top),
          bottom: Math.max(last.box.bottom, o.box.bottom),
        };
      } else {
        last = { text: t, box: { ...o.box }, chars: o.chars.slice() };
        groups.push(last);
      }
    }
  }
  // 谱面上的升降号是乐谱字形，混在和弦带里；补进对应的记号
  for (const s of pg.symbols) {
    if (s.code !== "accidentalFlat" && s.code !== "accidentalSharp") continue;
    if (s.hasTag("Key") || s.hasTag("Accidental")) continue;
    const g = groups.find((q) => overlapY(q.box, s.box) && s.box.left >= q.box.left && s.box.left - q.box.right < sp);
    if (!g) continue;
    // 升降号写在音名**之后**（`Bb` / `F#`）——`harmonyXml` 是这么解的。
    // 谱面印的是 `B♭Maj7`（升降号在根音后、后缀前），拼出来的 `BMaj7b` 解不出，
    // 所以插在它左边紧挨着的那个字母后面，而不是往末尾追加；转位低音的（`E/G♯`）就落在低音后面。
    // 拿不到逐字位置的（位图路合成对象）退回第一个字母后面，见 `glyphPieces`
    let at = 0;
    for (let i = 0; i < g.chars.length; i++) if (g.chars[i].right <= s.box.left + sp * 0.2) at = i;
    const pos = g.chars.slice(0, at + 1).reduce((a, ch) => a + ch.c.length, 0);
    const acc = s.code === "accidentalFlat" ? "b" : "#";
    g.text = g.text.slice(0, pos) + acc + g.text.slice(pos);
    g.chars.splice(at + 1, 0, { c: acc, right: s.box.right });
    g.box.right = Math.max(g.box.right, s.box.right);
  }
  for (const g of groups) {
    const text = g.text.replace(/\s+/g, "");
    if (!text) continue;
    // **先定谱行，再在行内找音符**。原来是「下方所有谱行里 x 最近的那个」，
    // 一页只有一行谱时看不出问题；一页三个系统时就串行了——下一个系统同一个 x
    // 上的音符离得一样近，抢走了本行的和弦（实测《坚固保障》42 个和弦只落上 17 个，
    // 而且整片挂到别的系统去）。谱行取**下方最近**的那一行，与 `buildLyricLines`
    // 给歌词找谱行的规矩正好对称（那边是上方最近）。
    let staff: Staff | null = null;
    let staffD = Infinity;
    for (const st of pg.staves) {
      const d = st.box.top - g.box.bottom;
      if (d < 0 || d >= staffD) continue;
      staffD = d;
      staff = st;
    }
    if (!staff) continue;
    // 行内挂给 x 最近的那个音符；**它已经挂了和弦就顺延到最近的空闲音**。
    // 原来是 `??=`，后到的那个直接丢：长音上换和弦（《是谁》`G B B7` 三个挤在一个
    // 附点二分音符上）、行首和弦与第一个音之间夹着别的记号时，一丢就是一个。
    const cands = notes
      .filter((n) => n.staff === staff && Math.abs(n.x - g.box.left) < sp * 6)
      .sort((a, b) => Math.abs(a.x - g.box.left) - Math.abs(b.x - g.box.left));
    const best = cands.find((n) => !n.chord);
    if (best) {
      best.chord = text;
      continue;
    }
    // **长音中途换和弦**（牵我的手 Bass 全音符上 `F♯m … F♯7`、`B sus4 … B`）：附近没有空着的音，
    // 挂到这一刻还在响的那个音上（同一小节里、在和弦左边最近的音），按横向位置折成音内的偏移，
    // 写出时出 `<harmony><offset>`。量到下一个音或小节线为止。
    // 只开在矢量路（`merge`）：位图路的和弦条另有一套判据，那边原样丢弃
    if (!merge) continue;
    const bar = staff.bars.find((b) => g.box.left >= b.left && g.box.left < b.right);
    if (!bar) continue;
    const row = notes.filter((n) => n.staff === staff && !n.rest && n.x >= bar.left && n.x < bar.right).sort((a, b) => a.x - b.x);
    const host = row.filter((n) => n.x <= g.box.left).pop();
    if (!host) continue;
    const end = row.find((n) => n.x > host.x + sp * 0.5)?.x ?? bar.right;
    const frac = (g.box.left - host.x) / Math.max(end - host.x, sp);
    if (frac <= 0 || frac >= 1) continue;
    (host.chordLater ??= []).push({ text, frac });
  }
}

// ── 速度与表情文字 → 音符上的 words / metronome ─────────────────────────────

/** 节拍器文字（`q = c 76`、`♩= 72`）：音符字形（正文字体里的 `q`/`h`/`e`，或乐谱字形的 ♩）+ `=` + 可带 `c.`/`ca.` 的数字。 */
const METRO_TEXT_RE = /([qhe♩♪𝅗𝅥])?\.?\s*=\s*(ca?\.?\s*)?(\d{2,3})/;
const METRO_UNIT: Record<string, string> = { q: "quarter", "♩": "quarter", h: "half", "𝅗𝅥": "half", e: "eighth", "♪": "eighth" };

/** 同一条速度里相邻两段的横向间隙上限（格）：与 `analyzeText` 把 `=` 两边的段收进速度那一步同口径。 */
const TEMPO_JOIN_GAP = 3;

/**
 * `analyzeText` 认出的**速度**（`Andante`、`q = c 76`）与**表情**（`rit.`）挂到音符上，出 `<direction>`。
 * 原文到打标为止；挂法同位图路的 `rasteromr/words.ts::attachWordLines`：先定谱行（纵向离谁近），
 * 再取这一行里文字左端往左让一格之后、右边最近的那个音（没有就取这一行最后一个）。
 *
 * **一条速度在文字层里常是好几段**（`Andante` 一段正文字体、`q = c 76` 一段谱字体），要先并回一条：
 * 纵向交叠、横向相邻的段从左到右连起来，挂在最左那段的音上——各挂各的话文字与节拍器成了两个对象，
 * 还会落到不同的音上（宣主荣耀钢琴 m1：`Andante` 挂第一拍、节拍器挂到第二拍）。
 * 并好的一条里有节拍器的：节拍器前面的文字进 `tempoText`，与节拍器写进同一个 `<direction>`。
 * `c`（EngraverText 的「c.」字形，文字层只吐出一个 c）照谱面写成 `c. 76`。
 */
export function attachDirectionTexts(
  pg: SPage,
  notes: { staff: Staff; x: number; chordExtra?: boolean; grace?: boolean; words?: { text: string; above: boolean }[]; metronome?: StaffNote["metronome"]; tempoText?: string }[],
  text: TextAnalysis,
): void {
  const sp = pg.normalStaffSpace || pg.space;
  const tempo = [...text.tempo].filter((o) => objText(o).trim()).sort((a, b) => a.box.left - b.box.left);
  const lines: PObj[][] = [];
  for (const o of tempo) {
    const line = lines.find((l) => {
      const last = l[l.length - 1];
      return overlapY(last.box, o.box) && xSpace(last.box, o.box) <= sp * TEMPO_JOIN_GAP;
    });
    if (line) line.push(o);
    else lines.push([o]);
  }
  const items = [...lines.map((l) => ({ objs: l, tempo: true })), ...text.expression.map((o) => ({ objs: [o], tempo: false }))];
  for (const { objs, tempo: isTempo } of items) {
    const parts = objs.map((o) => objText(o).replace(/\s+/g, " ").trim()).filter(Boolean);
    if (!parts.length) continue;
    const box = {
      left: Math.min(...objs.map((o) => o.box.left)),
      right: Math.max(...objs.map((o) => o.box.right)),
      top: Math.min(...objs.map((o) => o.box.top)),
      bottom: Math.max(...objs.map((o) => o.box.bottom)),
    };
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    let stf: Staff | undefined;
    let bd = Infinity;
    for (const st of pg.staves) {
      if (cx < st.box.left - sp * 2 || cx > st.box.right + sp * 2) continue;
      const d = cy < st.box.top ? st.box.top - cy : cy > st.box.bottom ? cy - st.box.bottom : 0;
      if (d < bd) (bd = d), (stf = st);
    }
    if (!stf) continue;
    const row = notes.filter((n) => n.staff === stf && !n.chordExtra && !n.grace).sort((a, b) => a.x - b.x);
    const note = row.find((n) => n.x >= box.left - sp) ?? row[row.length - 1];
    if (!note) continue;
    const s = parts.join(" ");
    const metro = isTempo && s.includes("=") ? METRO_TEXT_RE.exec(s) : null;
    if (metro) {
      const bpm = Number(metro[3]);
      note.metronome = { unit: METRO_UNIT[metro[1] ?? "q"] ?? "quarter", bpm, ...(metro[2] ? { text: `c. ${bpm}` } : {}) };
      const words = s.slice(0, metro.index).trim();
      if (words) note.tempoText = words;
      continue;
    }
    (note.words ??= []).push({ text: s, above: cy < (stf.box.top + stf.box.bottom) / 2 });
  }
}
