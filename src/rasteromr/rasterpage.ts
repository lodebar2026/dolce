// 位图五线谱识别的**取图层**：PDF 页 → `Binary`（1 = 墨）。
//
// ## 为什么不用 `src/omrkit/decode.ts`
//
// 那条路是给简谱的光栅路写的，两点不合用：
//   1. 它靠 `OffscreenCanvas`，**浏览器专属**；本模块要能进 `src/cli/index.ts`
//      那条纯 Node 链（回归循环全书几秒钟，起浏览器就没这个速度了）。
//   2. 它把整页缩到 `PDF_W = 2000` 宽。合唱谱这批底本原始就是 1917 px 宽、
//      线距 18.2 px——再缩一道线距掉到个位数，符头与谱线就分不开了。
//      位图路**按原始像素识别**，一格都不缩。
//
// ## pdf.js 在 Node 下给的是什么
//
// 这批 PDF 把整页乐谱当一张 1-bit CCITT 的 ImageMask 贴进内容流。
// Node 下 `page.objs.get(id)` 直接返回 `{ data, width, height }`——
// `data` 是**逐行 1-bit 打包**的字节（每行 `ceil(w/8)` 字节，行首字节对齐），
// 不是 `ImageBitmap`。于是解包一遍就完事，**不需要 canvas、不需要 wasm 之外的任何东西**。
//
// **极性**：ImageMask 里置位的是「盖住的地方」= 墨；`Binary` 的约定也是 1 = 墨，
// 正好对上。但 pdf.js 会照 `/Decode` 数组翻转，翻没翻只有量了才知道——
// 所以取完图按「墨迹占比」自检一次：整页乐谱的墨不可能过半（实测约一成），
// 过半就是翻了，整幅取反。
import type { Binary } from "../omrkit/types";
import { estimateUnit, findRasterStaves } from "./stafffind";
import { descreenMorph, dropSpecks, fillPinholes, halftoneRatio, pinholeRatio, HALFTONE_BAND, HALFTONE_RATIO, PINHOLE_RATIO } from "./descreen";
import { lineYAt, type StaffGroup } from "./staffline";
import { median } from "../omrkit/geom";
import { sauvola as sauvolaInto, toGray } from "../omrkit/preprocess";
import { largestPageImageAt } from "../omrkit/pdf";

/** 一页取到的位图，连同它在页面坐标里的位置（识别坐标 ↔ 页面坐标要用）。 */
export interface RasterPage {
  bin: Binary;
  /**
   * 这张图在 PDF 里是什么形态：`mask` = 1-bit ImageMask（排版软件贴进去的干净位图）、
   * `gray1` = 1-bit 灰度（Xerox 那种扫描件）、`rgb` = 彩色/JPEG（手机拍、扫描）。
   *
   * **分档要用它**，别拿「线宽/线距」当代理量：那个比值随谱线判据一动就翻
   * （实测主，差遣我 线距 11.5px、线宽 2.3px，正卡在 0.2 的门槛上，
   * 改一条谱线判据就从扫描档跳进干净档，把干净档的平均从 71% 拖到 55%）。
   */
  kind: "mask" | "gray1" | "rgb";
  /** 量出来的网点率（`halftoneRatio`）。超过 `HALFTONE_RATIO` 的这一页做过去网。 */
  halftone: number;
  /** 细线扫描件：按松阈值补过竖笔（见 `rasterizePage` 里 `mergeVertical` 那段）。 */
  faint: boolean;
  /**
   * 细线扫描件的灰度图（与 `bin` 同尺寸、同一几何），别的页没有。
   * 给识别器回头核「断开的小节线」用（`barvote.ts::bridgeFaintBars`）。
   */
  gray?: Uint8Array;
  /**
   * 彩色页的灰度图（与 `bin` 同尺寸、同一几何），歌词条送 OCR 用这一份（`lyric.ts::stripOf`）。
   * 二值化、去网把细笔画一起吃了：坚固保障（网点 0.36）英文字高 14px，「mighty」只剩几截残笔，原图其实清清楚楚，
   * 送灰度中文 80.7 → 99.2%、拉丁 85.5 → 99.4%。先只给去过网的页，放开到全部彩色页再净涨（独唱谱中文 96.78 → 96.99%）。
   * 与 `gray` 分开放：那一个一有就触发 `bridgeFaintBars`（细线页两个都有时歌词用 `gray`）。
   */
  lyricGray?: Uint8Array;
  /** 位图像素 → PDF 页面点的缩放（页宽 / 位图宽）。 */
  scale: number;
  /** 页面尺寸（PDF 点）。 */
  pageWidth: number;
  pageHeight: number;
  /** 这张图在页面上的位置（PDF 点，左上为原点、y 向下）。写源谱版面时把位图坐标折回页面（`SPage.ptPerUnit` / `originPt`） */
  imageRect: { x: number; y: number; w: number; h: number };
}

/** 墨迹占比超过这个数就判定极性反了。整页乐谱实测约一成，留足余量。 */
const INK_FLIP_RATIO = 0.5;

/**
 * 取这一页最大的那张内嵌位图。多为整页乐谱图；一张都没有（纯矢量页）返回 null
 * ——那种页面该走 `src/staffomr/` 的矢量路，不该到这儿来。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function rasterizePage(page: any, OPS: any): Promise<RasterPage | null> {
  const img = await pageImageOf(page, OPS);
  return img ? rasterizeImage(img) : null;
}

/** 一页最大的那张内嵌位图与页面几何（普通数据，可跨线程传）：`rasterizePage` 拆出的 pdf.js 那一半。 */
export interface PageImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  /** pdf.js 的图像种类（1 = GRAYSCALE_1BPP） */
  kind?: number;
  /** 图在页面上的变换 */
  ctm: number[];
  /** `page.view` */
  view?: number[];
  pageWidth: number;
  pageHeight: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pageImageOf(page: any, OPS: any): Promise<PageImage | null> {
  const found = await largestPageImageAt(page, OPS, (o) => (o.data && o.width && o.height ? o.width * o.height : null));
  if (!found) return null;
  const vp = page.getViewport({ scale: 1 });
  const { width, height, data, kind } = found.obj;
  return { width, height, data, kind, ctm: [...found.ctm], view: page.view ? [...page.view] : undefined, pageWidth: vp.width, pageHeight: vp.height };
}

/** 位图 → 识别用的二值图（解码、二值化、去网、补线……，不做几何变换）：`rasterizePage` 不碰 pdf.js 的那一半。 */
export function rasterizeImage(img: PageImage): RasterPage | null {
  const best = img;

  const w: number = best.width;
  const h: number = best.height;
  const packed = Math.ceil(w / 8) * h;
  const kind: RasterPage["kind"] = best.data.length === packed ? (best.kind === 1 ? "gray1" : "mask") : "rgb";
  let bin = decodeImage(best, w, h);
  if (!bin) return null;
  // **线距太小的彩色底本先放大一倍再二值化**。手机拍/低分辨率扫描的诗歌本（齐来谢主歌、
  // 万古磐石歌整页 1100px 宽，线距 11px、线宽 2px）去谱线之后，调号降号与低音谱号碎成
  // 三五像素的小块，位置自举与模板都认不回来（齐来谢主歌八行谱只认出两个降号、一个低音谱号
  // 被当成全音符）。灰度上双线性放大再走 Sauvola，笔画在阈值那一步就成形了
  //（齐来谢主歌音符 21% → 72%）。只放细线的（`UPSCALE_THIN`）；1-bit 的底本没有灰度可插，不放。
  let up = 1;
  if (kind === "rgb") {
    /** 按阈值档 k 取图（线距小、线又细的先放大一倍，见上） */
    const build = (k: number, first: Binary | null): { bin: Binary; up: number } | null => {
      const b = first ?? decodeImage(best, w, h, k);
      if (!b) return null;
      const u0 = estimateUnit(b);
      if (u0 && u0.space < UPSCALE_SPACE && u0.lineThick / u0.space < UPSCALE_THIN) {
        const big = decodeImage(best, w, h, k, 2);
        if (big) return { bin: big, up: 2 };
      }
      // 原分辨率上线宽量不准：浅灰底上 Sauvola 把淡谱线两侧的灰边也算成墨，两像素的线量成三像素、线宽比过闸
      //（046 赞美不尽歌 3/11）。放大一倍再量一次线宽（线距按原图的两倍），闸用更严的 `UPSCALE_RECHECK`
      if (u0 && u0.space < UPSCALE_SPACE) {
        const big = decodeImage(best, w, h, k, 2);
        if (big) {
          const t2 = estimateUnit(big)?.lineThick ?? Infinity;
          if (t2 / (u0.space * 2) < UPSCALE_RECHECK) return { bin: big, up: 2 };
        }
      }
      return { bin: b, up: 1 };
    };
    let got = build(SAUVOLA_K, bin);
    // **一行谱都找不出来的彩色底本，换松一档阈值重来**：谱线印得淡的页（新编赞美诗 123 我爱教会歌，
    // 谱线那几行平均灰度 140，别的页 100）`SAUVOLA_K` 那一档把谱线抹成断续的几截，凑不成一行谱。
    // 看的是**放大之后**成不成行——没放大时量得出线距、放大再二值反倒抹掉的也算。
    // 逐档放松（`SAUVOLA_K_RETRY`），到找得出谱行为止；都找不出的照旧（封面、歌词页）。
    // **只在一行都找不出时才换**。「松一档能多找出谱行就换」试过：松阈值下歌词带、淡底纹里会多出假谱行，
    // 一大批本来好好的页被换成糊的那一档（全量 127 首下降，荣归天父歌 97.6 → 17.4），已撤。
    if (got && !staffCount(got.bin))
      for (const k2 of SAUVOLA_K_RETRY) {
        const g2 = build(k2, null);
        if (g2 && staffCount(g2.bin)) {
          got = g2;
          break;
        }
      }
    if (got) (bin = got.bin), (up = got.up);
  }
  // **细线扫描件补竖向断口**：高分辨率彩色扫描（320dpi 的敬拜万世之王）小节线、符干只有
  // 一两像素、灰度 150~210，`SAUVOLA_K` 那一档阈值约 144，切成虚线——小节线认不出，
  // 简谱行靠「与谱表小节线同 x」也定不了位。放松阈值整页重来试过：谱线跟着变粗，
  // 去谱线去不干净，谱号、调号碎成一地（音符 91% → 73%）；补几像素的断口也不够（断口十几像素）。
  // 所以按松阈值再二值一遍，**只取其中纵向长游程**（小节线、符干）并回原图。
  // 只看彩色档：其余底本线宽/线距实测都在 0.067 以上（见 `FAINT_RATIO`）。
  let faint = false;
  let gray: Uint8Array | undefined;
  /** 松阈值那一档（`SAUVOLA_K_FAINT`）的二值图：补竖笔与下面补淡谱线同一张，只解一次 */
  let soft: Binary | null = null;
  if (kind === "rgb") {
    const u = estimateUnit(bin);
    soft = u && u.lineThick / u.space < FAINT_RATIO ? decodeImage(best, w, h, SAUVOLA_K_FAINT, up) : null;
    if (soft && u) mergeVertical(bin, soft, Math.round(u.space * VERT_RUN)), (faint = true), (gray = grayOf(best, w, h, up) ?? undefined);
  }

  // **极性自检**：ImageMask 里置位的是墨，`kind: 1`（GRAYSCALE_1BPP）里置位的是白，
  // 而 `/Decode` 还能把两者都翻过来——翻没翻只有量了才知道。
  // 整页乐谱的墨不可能过半（实测约一成），过半就是反的，整幅取反。
  let ink = 0;
  for (let i = 0; i < bin.data.length; i++) ink += bin.data[i];
  if (ink > bin.w * bin.h * INK_FLIP_RATIO) for (let i = 0; i < bin.data.length; i++) bin.data[i] ^= 1;

  // **半调网点的底本先去网**（`descreen.ts`）。整页抖动印刷的谱（心领那本）符头是
  // 打散的网点，填充率那一档全过不去——实测整页 83 个音符只认出 20 个。
  // **只对量出来是网点页的做**：干净位图与普通扫描件的笔画本来就是实心的，
  // 做一遍只是把细节磨掉（门槛与两档的实测值见 `HALFTONE_RATIO`）。
  // 一行谱都没找到的页面（封面、歌词页）不做：没有尺子定窗口，也没有东西要认。
  let halftone = cleanTexture(bin, true);
  const lyricGray = kind === "rgb" && !gray ? grayOf(best, w, h, up) ?? undefined : undefined;

  // **不做几何变换**：不推平、不纠斜，原图像素原样交给识别；弯、斜的谱线由下游按曲线谱线处理（`staffline.ts`）。
  // 整像素的推平与错切会给横笔造台阶、在行间重复或跳过行，细加线、附点、窄内腔跟着变形，交出的坐标也对不回原页面。
  // 淡谱线补回用的松阈值副本
  const lineSoft = kind === "rgb" ? soft ?? decodeImage(best, w, h, SAUVOLA_K_FAINT, up) : null;
  // **淡谱线补回**：个别谱行的线印得浅（新编赞美诗 297 头两个系统的低音谱表，线的灰度 130~175，别的行 100 上下），
  // `SAUVOLA_K` 那一档把它切成断续的几截，行投影与逐列游程都凑不成行，十行谱只找出八行。整页换松阈值会把别的笔画也弄糊
  //（见上），所以同补竖笔一样只取一部分：松阈值图里**细而长的横向游程**（纵向厚不过两倍线宽、横向三格以上）——谱线、加线——
  // 只补原图上的断口。按识别那一路（`stafffind.ts::findRasterStaves`）数谱行，**多出来了才留**，否则整幅不动。
  if (lineSoft) {
    const u = estimateUnit(bin);
    if (u) {
      const trial = { ...bin, data: new Uint8Array(bin.data) };
      mergeHorizontal(trial, lineSoft, Math.round(u.space * LINE_RUN), Math.max(2, Math.round(u.lineThick * 2)), Math.max(1, Math.round(u.lineThick)));
      if (staffCount(trial) > staffCount(bin)) bin.data.set(trial.data);
      else mergeFaintStaves(bin, trial);
    }
  }
  // 头一次一行谱都找不到的页（父恩广大那张扫描件谱线微弯，行投影一行都不成），网纹那一步就没做（网纹符头 166 个音只认出 15 个）；
  // 补完淡谱线再试一次——**只补针孔，不去网**。
  // 这一档是低分辨率扫描件（齐来谢主歌线距 11px），谱线细得断成点，孤立点把网点率
  // 虚抬到 0.263、刚过门槛；真去了网，调号降号与拍号糊成一团、汉字笔画粘死
  //（歌词 75% → 45%），而它本来就不是网点印刷。
  if (halftone == null) halftone = cleanTexture(bin, false);

  return { bin, kind, halftone: halftone ?? 0, faint, gray, lyricGray, scale: img.pageWidth / bin.w, pageWidth: img.pageWidth, pageHeight: img.pageHeight, imageRect: imageRectOf(img.ctm, img.view, img.pageWidth, img.pageHeight) };
}

/** 补线之后一行谱沿曲线有墨的列的占比至少涨这么多，才把这一行的谱表带换成补过线的像素（见 `mergeFaintStaves`）。 */
const FAINT_GAIN = 0.15;

/**
 * **只有个别谱行淡**（新编 026 第一行中间三条线大段没了、别的行好好的）：按游程找线时断续的线也凑得成行，
 * 补线前后谱行数一样，上面「多出来了才留」那条留不住；可这一行的线是残的，去线、音高全跟着错（026 音符 99 → 31）。
 * 逐行量补线前后沿曲线有墨的列占比（每两列量一次，五条线合算），涨过 `FAINT_GAIN` 的那几行只换它的谱表带（上下各让一格）。
 * 原先行投影在这种页上第一趟就凑不成行，补完行数变多，整幅都换了，碰巧没事。
 */
function mergeFaintStaves(bin: Binary, trial: Binary): void {
  const found = findRasterStaves(bin);
  if (!found) return;
  const tol = Math.max(1, Math.round(found.unit.lineThick / 2));
  const cover = (img: Binary, g: StaffGroup) => {
    let hit = 0;
    let all = 0;
    for (const l of g.lines)
      for (let x = Math.max(0, l.left); x <= Math.min(img.w - 1, l.right); x += 2) {
        const y0 = Math.round(lineYAt(l, x));
        all++;
        for (let y = y0 - tol; y <= y0 + tol; y++)
          if (y >= 0 && y < img.h && img.data[y * img.w + x]) {
            hit++;
            break;
          }
      }
    return all ? hit / all : 1;
  };
  for (const g of found.groups) {
    const before = cover(bin, g);
    const after = cover(trial, g);
    if (after - before < FAINT_GAIN) continue;
    const left = Math.max(0, Math.round(Math.min(...g.lines.map((l) => l.left)) - g.space));
    const right = Math.min(bin.w - 1, Math.round(Math.max(...g.lines.map((l) => l.right)) + g.space));
    for (let x = left; x <= right; x++) {
      const y0 = Math.max(0, Math.round(lineYAt(g.lines[0], x) - g.space));
      const y1 = Math.min(bin.h - 1, Math.round(lineYAt(g.lines[4], x) + g.space));
      for (let y = y0; y <= y1; y++) bin.data[y * bin.w + x] = trial.data[y * bin.w + x];
    }
  }
}

/** 识别那一路数得出的谱行数（`stafffind.ts::findRasterStaves`）。 */
function staffCount(bin: Binary): number {
  return findRasterStaves(bin)?.groups.length ?? 0;
}

/**
 * 网点/网纹的底本就地清理（`descreen.ts`），返回量出来的网点率；
 * 一行谱都找不到时返回 null（没有尺子定窗口，也没有东西要认）。
 */
/** 64px 见方一块里孤立单像素墨点多过这么多个，这一块（连同四邻）才抹（见 `descreen.ts::dropSpecks`）。
 *  实测最密一块：求主同住 250、坚固保障 68、向主唱新歌与颂赞与尊贵 54，其余独唱谱 ≤4，合唱谱 ≤8。
 *  取 40：向主唱新歌中文歌词 +3.0、坚固保障 +1.6（英文 −0.5），别的不动。按全页总数判不行——水印常只占一角。 */
const SPECK_MIN = 40;

function cleanTexture(bin: Binary, allowDescreen: boolean): number | null {
  const groups = findRasterStaves(bin)?.groups ?? [];
  if (!groups.length) return null;
  const space = median(groups.map((g) => g.space));
  if (!(space > 0)) return null;
  // 谱行带取第一线最高处到第五线最低处（弯、斜的谱行沿 x 起伏）
  const bands = groups.map((g) => {
    const xs = [g.lines[0].left, (g.lines[0].left + g.lines[0].right) / 2, g.lines[0].right];
    return [Math.min(...xs.map((x) => lineYAt(g.lines[0], x))) - g.space * HALFTONE_BAND, Math.max(...xs.map((x) => lineYAt(g.lines[4], x))) + g.space * HALFTONE_BAND];
  });
  const inBand = (y: number) => bands.some(([a, b]) => y > a && y < b);
  // **压在谱线上的像素不算**：低分辨率细线扫描件（数算主恩、齐来谢主歌，线距 11~14px）的谱线断成一串点，
  // 全算进来网点率虚抬到 0.263、刚过门槛，整页去网把汉字笔画磨掉（数算主恩歌词 94 → 9）。原先靠行投影在微弯页上
  // 第一趟找不着谱行碰巧躲过；按游程第一趟就找得着，得把线上那几行剔掉。真网点页的符头、笔画里满是网点，不受影响
  const tol = Math.max(1, Math.round(median(groups.map((g) => g.space)) * 0.12));
  const onLine = new Uint8Array(bin.w * bin.h);
  for (const g of groups)
    for (const l of g.lines)
      for (let x = Math.max(0, l.left); x <= Math.min(bin.w - 1, l.right); x++) {
        const y0 = Math.round(lineYAt(l, x));
        for (let y = Math.max(0, y0 - tol); y <= Math.min(bin.h - 1, y0 + tol); y++) onLine[y * bin.w + x] = 1;
      }
  const halftone = halftoneRatio(bin, inBand, (x, y) => onLine[y * bin.w + x] === 1);
  if (halftone > HALFTONE_RATIO && allowDescreen) descreenMorph(bin, inBand);
  // 网纹填充（符头、谱号里是细交叉网纹）不走去网，只补针孔（`fillPinholes`）
  else if (pinholeRatio(bin, inBand) > PINHOLE_RATIO) fillPinholes(bin);
  // **网点水印**：浅灰的底纹二值化后是满页的单像素孤点，把歌词行之间的空当填满，
  // 几行歌词并成一行、和弦行也被卷进歌词带（《求主同住》歌词 0%、和弦 43%）。
  // 按块看密度，只抹密的那几块（像素内容一变，那一页的 OCR 缓存都要重跑）。
  dropSpecks(bin, SPECK_MIN);
  return halftone;
}

/**
 * pdf.js 给的原始像素 → `Binary`。**三种形态都要认**，认错就是一幅噪声，
 * 而且不报错——这正是要防的那种静默失败。
 *
 *   - **ImageMask**（无 `kind`）：逐行 1-bit 打包，置位 = 盖住 = 墨。合唱谱这批就是它。
 *   - **`kind: 1`（GRAYSCALE_1BPP）**：同样是逐行 1-bit 打包，但置位 = 白。
 *     Fuji Xerox 扫出来的那份是它。极性交给调用方的自检翻。
 *   - **`kind: 2` / `3`（RGB_24BPP / RGBA_32BPP）**：每像素 3 / 4 字节，
 *     要先算亮度再 Otsu。手机拍/JPEG 扫的那份是它。
 *
 * 靠**数据长度**认，不靠 `kind`：ImageMask 根本没有 `kind`，
 * 而长度是三者唯一都给得出、且互不相同的量。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeImage(obj: any, w: number, h: number, k = SAUVOLA_K, up = 1): Binary | null {
  const src: Uint8Array | Uint8ClampedArray = obj.data;
  const data = new Uint8Array(w * h);
  const packed = Math.ceil(w / 8) * h;
  if (src.length === packed) {
    // 逐行 1-bit 打包。**行首字节对齐**：行末不足 8 位的那几位是填充，不能顺着读下去。
    const stride = Math.ceil(w / 8);
    for (let y = 0; y < h; y++) {
      const row = y * stride;
      const out = y * w;
      for (let x = 0; x < w; x++) data[out + x] = (src[row + (x >> 3)] >> (7 - (x & 7))) & 1;
    }
    return { w, h, data };
  }
  const gray = grayOf(obj, w, h, up);
  if (!gray) return null;
  if (up > 1) {
    const out = new Uint8Array(w * up * h * up);
    sauvola(gray, w * up, h * up, out, k);
    return { w: w * up, h: h * up, data: out };
  }
  sauvola(gray, w, h, data, k);
  return { w, h, data };
}

/** 彩色/灰度图转灰度（放大 `up` 倍）；1-bit 打包的返回 null。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function grayOf(obj: any, w: number, h: number, up = 1): Uint8Array | null {
  const src: Uint8Array | Uint8ClampedArray = obj.data;
  const step = src.length === w * h * 4 ? 4 : src.length === w * h * 3 ? 3 : src.length === w * h ? 1 : 0;
  if (!step) return null;
  const gray = toGray(src, w, h, step);
  return up > 1 ? upsample(gray, w, h, up) : gray;
}

/** 灰度图双线性放大 `up` 倍（像素中心对齐）。 */
function upsample(gray: Uint8Array, w: number, h: number, up: number): Uint8Array {
  const W = w * up;
  const H = h * up;
  const out = new Uint8Array(W * H);
  for (let Y = 0; Y < H; Y++) {
    const fy = Math.min(h - 1, Math.max(0, (Y + 0.5) / up - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let X = 0; X < W; X++) {
      const fx = Math.min(w - 1, Math.max(0, (X + 0.5) / up - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      const a = gray[y0 * w + x0] * (1 - tx) + gray[y0 * w + x1] * tx;
      const b = gray[y1 * w + x0] * (1 - tx) + gray[y1 * w + x1] * tx;
      out[Y * W + X] = (a * (1 - ty) + b * ty + 0.5) | 0;
    }
  }
  return out;
}

/** Sauvola 局部阈值的窗口半径（占页宽的比例）与参数。
 *  `k` 越大收得越紧（墨越细）。 */
const SAUVOLA_WIN = 1 / 40;
const SAUVOLA_K = 0.5;
/** 标准阈值量不出谱行时依次再试的几档（见 `rasterizePage`）。 */
const SAUVOLA_K_RETRY = [0.35, 0.2, 0.1];
/** 细线扫描件的松阈值：页白 250 时阈值约 208（`SAUVOLA_K` 那档约 144）。 */
const SAUVOLA_K_FAINT = 0.2;
/** 从松阈值图里取回的竖笔，纵向游程至少几格（小节线 4 格、符干 3 格；谱线与字的竖笔短得多）。 */
const VERT_RUN = 1.5;
/** 彩色底本线距（像素）小于这个数就先放大一倍再二值化（见 `rasterizePage`）。 */
const UPSCALE_SPACE = 14;
/**
 * 放大还要**谱线细**（线宽/线距低于这个数）。三本 11px 的诗歌本线宽都是 2px（0.18），
 * 放大才有救；望十架那份合唱扫描件线距 11.5~12px 但多数页线宽 3px（0.26），墨本来就粗，
 * 放大之后谱号、符头反倒糊成一片（扫描档音符 68.3% → 64.2%）。它有两页线宽 2px，
 * 那两页放大是赚的（整份 60.8% → 61.4%）。
 */
const UPSCALE_THIN = 0.22;
/**
 * 原分辨率线宽比过了 `UPSCALE_THIN`、放大一倍再量的那道闸（`rasterizePage`）。真细线放大后 046 赞美不尽歌 3/22 = 0.14；
 * 望十架扫描件的粗线放大后 5/23 = 0.22，按 `UPSCALE_THIN` 刚好过闸，整份被放大（扫描档 83.7 → 71.8，歌词掉得最多）。
 */
const UPSCALE_RECHECK = 0.16;
/** 线宽/线距低于这个数算细线扫描件。实测敬拜万世之王 0.053，其余彩色底本 0.067（坚固保障）以上。 */
const FAINT_RATIO = 0.06;

/** 把 `soft` 里纵向游程不短于 `minRun` 的像素并进 `bin`。 */
function mergeVertical(bin: Binary, soft: Binary, minRun: number): void {
  const { w, h } = bin;
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; ) {
      if (!soft.data[y * w + x]) {
        y++;
        continue;
      }
      let e = y;
      while (e + 1 < h && soft.data[(e + 1) * w + x]) e++;
      if (e - y + 1 >= minRun) for (let k = y; k <= e; k++) bin.data[k * w + x] = 1;
      y = e + 1;
    }
}

/**
 * 把 `soft` 里**细而长的横向游程**并进 `bin`：横向连续至少 `minRun` 像素，且其中每一列在 `soft` 里的纵向墨厚不超过 `maxThick`
 *（谱线、加线；符杠、字的横笔连着竖向的墨，厚出去的那几列不并）。只补 `bin` 上 ±`gapTol` 行都没墨的那些像素（断口）。
 */
function mergeHorizontal(bin: Binary, soft: Binary, minRun: number, maxThick: number, gapTol: number): void {
  const { w, h } = bin;
  const fill: number[] = [];
  const thin = (x: number, y: number) => {
    let a = y, b = y;
    while (a > 0 && soft.data[(a - 1) * w + x] && y - a < maxThick) a--;
    while (b + 1 < h && soft.data[(b + 1) * w + x] && b - y < maxThick) b++;
    return b - a + 1 <= maxThick;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; ) {
      if (!soft.data[y * w + x] || !thin(x, y)) {
        x++;
        continue;
      }
      let e = x;
      while (e + 1 < w && soft.data[y * w + e + 1] && thin(e + 1, y)) e++;
      // 只补断口：这一列在原图上下一个线宽内已经有墨的不动（原有的线不加粗——松阈值下线粗一两个像素，整页加粗后认符头跟着变，297 85 → 72）
      if (e - x + 1 >= minRun)
        for (let k = x; k <= e; k++) {
          let has = false;
          for (let d = -gapTol; d <= gapTol && !has; d++) if (y + d >= 0 && y + d < h && bin.data[(y + d) * w + k]) has = true;
          if (!has) fill.push(y * w + k);
        }
      x = e + 1;
    }
  for (const i of fill) bin.data[i] = 1;
}
/** 并回的横向游程至少几格长。 */
const LINE_RUN = 3;


/**
 * **Sauvola 局部阈值**（`T = m · (1 + k · (s/R − 1))`，内核在 `omrkit/preprocess.ts`），窗口半径取页宽的 `SAUVOLA_WIN`。
 *
 * 全局 Otsu 在这批扫描件上不够：一页里墨色深浅不匀（装订侧偏暗、页心偏淡），
 * 一个阈值要么把淡处的细线切断、要么把暗处的笔画糊粗。望十架那份线距只有 11.5px，
 * 符头才 8px 宽，粗一两个像素就并进谱线里。
 *
 * 只走 RGB / 灰度那一档——**位图路的干净底本是 1-bit 的 `mask` / `gray1`**，
 * 那两档本来就没有灰度可分（`rasterizePage` 上面那两个分支直接取位）。
 */
function sauvola(gray: Uint8Array, w: number, h: number, out: Uint8Array, k = SAUVOLA_K): void {
  sauvolaInto(gray, w, h, Math.max(8, Math.round(w * SAUVOLA_WIN)), k, out);
}

/** 墨迹占比。取完图自检、判「这一页是不是空页」都用它。 */
export function inkRatio(bin: Binary): number {
  let n = 0;
  for (let i = 0; i < bin.data.length; i++) n += bin.data[i];
  return n / (bin.w * bin.h);
}

/** 把 `Binary` 存成 PGM（P5，1 字节灰度）。排查用——PGM 谁都打得开，不引图像库。 */
export function binToPgm(bin: Binary): Uint8Array {
  const head = new TextEncoder().encode(`P5\n${bin.w} ${bin.h}\n255\n`);
  const out = new Uint8Array(head.length + bin.w * bin.h);
  out.set(head, 0);
  for (let i = 0; i < bin.data.length; i++) out[head.length + i] = bin.data[i] ? 0 : 255;
  return out;
}

// **试过「把烧粗的笔画收一圈」，净负，已撤。**
//
// `gray1` / `mask` 那两档是 1-bit 打包的，没有灰度可分，扫描时吃开的墨改不了阈值
// ——破碎那份线宽 4.4px、线距 18.8px（比值 0.23，干净底本是 0.145）。
// 试了一圈**条件腐蚀**（四邻有白就去掉，但留下「去掉会把八邻域断成两块」的独木桥，
// 免得把休止的钩、谱号的弯抹断），线宽比超 0.22 才动、动完重估线距线宽。
// 重跑歌词与标签缓存之后实测：扫描件音符 54.43% → **53.35%**、音级 56.43% → 55.35%、
// 歌词 42.91% → 39.01%，只有小节自检 31.00% → 31.58% 略涨。笔画收细了，
// 但符头也跟着缩，尺寸闸那一头丢的比擦线那一头赚的多。

/** 图的变换矩阵（单位正方形 → 用户空间，y 向上）→ 页面上的矩形（左上为原点、y 向下）。矩阵退化时当整页 */
function imageRectOf(ctm: readonly number[], view: readonly number[] | undefined, pw: number, ph: number): RasterPage["imageRect"] {
  const [a, b, c, d, e, f] = ctm as [number, number, number, number, number, number];
  const xs = [e, a + e, c + e, a + c + e];
  const ys = [f, b + f, d + f, b + d + f];
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (!(x1 - x0 > 1 && y1 - y0 > 1)) return { x: 0, y: 0, w: pw, h: ph };
  const vx = view?.[0] ?? 0, vTop = view?.[3] ?? ph;
  return { x: x0 - vx, y: vTop - y1, w: x1 - x0, h: y1 - y0 };
}
