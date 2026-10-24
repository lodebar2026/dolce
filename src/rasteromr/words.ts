// 谱面上的**文字指示**（rit. / a tempo / cresc. / dim. / 速度语 / Fine / D.S. al Coda / unis. …）与节拍器记号：切条、算指纹、归位。
//
// 与声部标签（`stafflabel.ts`）同一套架构：**只按固定几何裁带**（两行谱之间的整段空当、页首行上方、页末行下方），
// 定位与认字交给 DBNet + rec，离线按条的内容指纹落盘（`gen-rasterwords.mjs` → `rasterwords.json`），识别时查缓存。
// 带里还压着歌词、和弦字母、力度字母、小节号——这里按内容分开：只留拉丁文的词句，歌词行、纯数字、力度字母不要。
import type { Binary, Rect } from "../omrkit/types";
import { isCreditText, type WordLine } from "../omrkit/headertext";
import { recoverSpacesByInk } from "../omrkit/textspace";
import type { Box, SPage, Staff } from "../staffomr/model";
import type { StaffNote } from "../staffomr/notedata";
import { chordCoverage, isChordLineCoverage, isWholeChord } from "../omrkit/chordgrammar";
import { liftRange, type RasterUnit } from "./staffline";
import { contentKey } from "../omrkit/contentkey";

/** 一条文字带：裸像素 + 它在页面上的盒。 */
export interface WordStrip {
  w: number;
  h: number;
  /** 逐像素 0/1，长 `w*h`，1 = 墨。 */
  data: Uint8Array;
  box: Rect;
  /** 声部名带（`findNameStrips`）：指纹前缀与挑行口径另算（中文名也留，`keepStripLine`） */
  name?: boolean;
  /** 框字带（`findFrameStrips`）：方框里的字单独切出来，读出来的就是排练号 / 框着的段落名 */
  frame?: boolean;
}

/** 页首行上方、页末行下方各取这么多格；两行谱之间取整段空当，上下各让开谱线这么多格。 */
const EDGE_BAND = 7;
const LINE_CLEAR = 0.15;
/** 带的左右：谱行左缘往左这么多格（行首上方的速度语常比谱号还靠左）到右缘往右这么多格。 */
const SIDE = 2;

/**
 * 裁出各条文字带。**几何是死的**（只看谱行的盒），同一页跑几次裁出来一模一样，指纹才稳。
 */
export function findWordStrips(bin: Binary, staves: WordStaff[], unit: RasterUnit): WordStrip[] {
  const sp = unit.space;
  const rows = [...staves].sort((a, b) => a.box.top - b.box.top);
  const out: WordStrip[] = [];
  // 页首行上方、页末行下方那条超出页面的，**照原高切、页外填白**（盒的 y 可以是负的）：贴着页边截断的窄带 DBNet 吃亏，
  // 破碎 p9 页顶「Soprano 1」离页边四点，截成 54 点高的带只读出「Soprano」
  // 弯、斜的谱行：带的上下界取谱线在这一段的包络（罩得住整行的字），带里落进谱表（连让线那一点）的逐列刷白，
  // 不让一头的谱线进带。`upper(x)` 以上是上一行谱、`lower(x)` 以下是下一行谱；平直的谱行两个都不给，带与原来逐像素相同
  const cut = (y0: number, y1: number, left: number, right: number, upper?: (x: number) => number, lower?: (x: number) => number) => {
    const box = {
      x: Math.max(0, Math.round(left - sp * SIDE)),
      y: Math.round(y0),
      w: 0,
      h: 0,
    };
    box.w = Math.min(bin.w, Math.round(right + sp * SIDE)) - box.x;
    box.h = Math.round(y1) - box.y;
    if (box.w < 8 || Math.min(bin.h, box.y + box.h) - Math.max(0, box.y) < sp * 1.2) return;
    const data = new Uint8Array(box.w * box.h);
    let ink = 0;
    for (let x = 0; x < box.w; x++) {
      const ya = upper ? Math.max(0, Math.round(upper(box.x + x)) - box.y) : 0;
      const yb = lower ? Math.min(box.h, Math.round(lower(box.x + x)) - box.y) : box.h;
      for (let y = Math.max(ya, -box.y); y < yb && box.y + y < bin.h; y++) {
        const v = bin.data[(box.y + y) * bin.w + box.x + x];
        data[y * box.w + x] = v;
        ink += v;
      }
    }
    if (ink) out.push({ w: box.w, h: box.h, data, box });
  };
  const clear = sp * LINE_CLEAR;
  rows.forEach((st, i) => {
    const prev = rows[i - 1];
    // 左右并排的两行谱（同一高度）不算上下邻行
    const above = prev && prev.box.bottom < st.box.top ? prev : undefined;
    const lift = st.lift;
    const [lo, hi] = liftRange(lift, st.box.left, st.box.right);
    const topAt = lift && ((x: number) => st.box.top + lift(x) - clear);
    const botAt = lift && ((x: number) => st.box.bottom + lift(x) + clear);
    if (above) {
      const al = above.lift;
      const [alo] = liftRange(al, above.box.left, above.box.right);
      cut(above.box.bottom + alo + clear, st.box.top + hi - clear, Math.min(above.box.left, st.box.left), Math.max(above.box.right, st.box.right), al && ((x) => above.box.bottom + al(x) + clear), topAt);
    } else cut(st.box.top + lo - sp * EDGE_BAND, st.box.top + hi - clear, st.box.left, st.box.right, undefined, topAt);
    if (i === rows.length - 1) cut(st.box.bottom + lo + clear, st.box.bottom + hi + sp * EDGE_BAND, st.box.left, st.box.right, botAt);
  });
  return out;
}

/** 文字带要的谱行：盒（页面坐标），弯、斜的另带逐列偏移（`staffline.ts::liftOf`）。 */
export interface WordStaff {
  box: { left: number; right: number; top: number; bottom: number };
  lift?: (x: number) => number;
}

/** 方框：边线粗不过这么多格；框高、框宽的范围（格）；框里四周垫白（格）。 */
const FRAME_LINE_MAX = 0.3;
const FRAME_MIN_H = 1.2;
const FRAME_MAX_H = 3.5;
const FRAME_MIN_W = 1.0;
const FRAME_MAX_W = 15;
const FRAME_PAD = 1;
/** 框里贴边那一圈的墨占比上限、框外贴上下边那一行的墨占比上限。 */
const FRAME_RING = 0.05;
const FRAME_OUTER = 0.2;

/**
 * **框字带**：文字带里的方框（排练号 `[A]`、框着的段落名 `[Interelude]`），框里的字单独切成一条、四周垫白再送 OCR。
 * 整条文字带两千多点宽，DBNet 常把框里孤零零一个字母漏掉（宁静 p5 m73 的 `A`）；方框本身的几何很确定：
 * 上下两条等长的细横线，两端各有一条竖边连着。只取框**里面**（让开边线），不让边线读成 `[`、`|`。
 */
export function findFrameStrips(strips: readonly WordStrip[], unit: RasterUnit): WordStrip[] {
  const sp = unit.space;
  const out: WordStrip[] = [];
  for (const st of strips) {
    if (st.name || st.frame) continue;
    const at = (x: number, y: number) => x >= 0 && y >= 0 && x < st.w && y < st.h && st.data[y * st.w + x] === 1;
    // 每行的横游程（长度在框宽范围内），相邻几行同一段并成一条线
    type Seg = { x0: number; x1: number; y0: number; y1: number };
    const segs: Seg[] = [];
    let open: Seg[] = [];
    for (let y = 0; y < st.h; y++) {
      const runs: { x0: number; x1: number }[] = [];
      for (let x = 0; x < st.w; ) {
        if (!at(x, y)) {
          x++;
          continue;
        }
        const x0 = x;
        while (x < st.w && at(x, y)) x++;
        if (x - x0 >= sp * FRAME_MIN_W && x - x0 <= sp * FRAME_MAX_W) runs.push({ x0, x1: x - 1 });
      }
      const next: Seg[] = [];
      for (const r of runs) {
        const o = open.find((q) => Math.abs(q.x0 - r.x0) <= 2 && Math.abs(q.x1 - r.x1) <= 2);
        if (o) {
          o.y1 = y;
          next.push(o);
        } else {
          const sg = { ...r, y0: y, y1: y };
          segs.push(sg);
          next.push(sg);
        }
      }
      open = next;
    }
    const lines = segs.filter((g) => g.y1 - g.y0 + 1 <= sp * FRAME_LINE_MAX);
    for (const a of lines)
      for (const b of lines) {
        const hgt = b.y0 - a.y1;
        if (hgt < sp * FRAME_MIN_H || hgt > sp * FRAME_MAX_H) continue;
        if (Math.abs(a.x0 - b.x0) > 3 || Math.abs(a.x1 - b.x1) > 3) continue;
        // 两端的竖边：在两条横线之间每行都有墨（边线一两点宽，容一点偏）
        const side = (x: number) => {
          let n = 0;
          for (let y = a.y1 + 1; y < b.y0; y++) if (at(x, y) || at(x + 1, y) || at(x - 1, y)) n++;
          return n >= (b.y0 - a.y1 - 1) * FRAME_COVER;
        };
        if (!side(Math.min(a.x0, b.x0) + 1) || !side(Math.max(a.x1, b.x1) - 1)) continue;
        // 框里：让开边线（横线粗、竖边找到墨尽处）
        let ix0 = Math.min(a.x0, b.x0) + 1;
        while (ix0 < a.x1 && side(ix0)) ix0++;
        let ix1 = Math.max(a.x1, b.x1) - 1;
        while (ix1 > ix0 && side(ix1)) ix1--;
        const iy0 = a.y1 + 2;
        const iy1 = b.y0 - 2;
        if (ix1 - ix0 < 3 || iy1 - iy0 < 3) continue;
        // 字不碰框：框里紧贴边线那一圈（两点宽）几乎全白；框外紧贴上下边那一行也基本空（不是更大一块图形里的两道横）
        let ring = 0;
        let ringN = 0;
        for (let y = iy0; y <= iy1; y++)
          for (let x = ix0; x <= ix1; x++) {
            if (y > iy0 + 1 && y < iy1 - 1 && x > ix0 + 1 && x < ix1 - 1) continue;
            ringN++;
            ring += at(x, y) ? 1 : 0;
          }
        if (ring > ringN * FRAME_RING) continue;
        let outer = 0;
        for (let x = a.x0; x <= a.x1; x++) outer += (at(x, a.y0 - 2) ? 1 : 0) + (at(x, b.y1 + 2) ? 1 : 0);
        if (outer > (a.x1 - a.x0 + 1) * 2 * FRAME_OUTER) continue;
        let ink = 0;
        for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++) ink += at(x, y) ? 1 : 0;
        if (!ink) continue;
        const pad = Math.round(sp * FRAME_PAD);
        const w = ix1 - ix0 + 1 + pad * 2;
        const h = iy1 - iy0 + 1 + pad * 2;
        const data = new Uint8Array(w * h);
        for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++) data[(y - iy0 + pad) * w + x - ix0 + pad] = at(x, y) ? 1 : 0;
        out.push({ w, h, data, box: { x: st.box.x + ix0 - pad, y: st.box.y + iy0 - pad, w, h }, frame: true });
      }
  }
  return out;
}

/** 声部名带往左伸到全页最靠左那行谱的左缘再往左这么多格（不缩进的系统，缩写印在页边）；右界让开花括号、方括号这么多格 */
const NAME_REACH = 8;
const NAME_CLEAR = 1.5;

/**
 * **声部名带**：每个系统谱行左边那一段（首行缩进里的全名「Soprano Alto」「Piano」、以后各行页边的缩写「S. A.」），
 * 上下到系统首尾谱行外一格。认字同文字指示带（同一个缓存、同一套 OCR），名字归哪个声部由 `staffomr/score.ts::nameParts` 按纵向定。
 */
export function findNameStrips(bin: Binary, systems: { staves: { box: { left: number; top: number; bottom: number }; lift?: (x: number) => number }[] }[], unit: RasterUnit): WordStrip[] {
  const sp = unit.space;
  const lefts = systems.flatMap((s) => s.staves.map((st) => st.box.left));
  if (!lefts.length) return [];
  const pageLeft = Math.min(...lefts);
  const out: WordStrip[] = [];
  for (const sys of systems) {
    if (!sys.staves.length) continue;
    const left = Math.min(...sys.staves.map((st) => st.box.left));
    const x0 = Math.max(0, Math.round(pageLeft - sp * NAME_REACH));
    const x1 = Math.round(left - sp * NAME_CLEAR);
    // 名字印在谱行左端外：弯、斜的谱行按左端那一列的线位
    const at = (st: { box: { left: number }; lift?: (x: number) => number }) => st.lift?.(st.box.left) ?? 0;
    const y0 = Math.max(0, Math.round(Math.min(...sys.staves.map((st) => st.box.top + at(st))) - sp));
    const y1 = Math.min(bin.h, Math.round(Math.max(...sys.staves.map((st) => st.box.bottom + at(st))) + sp));
    if (x1 - x0 < sp * 2 || y1 - y0 < sp * 2) continue;
    const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const data = new Uint8Array(box.w * box.h);
    let ink = 0;
    for (let y = 0; y < box.h; y++)
      for (let x = 0; x < box.w; x++) {
        const v = bin.data[(box.y + y) * bin.w + box.x + x];
        data[y * box.w + x] = v;
        ink += v;
      }
    if (ink) out.push({ w: box.w, h: box.h, data, box, name: true });
  }
  return out;
}

/** 声部名的一块里上下两行之间的空不超过行高的这么多倍（「Soprano」「Alto」叠成一个名字） */
const NAME_STACK_GAP = 0.8;

/**
 * 声部名带里读出来的行 → 页面上的名字块（页面坐标，字号按墨迹量）。上下叠着、左右相交的行并成一块（多行名用换行连）；
 * 只要像名字的：有拉丁字母或汉字（「女低」）、不是力度字母（行首的 `p`、`mf`）。
 */
export function partNameLines(pg: SPage, strips: readonly WordStrip[], ocr: ReadonlyMap<string, WordLine[]>): { text: string; box: Box; size: number }[] {
  const out: { text: string; box: Box; size: number }[] = [];
  for (const strip of strips) {
    const lines = (ocr.get(wordKey(strip)) ?? [])
      .map((l) => ({ t: l.t.trim(), x: strip.box.x + l.x, y: strip.box.y + l.y, w: l.w, h: l.h }))
      .filter((l) => NAME_CHAR_RE.test(l.t) && !/^(ppp|pp|p|mp|mf|fff|ff|f|sfz|sf|fz|fp)$/.test(l.t))
      .sort((a, b) => a.y - b.y);
    const blocks: (typeof lines)[] = [];
    for (const l of lines) {
      const b = blocks.find((bl) => {
        const last = bl[bl.length - 1]!;
        return l.y - (last.y + last.h) < Math.min(l.h, last.h) * NAME_STACK_GAP && l.x < last.x + last.w && last.x < l.x + l.w;
      });
      if (b) b.push(l);
      else blocks.push([l]);
    }
    for (const bl of blocks) {
      const sizes = bl.map((l) => pg.inkTextSize?.({ x: l.x, y: l.y, w: l.w, h: l.h }, l.t) || l.h);
      out.push({
        text: bl.map((l) => l.t).join("\n"),
        box: {
          left: Math.min(...bl.map((l) => l.x)),
          right: Math.max(...bl.map((l) => l.x + l.w)),
          top: bl[0]!.y,
          bottom: Math.max(...bl.map((l) => l.y + l.h)),
        },
        size: Math.max(...sizes),
      });
    }
  }
  return out;
}

/** 页眉带：`creditFrom` 是首行谱上方那一段在带里的起点（拼页面那一路没有这一段）。 */
export type HeaderStrip = WordStrip & { creditFrom?: number };

/**
 * **页眉带**（曲首页）：页顶 → 首行谱上沿（让开谱线 `LINE_CLEAR`），整页宽——标题、副标题、书眉、词曲作者、译者。
 * 下沿从谱上沿往上找第一条空白行（墨不过两点），免得把一行字拦腰切开；几何只看谱行与像素，指纹稳。
 * 与文字指示带同一套认字（DBNet + rec），缓存另放（`gen-rasterheader.mjs` → `rasterheader.json`）：那边只留拉丁行，这边中文也要。
 *
 * - **首行谱上方 `EDGE_BAND` 格以内这一段**也进带（`creditFrom` 标出它在带里的起点）：紧贴谱表印的小字署名块
 *   （新编赞美诗「刘廷芳译 1934」「(Thomas Hastings)」、伴奏谱「伴奏编写：陈尚哲」、父恩广大三行英文署名）都在这里；
 *   这一段也是首行文字指示带（速度、和弦、表情），里面的行由 `headerZoneLines` 挑——像署名的归页眉，其余照旧归文字指示。
 *   上面那段切不出（`EDGE_BAND` 以上没有空白行、或贴着页顶）就整条不切，照旧走拼页面那条路。
 * - **扫描件页边带着贯穿上下的竖条**（破碎扫描版右缘一道 80 点宽的网点灰带，每行十几二十点墨）：没有一行墨不过两点，
 *   往上一路找到页顶。判空白行时不数页边「这一段里平均每列一成以上的行有墨」的列（`HEADER_BORDER`）。
 * - 密排的序言曾被凑成一行假谱表、把页眉带截在标题下面：找谱线之前已按文字框剔掉（`pagetext.ts`）。
 */
export function findHeaderStrip(bin: Binary, staves: WordStaff[], unit: RasterUnit): HeaderStrip | null {
  if (!staves.length) return null;
  const sp = unit.space;
  // 弯、斜的谱行取第一线最高的那一处：带底不切进谱线
  const top = Math.min(...staves.map((s) => s.box.top + liftRange(s.lift, s.box.left, s.box.right)[0]));
  let y1 = Math.min(bin.h - 1, Math.round(top - sp * LINE_CLEAR));
  let y0 = Math.min(y1, Math.round(top - sp * EDGE_BAND));
  if (y0 < sp * 2) return null;
  // 页边的竖条：页顶到谱上沿这一段里，按两格宽滑窗平均、墨行占比过 `HEADER_BORDER` 的列，只看左右各 `HEADER_MARGIN` 页宽
  const colInk = new Uint32Array(bin.w + 1);
  for (let y = 0; y <= y1; y++) for (let x = 0; x < bin.w; x++) colInk[x + 1] += bin.data[y * bin.w + x];
  for (let x = 1; x <= bin.w; x++) colInk[x] += colInk[x - 1];
  const half = Math.max(1, Math.round(sp));
  const border = new Uint8Array(bin.w);
  for (let x = 0; x < bin.w; x++) {
    if (x > bin.w * HEADER_MARGIN && x < bin.w * (1 - HEADER_MARGIN)) continue;
    const a = Math.max(0, x - half);
    const b = Math.min(bin.w, x + half + 1);
    border[x] = colInk[b] - colInk[a] > (b - a) * (y1 + 1) * HEADER_BORDER ? 1 : 0;
  }
  const inkOf = (y: number) => {
    let n = 0;
    for (let x = 0; x < bin.w && n <= HEADER_BLANK; x++) if (!border[x]) n += bin.data[y * bin.w + x];
    return n;
  };
  // 往上退到空白行，最多退 `HEADER_RETREAT` 格：排得密的页眉（晨曦破晓左右两栏署名与标题、题记上下交错）一整段找不到空白行，
  // 一路退会退到页顶、整条页眉只剩几十点高——退不到就照原线切，被切到的行按行心归哪段
  const retreat = (y: number, floor: number) => {
    let t = y;
    while (t > floor && y - t <= sp * HEADER_RETREAT && inkOf(t) > HEADER_BLANK) t--;
    return inkOf(t) <= HEADER_BLANK ? t : y;
  };
  y0 = retreat(y0, 0);
  if (y0 < sp * 2) return null;
  y1 = retreat(y1, y0);
  const box = { x: 0, y: 0, w: bin.w, h: y1 };
  // 弯、斜的页上页眉也斜（晨曦破晓整页斜一格，斜体小字的词缝在斜行里找不到空白列，补不出空格）：按第一行谱曲线两端连线的
  // 平均斜率（整页的旋转）逐列挪整像素取条，挪出原范围的填白。平直的页条逐像素不变。
  // 按条里字块自己的排列量（`lyric.ts::textSkew`）试过：页眉是几栏错落的短行，斜到 2.8% 也凑得出尖剖面（晨曦破晓页眉 62.5 → 46.9）
  const first = staves.reduce<WordStaff | null>((a, s) => (!a || s.box.top < a.box.top ? s : a), null);
  const x0 = bin.w / 2;
  const skew = first?.lift ? (first.lift(first.box.right) - first.lift(first.box.left)) / Math.max(1, first.box.right - first.box.left) : 0;
  const data = new Uint8Array(box.w * box.h);
  let ink = 0;
  for (let x = 0; x < box.w; x++) {
    const d = Math.round(skew * (x - x0));
    for (let y = 0; y < box.h; y++) {
      const sy = y + d;
      if (sy >= 0 && sy < box.h) ink += data[y * box.w + x] = bin.data[sy * bin.w + x];
    }
  }
  return ink ? { w: box.w, h: box.h, data, box, creditFrom: y0 } : null;
}

/**
 * 页眉带里**首行谱上方那一段**（`creditFrom` 以下）读出来的行，哪些归页眉：像署名的——
 * 带汉字的要有职能字 / 年份 / 冒号（「刘廷芳译 1934」「伴奏编写：陈尚哲」「颂主诗集 1931」），
 * 拉丁的是括号原名、`Words by` 一类，或两词以上、多半首字母大写的名字（「Chinese Traditional Melody」「Chao Tzu-Chen」）；
 * 再加**续行**：紧接在已收的署名行下面、与它左对齐或右对齐的行（「Song of The Hoe」「Psalmodia Sacra, Goths 1715」）。
 * 拉丁的另收全大写的曲调名、带四位年份的行（「1795-1848」）；**居中**的行（副标题、题记「Be still and know that I am God.」）
 * 照收——速度、表情都印在谱首、不居中。
 * 和弦、节拍器、力度、文字指示术语（含中文的「齐唱」「感恩地」）一概不收（留给文字指示带）——`creditFrom` 以上也不收：
 * 「感恩地」印在速度旁边、比谱上方 7 格还高。返回留下的行。
 */
export function headerZoneLines<L extends WordLine>(lines: readonly L[], creditFrom: number, stripW: number): L[] {
  const inZone = (l: L) => l.y + l.h / 2 > creditFrom;
  const centered = (l: L) => Math.abs(l.x + l.w / 2 - stripW / 2) <= stripW * 0.15;
  const music = (t: string) => {
    const s = t.trim();
    if (METRO_RE.test(s) || DYNAMIC_RE.test(s) || DIRECTION_RE.test(s) || CN_EXPRESSION_RE.test(s)) return true;
    const { cov, count } = chordCoverage(s.replace(/\s+/g, ""));
    return isChordLineCoverage(cov, count);
  };
  const looksCredit = (t: string) => {
    if (music(t)) return false;
    if (/[\u3400-\u9fff]/.test(t)) return /[词詞曲译譯编編修配写寫作选選据據改源]|\d{2,}|[:：]/.test(t);
    if (isCreditText(t, true, true) || /\d{4}/.test(t) || SCRIPTURE_REF_RE.test(t)) return true;
    const words = t.match(/[A-Za-z][A-Za-z'’.-]*/g) ?? [];
    // 右上角全大写的曲调名（「AZMON」「DIX」「FINLANDIA」）
    if (words.length && words.every((w) => !/[a-z]/.test(w)) && words.join("").length >= 3) return true;
    // 人名、出处：两词以上、首字母大写的过三分之一（补空格把字距拉开的词切碎时，小写碎片会多出来）
    const caps = words.filter((w) => /^[A-Z]/.test(w)).length;
    return words.length >= 2 && caps >= 2 && caps * 3 >= words.length;
  };
  const kept = lines.filter((l) => (!inZone(l) || looksCredit(l.t) || centered(l)) && !music(l.t));
  const zone = lines.filter((l) => inZone(l) && !kept.includes(l)).sort((a, b) => a.y - b.y);
  for (const l of zone) {
    if (music(l.t)) continue;
    const near = kept.some((k) => {
      const gap = l.y - (k.y + k.h);
      const tol = Math.max(k.h, l.h) * 1.5;
      return gap >= -k.h * 0.3 && gap <= Math.max(k.h, l.h) && (Math.abs(l.x - k.x) <= tol || Math.abs(l.x + l.w - (k.x + k.w)) <= tol);
    });
    if (near) kept.push(l);
  }
  return lines.filter((l) => kept.includes(l));
}
/** 经文 / 诗篇出处：「Psalm 23」「— Ephesians 2:7」。 */
const SCRIPTURE_REF_RE = /^[—–-]?\s*(?:[1-3I]{1,3}\s*)?[A-Z][a-z]+\.?\s*\d+(?:\s*:\s*\d+)?\s*$/;
/** 中文的演唱 / 表情提示：「齐唱」「合唱」「间奏」「感恩地」「温柔有感情的」（以「地 / 的」收尾的状语）。 */
const CN_EXPRESSION_RE = /^[(（]?(?:齐唱|齊唱|合唱|独唱|獨唱|领唱|領唱|轮唱|輪唱|副歌|间奏|間奏|前奏|尾声|尾聲|[\u3400-\u9fff]{1,6}[地的])[)）]?$/;
/** 页眉带的上下界往上找空白行，最多退这么多格。 */
const HEADER_RETREAT = 3;
/** 页眉带下沿的「空白行」：一行墨不过这么多点（扫描件的零星噪点）。 */
const HEADER_BLANK = 2;
/** 页边竖条：页眉那一段里平均每列有墨的行占这么多以上（实心黑边、扫描的网点灰带；页眉字行稀，一列不过几个百分点）。 */
const HEADER_BORDER = 0.1;
/** 竖条只在页边找：左右各这么宽（页宽的比例）。 */
const HEADER_MARGIN = 0.12;

/** 条的内容指纹（与 `stafflabel.ts::labelKey` 同一套：尺寸 + FNV-1a）。声部名带另用前缀（挑行口径不同，同一块像素不能共用一条缓存）。 */
export function wordKey(s: WordStrip): string {
  return contentKey(s.name ? "N" : s.frame ? "F" : "W", s.w, s.h, s.data);
}

/** 声部名里有的字：拉丁字母或汉字 */
const NAME_CHAR_RE = /[A-Za-z\u3400-\u9fff]/;

/** 这条带该存的行：文字指示带按 `keepWordLine`；声部名带中文名也留（「女低」「男低」，带在谱行左边，压不进歌词） */
export function keepStripLine(strip: { name?: boolean; frame?: boolean }, text: string): boolean {
  return strip.name ? NAME_CHAR_RE.test(text) : strip.frame ? /[A-Za-z0-9]/.test(text) : keepWordLine(text);
}

/** 值得存进缓存的行：有拉丁字母（力度只有一个字母），或者像节拍器记号（`= 86`）。纯中文行（歌词、署名）、纯数字不存。 */
export function keepWordLine(text: string): boolean {
  return /[A-Za-z]/.test(text) || METRO_RE.test(text);
}

/**
 * rec 不出空格：按字行的**列投影**补——行盒里连着这么宽（行高的 `WORD_GAP` 倍）没有墨的一段就是词界，
 * 空格插在这段空白右边的头一个字之前。逐字位置（`recognizeRegion` 回来的 `cx`，各字的左缘）只有六分之一行高的精度，
 * 拿相邻两字的边界间隙判词界分不开（词内 0~0.34、词间 0.33~0.5），所以只用它定「哪个字在空白右边」。
 */
export function spaceWordText(
  text: string,
  chars: { text: string; cx: number }[] | undefined,
  strip: { w: number; h: number; data: ArrayLike<number> },
  box: { x: number; y: number; w: number; h: number },
): string {
  if (!chars?.length) return text;
  const y0 = Math.max(0, Math.round(box.y));
  const y1 = Math.min(strip.h, Math.round(box.y + box.h));
  const x0 = Math.max(0, Math.round(box.x));
  const x1 = Math.min(strip.w, Math.round(box.x + box.w));
  const gaps: number[] = [];
  let run = 0;
  let seenInk = false;
  for (let x = x0; x < x1; x++) {
    let ink = false;
    for (let y = y0; y < y1 && !ink; y++) ink = strip.data[y * strip.w + x] === 1;
    if (ink) {
      if (seenInk && run >= box.h * WORD_GAP) gaps.push(x - run / 2);
      run = 0;
      seenInk = true;
    } else run++;
  }
  let out = "";
  let g = 0;
  chars.forEach((c, i) => {
    let space = false;
    while (g < gaps.length && gaps[g] < c.cx + box.h * 0.1) {
      space = i > 0;
      g++;
    }
    out += (space ? " " : "") + c.text;
  });
  return out;
}
const WORD_GAP = 0.17;

/**
 * 页眉带的一行补词间空格：与简谱页眉同一份（`omrkit/textspace.ts::recoverSpacesByInk`，按本行空白宽度的跳变定门、
 * 只在字母与字母、字母与数字之间插）——`spaceWordText` 的固定门槛会把字距拉开的年份拆成「1 7 7 6」、把粗体标题粘成
 * 「CountYourBlessings」。在线识别（`ocrlive.ts::ocrHeaderStrips`）与离线缓存（`gen-rasterheader.mjs`）都调这一份。
 */
export function spaceHeaderText(text: string, chars: { text: string; cx: number }[] | undefined, strip: Binary, box: Rect): string {
  return recoverSpacesByInk(strip, text, box, chars, true);
}

/** 力度（另有一路按字形认，`dynamics.ts`；它漏掉的由这里读出来的补）。字行以力度字母起头、后面跟着别的（歌词的头一个字）也算。 */
const DYNAMIC_RE = /^(ppp|pp|p|mp|mf|fff|ff|f|sfz|sf|fz|fp)(?![a-z])/;
/** 文字指示的术语：歌词行里夹着的字行，含这些词的才留。 */
const DIRECTION_RE = /\b(rit|rall|riten|accel|tempo|cresc|decresc|dim|poco|molto|dolce|legato|unis|unison|solo|tutti|div|sim|sub|piu|meno|mosso|espress|cantabile|sost|marc|stacc|fine|coda|segno|slower|faster|broadly|d\. ?[sc])\b/i;
/** 同一高度上有这么多段拉丁文就是一行歌词（歌词带里的门槛低一档）。 */
const LYRIC_ROW = 3;
const LYRIC_ROW_IN_ZONE = 2;
/** 和弦页的门槛：一页里至少这么多行整行是和弦记号、其中至少一行带后缀（`m7`、`/F`…），才把和弦记号从文字里分出去。 */
const CHORD_PAGE_MIN = 3;
/** 和弦记号的字高下限（格，OCR 框高）：是爱的和弦框高 1.4 格以上。 */
const CHORD_MIN_H = 1.1;
/** 两个字母以内也算文字指示的那几样（声部缩写、管风琴键盘名）。 */
const SHORT_RE = /^(S|A|T|B|SA|TB|ST|AB|Ch|Sw|Gt)\.?$/;
/** 短标记的字高下限（格）。 */
const SHORT_MIN_H = 1.3;
/** 短标记离音头中心横向这么多格以内、纵向离头一根干长（`SHORT_STEM_DY` 格）以内，算压在干上 */
const SHORT_STEM_DX = 1;
const SHORT_STEM_DY = 3.5;
/** 上下两行字叠成一条指示：左端对齐（格）、行距不过行高的这么多倍。 */
const STACK_X = 1.5;
const STACK_GAP = 0.6;
/** 节拍器记号：`♩= 86`、`= ca. 76`（音符那个字形 OCR 读不出，只认等号后的数；`ca.` / `c.` 照谱面写成 `c. 76`）。 */
const METRO_RE = /=\s*(c(?:a|irca)?\.?\s*)?(\d ?\d ?\d?)(?!\d)/;
/** 速度语与节拍器分成两行时，两行之间的横向空当上限（格），同矢量路 `TEMPO_JOIN_GAP`。 */
const TEMPO_JOIN_GAP = 3;
/** 整行只有力度字母（不与节拍器并）。 */
const DYNAMIC_ONLY_RE = /^(ppp|pp|p|mp|mf|fff|ff|f|sfz|sf|fz|fp)$/;
/** 一行字离它那行谱的距离上限（格）。 */
const REACH = 7;
/** 系统之间的字：离下一系统首行不超过离上一系统末行的这么多倍就归下一系统。 */
const INTER_SYS_BIAS = 1.6;

/** 带内一点有没有墨（越界算白）。 */
function inkAt(strip: WordStrip, x: number, y: number): boolean {
  const lx = Math.round(x - strip.box.x);
  const ly = Math.round(y - strip.box.y);
  return lx >= 0 && ly >= 0 && lx < strip.w && ly < strip.h && strip.data[ly * strip.w + lx] === 1;
}

/** 方框四边离字最远这么多格；边线要占字那一边长度的这么多。 */
const FRAME_REACH = 1.2;
const FRAME_COVER = 0.9;

/**
 * 字外面围着一个方框（排练号）：上下左右各往外找一条边线——竖边在字的整个高度上都有墨、横边在字的整个宽度上都有墨。
 * OCR 的框有时把方框也框进来了（宁静 p8 `B` 高两格半），所以从框里往外一点（框宽高的两成）起找。
 */
function framed(strip: WordStrip, b: Rect, sp: number): boolean {
  const reach = sp * FRAME_REACH;
  const colFull = (x: number) => {
    let n = 0;
    for (let y = b.y; y < b.y + b.h; y++) if (inkAt(strip, x, y)) n++;
    return n >= b.h * FRAME_COVER;
  };
  const rowFull = (y: number) => {
    let n = 0;
    for (let x = b.x; x < b.x + b.w; x++) if (inkAt(strip, x, y)) n++;
    return n >= b.w * FRAME_COVER;
  };
  const scan = (from: number, to: number, hit: (v: number) => boolean) => {
    const step = from <= to ? 1 : -1;
    for (let v = from; step > 0 ? v <= to : v >= to; v += step) if (hit(v)) return true;
    return false;
  };
  return (
    scan(Math.round(b.x + b.w * 0.2), Math.round(b.x - reach), colFull) &&
    scan(Math.round(b.x + b.w * 0.8), Math.round(b.x + b.w + reach), colFull) &&
    scan(Math.round(b.y + b.h * 0.2), Math.round(b.y - reach), rowFull) &&
    scan(Math.round(b.y + b.h * 0.8), Math.round(b.y + b.h + reach), rowFull)
  );
}

/** 歌词连字短横：字右边这么多格以内（`Glo` 到头一道短横三格半），扁度、长度、离字的空当。 */
const DASH_REACH = 5;
const DASH_MIN_W = 0.4;
const DASH_MAX_W = 1.5;
const DASH_MAX_H = 0.3;

/**
 * 字右边同一高度（字身中段）上有一截**孤立的短横**：英文歌词拖着的连字符（`Glo - - -`）。
 * 从字右缘往右逐列走，跳过空白，碰到的头一块墨要扁（高不过 `DASH_MAX_H` 格、长 `DASH_MIN_W`~`DASH_MAX_W` 格）、
 * 上下没有别的墨（字身整高里只有这一道横）。
 */
function lyricDashAfter(strip: WordStrip, b: Rect, sp: number): boolean {
  const y0 = Math.round(b.y);
  const y1 = Math.round(b.y + b.h);
  const colInk = (x: number) => {
    let top = -1;
    let bot = -1;
    for (let y = y0; y < y1; y++)
      if (inkAt(strip, x, y)) {
        if (top < 0) top = y;
        bot = y;
      }
    return top < 0 ? null : { top, bot };
  };
  let x = Math.round(b.x + b.w);
  // 字自己的墨（框右缘可能切在最后一个字母里）
  while (x < b.x + b.w + sp * 0.5 && colInk(x)) x++;
  const end = b.x + b.w + sp * DASH_REACH;
  while (x < end && !colInk(x)) x++;
  if (x >= end) return false;
  const x0 = x;
  let top = Infinity;
  let bot = -Infinity;
  for (let c = colInk(x); c && x < end + sp * DASH_MAX_W; c = colInk(++x)) {
    top = Math.min(top, c.top);
    bot = Math.max(bot, c.bot);
  }
  const w = x - x0;
  const h = bot - top + 1;
  const mid = (top + bot) / 2;
  return w >= sp * DASH_MIN_W && w <= sp * DASH_MAX_W && h <= sp * DASH_MAX_H && mid > b.y + b.h * 0.3 && mid < b.y + b.h * 0.85;
}

export interface PlacedWord {
  text: string;
  above: boolean;
  box: Rect;
  note: StaffNote;
}

/** 页脚注的字样：脚注号 `*` 打头、「page 43」、版权、`Words:` / `Tune;`（OCR 常把冒号读成分号）、生卒年 */
const FOOTNOTE_RE = /^\s*[*＊]|\bpage\s*\d|copyright|©|\b(?:words|tune|music)\s*[:;]|\d{4}\s*[-–—]\s*\d{4}/i;

/**
 * 把缓存里的字行归位：定谱行（离哪行近）、定音符（字行左端右边最近的那个音）、落到 `StaffNote.words` / `metronome` 上。
 * 读出来的力度不在这里挂，交回去（`dynamics`）由调用方按力度那一路的判据补。
 *
 * @param skip 已经另有身份的文字盒（歌词行、和弦字母）：中心落在里面的行不要。
 * @param lyricZones 歌词带（切出来的歌词条，不论认没认下来）：判「这一行是英文歌词」时门槛低一档。
 */
export function attachWordLines(
  pg: SPage,
  notes: StaffNote[],
  strips: WordStrip[],
  ocr: Map<string, WordLine[]>,
  unit: RasterUnit,
  skip: Rect[],
  lyricZones: Rect[],
): { words: PlacedWord[]; dynamics: { px: number; py: number; text: string; srcBox?: { left: number; right: number; top: number; bottom: number } }[]; chords: { text: string; box: Rect }[] } {
  const sp = unit.space;
  const words: PlacedWord[] = [];
  const dynamics: { px: number; py: number; text: string; srcBox?: { left: number; right: number; top: number; bottom: number } }[] = [];
  const inside = (q: Rect, x: number, y: number) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h;
  // 先收齐各行（页面坐标），同一处被上下两条带各读一遍的只留一份
  const lines: { text: string; box: Rect; strip: WordStrip }[] = [];
  // 框字带排在前面：框里单独读的字比整条带里读的干净（不带边线读成的 `[`），同一处只留一份
  for (const strip of [...strips].sort((a, b) => +!!b.frame - +!!a.frame))
    for (const l of ocr.get(wordKey(strip)) ?? []) {
      const box = { x: strip.box.x + l.x, y: strip.box.y + l.y, w: l.w, h: l.h };
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      if (lines.some((q) => inside(q.box, cx, cy))) continue;
      lines.push({ text: l.t.replace(/\s+/g, " ").trim(), box, strip });
    }
  lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  // 速度语与节拍器常被 DBNet 切成两行（宁静 `Allegretto semplicemente` / `= 104`、破碎 `Andante con moto` / `( = 82)`）：
  // 并回一行再往下走——各挂各的，文字与节拍器就成了两个对象，还落到不同的音上（与矢量路 `attachDirectionTexts` 同一口径）
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i];
    if (!METRO_RE.test(m.text)) continue;
    const j = lines.findIndex((l, k) => {
      if (k === i || METRO_RE.test(l.text) || !/[A-Za-z]{2}/.test(l.text) || DYNAMIC_ONLY_RE.test(l.text)) return false;
      const gap = m.box.x - (l.box.x + l.box.w);
      const ov = Math.min(l.box.y + l.box.h, m.box.y + m.box.h) - Math.max(l.box.y, m.box.y);
      return gap >= -sp * 0.5 && gap <= sp * TEMPO_JOIN_GAP && ov >= Math.min(l.box.h, m.box.h) * 0.5;
    });
    if (j < 0) continue;
    const l = lines[j];
    const x0 = Math.min(l.box.x, m.box.x);
    const y0 = Math.min(l.box.y, m.box.y);
    l.text = `${l.text} ${m.text}`;
    l.box = { x: x0, y: y0, w: Math.max(l.box.x + l.box.w, m.box.x + m.box.w) - x0, h: Math.max(l.box.y + l.box.h, m.box.y + m.box.h) - y0 };
    lines.splice(i, 1);
    i = -1;
  }
  // 叠着的两行并成一条（`1st time SA Unison` / `2nd time Parts`）
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    const j = lines.findIndex((b, k) => k > i && Math.abs(b.box.x - a.box.x) <= sp * STACK_X && b.box.y - (a.box.y + a.box.h) <= a.box.h * STACK_GAP && b.box.y > a.box.y + a.box.h * 0.5);
    if (j < 0) continue;
    const b = lines[j];
    if (DYNAMIC_RE.test(a.text) || DYNAMIC_RE.test(b.text)) continue;
    const r = Math.max(a.box.x + a.box.w, b.box.x + b.box.w);
    a.text += "\n" + b.text;
    a.box = { x: Math.min(a.box.x, b.box.x), y: a.box.y, w: r - Math.min(a.box.x, b.box.x), h: b.box.y + b.box.h - a.box.y };
    lines.splice(j, 1);
    i--;
  }
  // 和弦记号（是爱那种谱表上方印和弦的）：整行去掉空格后正好是一个或几个和弦记号。一页里够多才认，
  // 不然单个大写字母（排练号 `A`、`B`，或者把谱号读成的字母）都成了和弦
  const chordOf = (text: string): string[] | null => {
    const toks = text.split(/\s+/).filter(Boolean);
    const whole = text.replace(/\s+/g, "");
    const full = isWholeChord;
    if (full(whole)) return [whole];
    return toks.length > 1 && toks.every(full) ? toks : null;
  };
  // 方框里的字母是排练号；比和弦字小一截的（小节号、符头读成的 `A4`）也不算——宁静 p7 排练号 `B` 与两个碎字凑够三行，整页成了和弦页
  const chordLike = (l: (typeof lines)[number]) => l.box.h >= sp * CHORD_MIN_H && !l.strip.frame && !(/^[A-Z]$/.test(l.text) && framed(l.strip, l.box, sp));
  const chordLines = lines.filter((l) => chordOf(l.text) && chordLike(l));
  const chordPage = chordLines.length >= CHORD_PAGE_MIN && chordLines.some((l) => l.text.replace(/\s+/g, "").length > 1);
  const chords: { text: string; box: Rect }[] = [];
  for (const l of lines) {
    const box = l.box;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let text = l.text;
    // 力度：起头那一两个字母。歌词行行首的力度会与头一个字读成一行（`mf夫`），所以先于「歌词行不要」判，位置取行首
    const dyn = DYNAMIC_RE.exec(text);
    const rest = dyn ? text.slice(dyn[0].length).trimStart() : "";
    if (dyn && (!rest || /^[\u4e00-\u9fff]/.test(rest))) {
      const w = Math.min(box.w, box.h * 0.6 * dyn[0].length);
      // `srcBox`：字行起头那几个字母的大致范围，只给识别对照画框（不当墨迹框用：挂音、写出照旧按没量到框走）
      dynamics.push({ px: box.x + w / 2, py: cy, text: dyn[0], srcBox: { left: box.x, right: box.x + w, top: box.y, bottom: box.y + box.h } });
      continue;
    }
    if (skip.some((q) => inside(q, cx, cy))) continue;
    // 页脚注不是文字指示（望十架 p1 末系统下「*Flute part is on page 43」挂成了钢琴上的文字）
    if (FOOTNOTE_RE.test(text)) continue;
    if (chordPage && chordLike(l)) {
      // 和弦后面跟着文字的（`G7 cresc.`）：前头的和弦摘走，剩下的照文字走
      const toks = text.split(/\s+/).filter(Boolean);
      const whole = chordOf(text);
      let n = whole ? toks.length : 0;
      // 带后缀的才算（`A tempo` 的 `A` 不是和弦）
      const isChord = (t: string) => t.length > 1 && isWholeChord(t);
      if (!whole) while (n < toks.length - 1 && isChord(toks[n])) n++;
      if (n > 0) {
        const parts = whole ?? toks.slice(0, n);
        const span = whole ? box.w : box.w * (toks.slice(0, n).join(" ").length / text.length);
        parts.forEach((t, i) => chords.push({ text: t, box: { x: box.x + (span * i) / parts.length, y: box.y, w: span / parts.length, h: box.h } }));
        if (whole) continue;
        text = toks.slice(n).join(" ");
      }
    }
    // 英文歌词：一行歌词被 DBNet 切成好几段，同一高度上排着三段以上；文字指示一行里顶多一两处。
    // 这样的行里只留含术语的（歌词行中间夹着的 `rit.`）。歌词带里的行两段就算
    const peers = lines.filter((o) => Math.abs(o.box.y + o.box.h / 2 - cy) <= box.h * 0.6 && /[A-Za-z]{2}/.test(o.text)).length;
    const crowded = peers >= (lyricZones.some((q) => inside(q, cx, cy)) ? LYRIC_ROW_IN_ZONE : LYRIC_ROW);
    // rec 偶尔给元音添上重音符（`póco`、`dím.`），术语里没有这种写法，一律去掉
    text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    // 框字的方框边读成了括号、竖线（`[Interelude`）
    text = text.replace(/^[[|【]+\s*/, "").replace(/\s*[\]|】]+$/, "");
    // 词后单独一个小写 l 是读错的 1（破碎扫描版「Soprano l」）；大写 I 是罗马数字，不动
    text = text.replace(/([A-Za-z]{3,}) l$/, "$1 1");
    const term = DIRECTION_RE.exec(text);
    if (crowded && !term) continue;
    // 歌词与紧跟着的术语被框成一行（`paid so willingly poco rit.`）：从头一个术语起才是文字指示
    if (crowded && term) text = text.slice(term.index);
    // 头尾粘着的力度字母（`ff unis.`、`unis. mp`）不算在文字里
    text = text.replace(/^(?:[pmf]{1,3}|s?fz?)\s+(?=\S)/, "").replace(/\s+(?:[pmf]{1,3}|s?fz?)$/, "");
    const metro = METRO_RE.exec(text);
    // 节拍器印在圆括号里（`Andante (J = 86)`、`( = 82)`）：等号前紧挨着左括号（中间顶多一个音符字形读成的字），或数后紧跟右括号
    const paren = !!metro && (/[(（]\s*[♩♪JjdhqP」]?\.?\s*$/.test(text.slice(0, metro.index)) || /^\s*[)）]/.test(text.slice(metro.index + metro[0].length)));
    // 等号前面是音符字形读成的字（`(J = 86)`、`(d =92)`）与左括号，不算在速度语里
    if (metro) text = text.slice(0, metro.index).replace(/(?:^|[\s(（])[♩♪JjdhqP」]?\.?\s*$/, "").replace(/[\s(（]+$/, "").trim();
    const letters = (text.match(/[A-Za-z]/g) ?? []).length;
    // 方框里的一个大写字母是排练号（宁静 `[A]` `[B]`）：字只有一格来高，不受下面短标记那两道闸
    const rehearsal = /^[A-Z]$/.test(text) && (!!l.strip.frame || framed(l.strip, box, sp));
    // 整行都是拆开的单个字母（`e E R`）：汉字歌词、符头读成的碎字
    if (!rehearsal && /^[A-Za-z](?: [A-Za-z])+$/.test(text)) continue;
    // 英文歌词的头一个音节、后面拖着连字短横（宁静 p8 `Glo - - -`），歌词那一路没认下来也不是文字指示
    if (!term && !metro && lyricDashAfter(l.strip, box, sp)) continue;
    // 夹着汉字的是歌词或署名；字母太少的多半是把符头、弧线读成了字
    const isWord = rehearsal || (!/[\u4e00-\u9fff]/.test(text) && (letters >= 3 || SHORT_RE.test(text)) && !/^[pmfsz]+$/i.test(text.replace(/[^A-Za-z]/g, "")));
    if (!isWord && !metro) continue;
    // 只靠 `SHORT_RE` 进来的一两个字母（声部标记、排练号）要够大：排练号、分部标记是大字，一格来高的多是别的东西读成的
    //（宁静 p3 只剩一个字的歌词行「人.」读成 `A.`、谱表左缘的小号码读成 `A`，一页好几个）
    if (isWord && !rehearsal && letters < 3 && box.h < sp * SHORT_MIN_H) continue;
    // 它还不能落在某个音的符干那一列上（头左右 `SHORT_STEM_DX` 格、上下一根干长之内）：带尾的干顶读成 `T`
    //（破碎 p5 m53 女低末一个八分音符，挂到女高歌词下面成了「T」）
    if (isWord && !rehearsal && letters < 3 && notes.some((n) => !n.rest && Math.abs(n.x - cx) < sp * SHORT_STEM_DX && cy > n.sym.box.top - sp * SHORT_STEM_DY && cy < n.sym.box.bottom + sp * SHORT_STEM_DY)) continue;
    // 定谱行：上下最近的那行（按谱表边到字心的距离比）
    let stf: Staff | undefined;
    let bd = sp * REACH;
    let above = true;
    for (const st of pg.staves) {
      if (cx < st.box.left - sp * SIDE || cx > st.box.right + sp * SIDE) continue;
      // 首末线按字心所在 x 取（弯、斜的谱线）
      const t = st.topAt(cx), b = st.bottomAt(cx);
      const d = cy < t ? t - cy : cy > b ? cy - b : 0;
      if (d < bd) {
        bd = d;
        stf = st;
        above = cy < (t + b) / 2;
      }
    }
    if (!stf) continue;
    // 两个系统之间的空当：文字指示、排练号、段落名都印在它管的那个系统**上方**，挂在上一系统末行下方的少（`rit.` 印在谱表下也贴着谱表）。
    // 离下一系统首行不比离上一系统末行远出 `INTER_SYS_BIAS` 倍就归下一系统（宁静 p5「Interelude」框字离上面钢琴左手 4 格、离下面右手 6 格）
    if (cy > stf.bottomAt(cx)) {
      const sys = pg.systems.find((s) => s.staves.includes(stf!));
      const next = sys && pg.systems.filter((s) => s !== sys && s.box.top > stf!.box.bottom).sort((a, b) => a.box.top - b.box.top)[0];
      const low = next?.staves.reduce<Staff | undefined>((a, s) => (!a || s.box.top < a.box.top ? s : a), undefined);
      if (sys && low && sys.staves.every((s) => s.box.bottom <= stf!.box.bottom) && cx >= low.box.left - sp * SIDE && cx <= low.box.right + sp * SIDE) {
        const dLow = low.box.top - cy;
        if (dLow > 0 && dLow <= bd * INTER_SYS_BIAS) (stf = low), (above = true);
      }
    }
    // 定音符：字行左端对着它起作用的那个音——取左端往左让一格之后、右边最近的；没有就取这一行最后一个
    const row = notes.filter((n) => n.staff === stf && !n.chordExtra && !n.grace).sort((a, b) => a.x - b.x);
    const note = row.find((n) => n.x >= box.x - sp) ?? row[row.length - 1];
    if (!note) continue;
    if (metro) {
      const bpm = Number(metro[2].replace(/ /g, ""));
      // 拍子单位只认四分：音符字形 OCR 读成 `J` / `d` 都有（烛光颂曲的四分读成 `d`），字母分不出
      note.metronome = { unit: "quarter", bpm, ...(metro[1] ? { text: `c. ${bpm}` } : {}), ...(paren ? { parentheses: true } : {}) };
      note.tempoBox = { left: box.x, right: box.x + box.w, top: box.y, bottom: box.y + box.h };
    }
    // 速度文字与节拍器同一行的（`Andante ♩=76`）写进同一个 `<direction>`（见 `staffomr/textanalyze.ts::attachDirectionTexts`）
    if (metro && isWord && text) {
      note.tempoText = text;
      note.tempoSize = pg.inkTextSize?.(box, text) || box.h;
      words.push({ text, above, box, note });
    } else if (isWord && text) {
      // 行底当基线（文字指示多是不带下伸笔的西文，墨迹底就在基线上）：写源谱版面时照原位放
      (note.words ??= []).push({ text, above, size: pg.inkTextSize?.(box, text) || box.h, baseY: box.y + box.h, box: { left: box.x, right: box.x + box.w, top: box.y, bottom: box.y + box.h } });
      words.push({ text, above, box, note });
    }
  }
  return { words, dynamics, chords };
}
