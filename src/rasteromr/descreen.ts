// **半调网点**（dither）印刷页的去网与实化。
//
// 这类底本（心领《坚固保障》那种简谱本式的独唱谱）整页是 1-bit 抖动印刷：
// 符头不是实心块，而是打散的网点；右半页还压着一层点阵阴影底纹。
// 照直送进识别，`findRasterHeads` 的填充率那一档全不过——实测整页 83 个音符只认出 20 个。
//
// **不是每张图都要做**：干净位图（排版软件贴进去的）与普通扫描件的笔画本来就是实心的，
// 做一遍只会把细节磨掉。所以先量 `halftoneRatio` 再决定，判据见 `HALFTONE_RATIO`。
// 去网本身走标准形态学（`morph.ts`），参数从本页统计，见 `descreenMorph`。
import type { Binary } from "../omrkit/types";
import { areaClose, areaOpen, close, Integral } from "./morph";
import { components } from "../omrkit/ccl";
import { quantile } from "../omrkit/geom";

/**
 * 墨点里「孤立点」的占比：3×3 窗口内墨不过 3 个（含自己）算孤立。
 *
 * **只量谱表带之内**（`rows` 给出要量的行）。整页量会被空白页毁掉：
 * 实测封面那种几乎没墨的页面，几十个尘点个个孤立，量出来是 1.000；
 * 而谱表带里有谱线、符干这些必然成片的墨，空页与真网点页就分得开了。
 */
export function halftoneRatio(bin: Binary, rows?: (y: number) => boolean): number {
  const it = new Integral(bin);
  const { w, h, data } = bin;
  let ink = 0;
  let lone = 0;
  for (let y = 0; y < h; y++) {
    if (rows && !rows(y)) continue;
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      ink++;
      if (it.box(x, y, 3, 3) <= 3) lone++;
    }
  }
  return ink ? lone / ink : 0;
}

/**
 * 墨里的**针孔**占比：八邻域里至少六个是墨的白点，与墨点数之比（只量谱表带内）。
 *
 * 网纹填充（齐来称颂伟大之神那本：符头、谱号内部是斜交叉的细网纹）量不出孤立点
 * ——网纹里每个墨点斜对角都挨着墨，`halftoneRatio` 只有 0.069；可符头里满是
 * 被墨围住的白点，照直送识别，填充率那一档全不过（实测 151 个音只认出 17 个）。
 */
export function pinholeRatio(bin: Binary, rows?: (y: number) => boolean): number {
  const { w, h, data } = bin;
  let ink = 0;
  let holes = 0;
  for (let y = 1; y < h - 1; y++) {
    if (rows && !rows(y)) continue;
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (data[i]) {
        ink++;
        continue;
      }
      const n =
        data[i - w - 1] + data[i - w] + data[i - w + 1] + data[i - 1] + data[i + 1] + data[i + w - 1] + data[i + w] + data[i + w + 1];
      if (n >= 6) holes++;
    }
  }
  return ink ? holes / ink : 0;
}

/**
 * **补针孔**（就地改 `bin`）：八邻域里至少六个是墨、**或上下左右四邻全是墨**的白点补成墨，补两遍。
 *
 * 四邻那一条是给**棋盘格抖动**的网纹（父恩广大、晨曦破晓那本：符头里一像素一格黑白相间）：
 * 那里的白点上下左右都是墨、四个斜角却是白的，八邻域只凑得到四五个，六个那道闸补不上。
 *
 * 网纹填充的页面不能走 `descreen`：那边的密度窗口按线距取（线距 17.5px 时 11px 见方），
 * 汉字笔画、升号糊成一团，空心符头也被填实（实测齐来称颂 151 个音认出 154 个、
 * 对上的只有 14.6%）。网纹的空隙只有一两个像素，逐点补就够，别的笔画分毫不动。
 */
export function fillPinholes(bin: Binary): void {
  const { w, h, data } = bin;
  for (let pass = 0; pass < 2; pass++) {
    const add: number[] = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (data[i]) continue;
        const n4 = data[i - w] + data[i - 1] + data[i + 1] + data[i + w];
        const n = n4 + data[i - w - 1] + data[i - w + 1] + data[i + w - 1] + data[i + w + 1];
        if (n >= 6 || n4 === 4) add.push(i);
      }
    }
    if (!add.length) break;
    for (const i of add) data[i] = 1;
  }
}

/**
 * **判网纹填充的门槛**。谱表带内实测，要补的三份：齐来称颂 0.066、赞美三一真神 0.035、
 * 颂赞与尊贵 0.017（后两份网纹淡，取 0.04 时整页认不出东西）；不该补的：合唱谱全书全页
 * 最大 0.0076，其余图片语料 0.001 以下（坚固保障 0.0096 走的是去网那一档）。取 0.012。
 */
export const PINHOLE_RATIO = 0.012;

/**
 * **判半调网点的门槛**。谱表带内实测：心领那本（抖动印刷）0.359；
 * 合唱谱那批（干净位图 + 真扫描件）全书全页最大 0.157（你要等候 p3），
 * 其余多在 0.1 以下。两档之间是空的，取 0.25——离两边都有余量，
 * 且**合唱谱那批没有一页会触发**，旧基线按构造不动。
 */
export const HALFTONE_RATIO = 0.25;

/** 量网点率时谱表上下各带出这么多个线距（歌词/和弦字母不进来，符干与弧线进得来）。 */
export const HALFTONE_BAND = 2;

/** 分块统计孤点的块边长（像素）。 */
export const SPECK_TILE = 64;

/**
 * **孤立的单像素墨点**（八邻域全白）按 `SPECK_TILE` 见方分块计数。浅灰网点水印二值化后成片出这种点，
 * 可水印常常只占页面一角：按全页总数判，局部密、总数不多的漏掉，满页零星噪点的又会误伤——
 * 所以按块看**密度**（《求主同住》页中央一片，一块里上百个；合唱谱扫描件一块最多十几个）。
 */
export function speckTiles(bin: Binary): { cols: number; rows: number; count: Uint16Array } {
  const { w, h, data } = bin;
  const cols = Math.ceil(w / SPECK_TILE);
  const rows = Math.ceil(h / SPECK_TILE);
  const count = new Uint16Array(cols * rows);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++)
      if (data[y * w + x] && isolated(data, w, x, y)) count[((y / SPECK_TILE) | 0) * cols + ((x / SPECK_TILE) | 0)]++;
  return { cols, rows, count };
}

/** 只在孤点密度过 `min`（每块个数）的块里、连同它四邻的块，抹掉孤立的单像素墨点。附点、跳音点都有好几个像素宽，碰不到。 */
export function dropSpecks(bin: Binary, min: number): number {
  const { w, h, data } = bin;
  const t = speckTiles(bin);
  const hot = new Uint8Array(t.cols * t.rows);
  let n = 0;
  for (let r = 0; r < t.rows; r++)
    for (let c = 0; c < t.cols; c++) {
      if (t.count[r * t.cols + c] < min) continue;
      n++;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && cc >= 0 && rr < t.rows && cc < t.cols) hot[rr * t.cols + cc] = 1;
        }
    }
  if (!n) return 0;
  const kill: number[] = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++)
      if (hot[((y / SPECK_TILE) | 0) * t.cols + ((x / SPECK_TILE) | 0)] && data[y * w + x] && isolated(data, w, x, y)) kill.push(y * w + x);
  for (const i of kill) data[i] = 0;
  return n;
}

function isolated(data: Uint8Array, w: number, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && data[(y + dy) * w + x + dx]) return false;
  return true;
}

/** 统计「点」的尺寸时只看这么小的块（像素）：再大是符号本身。 */
const DOT_SCAN = 60;
/** 底纹点：面积小于墨块尺寸（`DOT_PCT` 分位）这么多倍的抹掉。 */
const SPECK_K = 3;
/** 网点白隙：面积小于白隙尺寸这么多倍的被围白块填上；空心头内腔比它大一个量级（坚固保障白隙 1 像素，内腔 25 像素起）。 */
const GAP_K = 8;
const DOT_PCT = 0.9;

/**
 * **按形态学去网**，就地改 `bin`，参数全从本页谱表带里统计：
 *   1. 面积开运算：抹掉小于底纹点尺寸 `SPECK_K` 倍的墨块（阴影底纹是孤立小点；网点符头的墨点八连通成片，不受影响）；
 *   2. 面积闭运算：填上小于白隙尺寸 `GAP_K` 倍的被围白块（网点符头、符杠里的白隙）——空心头的内腔大得多，留下；
 *   3. 闭运算：结构元半径按白隙边长取，补上碰着外面、面积闭运算够不着的白隙（网点谱线、头的毛边）。
 */
export function descreenMorph(bin: Binary, inBand: (y: number) => boolean = () => true): void {
  const inkDots = components(bin, 1, 8, (n) => n <= DOT_SCAN).filter((b) => inBand((b.y0 + b.y1) / 2)).map((b) => b.px.length);
  areaOpen(bin, Math.max(2, quantile(inkDots, DOT_PCT) * SPECK_K));
  const gaps = components(bin, 0, 4, (n) => n <= DOT_SCAN).filter((b) => !b.edge && inBand((b.y0 + b.y1) / 2)).map((b) => b.px.length);
  const gap = Math.max(1, quantile(gaps, DOT_PCT));
  areaClose(bin, gap * GAP_K);
  close(bin, Math.max(1, Math.round(Math.sqrt(gap))));
}
