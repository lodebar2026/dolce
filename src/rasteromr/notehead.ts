// 符头：**不走形状字典，单独判**。
//
// 为什么单独判：符头是全页最多的符号（一首歌几千个），而位图上它的形状最不稳定
// ——去谱线会在骑线的符头上切一道、符干相接处会留个缺口、加线会粘上来。
// 拿 32×32 签名聚类，实测一首歌的符头被切成十几个类（宁静一首里前八个大类全是符头
// 的残缺变体），字典越滚越大而语义还是那三个。
//
// 换成按**性质**判，三档一刀分得开：
//   - **填充率**分实心与空心：实心符头是个实椭圆，墨占包围盒的四分之三；
//     空心符头只有一圈，占不到一半。
//   - **有没有符干**分二分与全音符：空心且**没有符干**的是全音符
//     （全音符本来就不带符干），空心且有符干的是二分音符。
//
// 这三条与字体无关，换一本书也成立——而形状签名是跟着字体走的。
import type { Binary, Component, Rect } from "../omrkit/types";
import type { SmuflName } from "../staffomr/glyphs";
import type { LineSeg } from "./prims";
import type { RasterUnit } from "./staffline";
import { scoreAt, scoreAtMasked, type HeadMask } from "./headmask";
import { median } from "../omrkit/geom";

/** 认出来的符头。 */
export interface RasterHead {
  comp: Component;
  /** 剪掉加线之后的符头盒（判音高、量尺寸都用它）。 */
  box: Rect;
  code: SmuflName;
  /** 墨迹占包围盒的比例，排查用。 */
  fill: number;
  /** 挂在它左右缘的符干（没有为 null）。 */
  stem: LineSeg | null;
  /**
   * 剪出来的**加线**（符头两侧那截细横笔；没有为 null）。
   *
   * 非补这一条不可：加线的外露部分只有三四个像素（其余被符头盖住，
   * 那里的纵向游程是整个符头的高度、不算细笔画），过不了 `findPrimitives`
   * 的长度闸，于是 `findLegers` 手里一条加线都没有，谱表外的音符全被判否。
   * 而 `trimLedger` 恰好知道剪掉了哪几列——那就是加线，顺手补出来。
   */
  ledger: LineSeg | null;
}

/** 符头宽度的上下限（线距的倍数）。实心符头约 1.3 格宽、1.0 格高。 */
const W_MIN = 0.85;
/** 窄块借符干补宽度的下限（线距的倍数）：比这更窄的是残片，不借。 */
const NARROW_W = 0.6;
/** 窄头借干中段那几列时块高下限（格）。 */
const NARROW_MID_H = 0.85;
/** 上限 1.85。**全音符本身就有 1.70 格宽**（`glyphmap.json` 的 Maestro 模板），
 *  写死 1.7 等于把它卡在门口。留一点余量到 1.85。
 *  （更早试过 1.95，那时还没按宽度分全/二分，多检出的两百多个块全是噪声。） */
const W_MAX = 1.85;
/** 高度下限放得低：骑在谱线上的符头被去线切掉一道，实测能矮到 0.6 格。 */
const H_MIN = 0.55;
const H_MAX = 1.35;

/** 填充率的分界。实心椭圆理论值 π/4 ≈ 0.785，空心的一圈实测在 0.45 上下。
 *  **按扫描件重扫过**（怀疑被擦线啃过的实心头掉到 0.62 以下、要去过空心那几条更严的闸）：
 *  0.55 / 0.58 / **0.62** 两档都单调变差——扫描件音符 54.36 / 54.61 / **54.90**%、
 *  干净档 84.30 / 84.71 / **84.94**%，**小节自检垮得最狠**（干净 46.58 / 52.68 / **54.97**%）：
 *  门槛一降，二分与全音符整批被判成实心，时值全错。这条不能动。 */
const FILL_SOLID = 0.62;

/**
 * 全音符与二分音符的**宽度**分界。
 *
 * `glyphmap.json` 的 Maestro 模板：全音符 **1.70×1.06** 格、二分音符 **1.32×1.10** 格、
 * 四分音符 1.30×1.03 格——宽度一刀分得开，而高度三者几乎相同。
 *
 * 原来按「有没有符干」分（全音符不带符干），实测**不可靠**：空心符头的右侧笔画
 * 与符干在竖笔画掩模里连成一块，抽不出独立的符干段——304 个空心符头里
 * 容差放到两格也只有 98 个找得到竖段，于是二分音符整批读成全音符
 * （宁静一首认出 145 个全音符，GT 只有 15 个）。宽度这一条不依赖符干抽得出抽不出。
 */
const W_WHOLE = 1.5;

/**
 * **空心符头**另设的宽度下限。
 *
 * 实心符头会被去谱线与符干残根啃窄，所以 `W_MIN` 放到 0.85；但空心的那一档
 * 不能跟着放——页面上又扁又空的小块太多（歌词笔画的转折、弧线的一小段），
 * 实测被收成「空心符头」的块**宽度中位数只有 0.99 格**，而真二分音符是 1.32、
 * 全音符 1.70。于是宁静一首认出 145 个全音符（GT 只有 15 个）。
 * 门槛扫过 0.85（等于不设）/1.00/1.10，取 **1.00**（音符 56.30 / 56.62 / 56.52）。
 *
 * **按扫描件重扫过一遍**（0.85 / 1.00 / 1.02 / 1.05 / 1.15）：
 * 扫描件音符 54.21 / 54.90 / 54.90 / **55.15** / 55.10%，
 * 干净档音符 83.93 / 84.94 / 84.96 / **85.01** / 84.94%
 * ——1.05 两档音符都最高，**但干净档歌词从 82.41% 掉到 80.89%**
 * （少认出的空心头把音节挂法整段挪了）。不拿一个档的 1.5 点换另一个档的 0.25 点，
 * 维持 1.00。要动它，得先弄清那 1.5 点掉在哪几行上。
 *
 * **小节自检会跟着降**（29.1 → 27.7 → 25.8），那是**虚高被挤掉**、不是退化：
 * `checkBars` 跳过没有音符的小节，而一个假全音符恰好占满 4/4 一小节
 * ——空小节里混进一个就「通过」了。宁静一首原本认出 145 个全音符（GT 只有 15 个）。
 */
const W_HOLLOW_MIN = 1.0;

/**
 * **空心符头**另设的宽高比下限。
 *
 * 真符头是**横椭圆**：`glyphmap.json` 的 Maestro 模板给出全音符 1.70×1.06（比值 1.60）、
 * 二分 1.32×1.10（1.20）。而谱表上方的声部标签（"Women"/"Men"）与曲名里的
 * `o`/`e`/`D` 是**接近正方**的空心块，宽度又正好在 1.0~1.7 格这一档里
 * ——实测宁静 p2 的 "Women" 里那个 `o` 被收成上加一线的 A5 全音符。
 *
 * 假全音符不只是多出一个音：**它恰好占满一小节**，`checkFull` 于是把整小节判成
 * 「一个全音符 + 另一路旋律」，`splitVoice` 把真旋律整条推到第二声部去
 * （逐声部对拍只取声部号最小的那一路，那一行的音就全落在分母外了）。
 */
const R_HOLLOW_MIN = 1.05;

/**
 * 从连通块里挑出符头并定它的 SMuFL 名。
 *
 * 名字与矢量路的 `page.ts::findNoteheads` 岔开（那边是「给符头找它属于哪一行谱」，
 * 这边是「哪些块是符头、是哪一种」），两边都从 `src/cli/index.ts` 导出，不能重名。
 *
 * `stems` 传竖段（`findPrimitives` 的 `vSegs`）——判「有没有符干」要用。
 * 符干贴在符头的**一侧**，不穿过中心，所以比的是符头的左缘或右缘
 * （与矢量路 `page.ts::findStems` 同一条判据）。
 */
export function findRasterHeads(
  bin: Binary,
  blobs: Component[],
  stems: LineSeg[],
  unit: RasterUnit,
  /** 「这个 y 落在谱线网格的延长线上吗」——判剪出来的细横笔是不是加线。 */
  onLedgerGrid: (y: number) => boolean = () => false,
  /**
   * 「这个 y 在某行谱的五条线之内吗」（含上下各一格）。**只用来卡空心符头**：
   * 谱表上方的声部标签（"Women"/"Men"）、曲名里的 `o`/`e`/`D` 是接近正方的空心块，
   * 尺寸正好落在符头那一档里，`findStaffForNote` 又会拿文字自己的横笔当加线放行
   * （实测宁静 p2 的 "Women" 里那个 `o` 成了上加一线的 A5 **全音符**）。
   * 实心符头不受这一条限制——谱表外带加线的黑符头是常态。
   */
  inStaffBand: (y: number) => boolean = () => true,
  /**
   * **空心符头拿模板再验一道**（`rasterglyphs.ts::matchTemplate`，Maestro 的
   * `noteheadWhole` / `noteheadHalf`）。空心块是位图上最容易认错的一档：
   * 尺寸落在符头那一档、又不实心的东西满页都是（文字里的 `o`/`e`/`D`、
   * 弧线的一段、和弦图的方框）。填充率与宽高比只是粗判据，
   * **形状**才分得开——而且模板顺带把全音符与二分音符分开了（不必再拿宽度猜）。
   */
  matchHollow: ((box: Rect) => { smufl: SmuflName; dist: number } | null) | null = null,
  /** 「这个 y 在谱表五条线之外、隔着至少一格吗」——只在那里查「底是开口的弧」（延长记号）。 */
  offStaff: (y: number) => boolean = () => false,
): RasterHead[] {
  const sp = unit.space;
  const out: RasterHead[] = [];
  for (const c of blobs) {
    const t = trimLedger(bin, c.bbox, unit);
    let b = t.box;
    // **窄头被抽走符干之后更窄**：粗体铅字本的符头本来就只有一格上下（《主我敬拜你》14px、线距 14.6px），
    // 贴着的符干被当成竖段抽走，块只剩 10px（0.68 格），过不了宽度下限。
    // 块边上真贴着一根符干的，把符干那几列算回头宽再判——不贴着符干的窄块照旧不收。
    if (b.w / sp < W_MIN && b.w / sp >= NARROW_W && b.h / sp >= H_MIN && t.area / Math.max(1, b.w * b.h) >= FILL_SOLID) {
      // 和弦里挂在干中段的头也算（救主降生 m2 低音 F3/B♭2 一根朝下的干，B♭2 去线后只剩 0.82 格）：只借宽度，挂干照旧按端点。
      // 中段这一档要块有一整个头高：被线切开的空心头下半片也贴着干中段（称谢歌伴奏 m7、m12 的二分头读成低一级的四分）
      const s0 = stemOf(b, stems, unit, undefined, b.h >= sp * NARROW_MID_H);
      if (s0) {
        const sx = (s0.x0 + s0.x1) / 2;
        const half = Math.max(1, (s0.lw ?? unit.lineThick) / 2);
        const x0 = Math.min(b.x, Math.round(sx - half));
        const x1 = Math.max(b.x + b.w, Math.round(sx + half));
        if ((x1 - x0) / sp >= W_MIN) b = { ...b, x: x0, w: x1 - x0 };
      }
    }
    const w = b.w / sp;
    const h = b.h / sp;
    // **高度上限要把粘着的谱线截扣掉**（与整小节休止那道闸同一个机理）。
    // 去谱线的判据是「上下都没墨才抹」，符头压着的那一截线因此留了下来并进块里：
    // 在间的符头上下各挨着半条线，块高多出一个线宽。线细时还挤得进闸门
    //（干净档线宽 2.5px、线距 17.1px，1.0 格的符头量出来 1.29 格，勉强过 1.35），
    // 线一粗就顶出去（破碎扫描件线宽 4.4px、线距 18.8px，量出来 1.23 格，
    // 墨稍胀一点就超限）。下限仍按原样判——那道闸防的是被啃窄的残块。
    const hFit = h - unit.lineThick / sp;
    if (w < W_MIN || w > W_MAX || h < H_MIN || hFit > H_MAX) continue;
    // 太扁太长的不是符头（是横段残渣、连线）
    if (b.w > b.h * 2.2) continue;
    // 填充率按**原块**算：上面借进来的符干那几列不在 `t.area` 里
    const fill = t.area / Math.max(1, t.box.w * t.box.h);
    if (fill < 0.3) continue; // 太空：是弧线的一段、方框
    const stem = stemOf(b, stems, unit);
    // 剪掉了列，且高度落在谱线网格的延长线上 → 那两截细横笔是加线
    const ledger: LineSeg | null =
      t.trimmed && t.ledgerY != null && onLedgerGrid(t.ledgerY)
        ? { x0: c.bbox.x, y0: t.ledgerY, x1: c.bbox.x + c.bbox.w - 1, y1: t.ledgerY, lw: unit.lineThick, maxLw: unit.lineThick }
        : null;
    let code: SmuflName;
    if (fill >= FILL_SOLID) code = "noteheadBlack";
    else {
      if (w < W_HOLLOW_MIN) continue;
      // **底是开口的弧不是符头**：延长记号（弧 + 下面一个点，点是另一块）40×22、宽高比 1.8，
      // 尺寸、宽高比、离谱表的距离都过闸，善牧恩慈歌放大后被收成谱表上方的 B5 全音符。
      // 真符头是闭合的一圈：中间那几列上下都有墨。只看够一整个头高的——骑线的空心头被去线切开，
      // 上半截本来就是一道弧（那一路交给碎块并回）；也只看谱表外隔一格以上的：斜椭圆的二分头
      // 底笔不一定在一行里横满中段，谱表里照查会误伤（圣哉三一歌伴奏 −0.6、齐来谢主歌 −1.3）。
      if (h >= OPEN_ARC_H && offStaff(b.y + b.h / 2) && openBelow(bin, b)) continue;
      // **模板当附加证据，不当硬闸。** 只拿模板收（距离 ≤ `TEMPLATE_DIST`）实测更差
      //（音符 65.57% → 64.70%、小节自检 33.2% → 27.1%）：位图上的空心符头被去线
      // 切过一道、又与符干残根连着，签名与 Maestro 那份干净模板差得过闸的不到一半。
      // 反过来，模板**认得出**的就很可信，那时连全/二分也不必再拿宽度猜。
      const m = matchHollow?.(b) ?? null;
      if (m && (m.smufl === "noteheadWhole" || m.smufl === "noteheadHalf")) code = m.smufl;
      else {
        if (w / h < R_HOLLOW_MIN) continue;
        if (!inStaffBand(b.y + b.h / 2)) continue;
        // 两条线索都要：全音符**又宽又没有符干**。单看宽度，带符干残根的二分音符
        // 会被顶到 1.5 格以上；单看符干，空心符头的右侧笔画与符干在竖笔画掩模里
        // 连成一块、抽不出独立的符干段（304 个空心块里容差放到两格也只有 98 个找得到）。
        code = w >= W_WHOLE && !stem ? "noteheadWhole" : "noteheadHalf";
      }
    }
    out.push({ comp: c, box: b, code, fill, stem, ledger });
  }
  return out;
}

/** 空心候选够这么高（线距的倍数）才查「底是不是开口的」。 */
const OPEN_ARC_H = 0.8;

/**
 * 盒中间那几列（宽的 35%~65%）：顶部四分之一里有一行把这段**整条填满**、底部四分之一里一行也没有
 * ——一道朝下开口的弧。按「整条填满」而不按「有墨」：延长记号的点落在盒底正中，
 * 可它只有 0.3 格宽，横不过中间那一段；圈的底笔是连着横过去的。
 */
function openBelow(bin: Binary, b: Rect): boolean {
  const x0 = Math.round(b.x + b.w * 0.35);
  const x1 = Math.round(b.x + b.w * 0.65);
  const band = Math.max(1, Math.round(b.h / 4));
  const fullRow = (y0: number, y1: number) => {
    for (let y = Math.max(0, y0); y < Math.min(bin.h, y1); y++) {
      let all = true;
      for (let x = x0; x <= x1 && all; x++) all = x >= 0 && x < bin.w && !!bin.data[y * bin.w + x];
      if (all) return true;
    }
    return false;
  };
  return fullRow(b.y, b.y + band) && !fullRow(b.y + b.h - band, b.y + b.h);
}

/**
 * 一个**已经并好的盒**像不像符头——判据与 `findRasterHeads` 同一套
 * （尺寸 + 填充率 + 空心那几条），只是不再剪加线（盒是并出来的，不是连通块）。
 *
 * 给「碎块并回再查」那一路用：空心符头骑在谱线上时，去谱线会把它切成上下两截
 * （谱线从它中间穿过，头的内腔上下都是白的，那一段线该抹也确实抹了），
 * 于是两截都不成符头、字典也认不出——实测宁静 p3 那行「附点二分音符 + 四分休止」
 * 只认出了休止，整行五个小节全成了「一个 0.25 的音」。
 */
export function judgeHeadBox(bin: Binary, box: Rect, unit: RasterUnit, stems: LineSeg[], inStaffBand: (y: number) => boolean): SmuflName | null {
  const sp = unit.space;
  const w = box.w / sp;
  const h = box.h / sp;
  if (w < W_MIN || w > W_MAX || h < H_MIN || h > H_MAX) return null;
  if (box.w > box.h * 2.2) return null;
  let area = 0;
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++)
      if (x >= 0 && y >= 0 && x < bin.w && y < bin.h && bin.data[y * bin.w + x]) area++;
  const fill = area / Math.max(1, box.w * box.h);
  if (fill < 0.3) return null;
  if (fill >= FILL_SOLID) return "noteheadBlack";
  if (w < W_HOLLOW_MIN || w / h < R_HOLLOW_MIN) return null;
  if (!inStaffBand(box.y + box.h / 2)) return null;
  return w >= W_WHOLE && !stemOf(box, stems, unit) ? "noteheadWhole" : "noteheadHalf";
}

/**
 * **剪掉加线**：从左右两侧削掉「只有加线那么高」的列。
 *
 * 加线是抹不掉的——它压在符头底下，照 `findPrimitives` 抽出来的段去抹会把符头
 * 一起啃掉（填充率与尺寸一变就认不出符头了，实测音符 28.5% → 27.0%）。
 * 但不剪也不行：符头连着加线之后宽度从 1.3 格涨到 **1.71 格**（刚越过上限）、
 * 填充率被稀释到 0.59（掉出实心那一档），于是高音谱表下面那些带一条加线的
 * C4 整批认不出来——实测宁静人声行开头 `C4 C4 B3 C4` 只认出 B3。
 *
 * 剪的判据：那一列的墨迹高度不超过两倍线宽，就是加线自己的列。
 * 符头那几列有一整个椭圆的高度，剪不掉。
 */
function trimLedger(bin: Binary, b: Rect, unit: RasterUnit): { box: Rect; area: number; trimmed: boolean; ledgerY: number | null } {
  // **别按线距给这个上限封顶**（试过 `min(lineThick*2, space*0.35 / 0.4)`）：
  // 扫描件上少剪确实多认出符头——破碎按谱行音符 69.9% → 70.8%、扫描件 headline
  // 51.95% → 52.2%——但多出来的那批里有相当一部分是假头，`attachLyrics` 把音节
  // 挂了上去，**按谱行的歌词从 94.8% 掉到 88.8%**、扫描件歌词档 35.9% → 33.3%。
  // 拿六个点的歌词换零点几个点的音符不划算。
  const thin = Math.max(2, unit.lineThick * 2);
  const colH = new Int32Array(b.w);
  for (let x = 0; x < b.w; x++) {
    let n = 0;
    for (let y = 0; y < b.h; y++) if (bin.data[(b.y + y) * bin.w + b.x + x]) n++;
    colH[x] = n;
  }
  let l = 0;
  while (l < b.w && colH[l] > 0 && colH[l] <= thin) l++;
  let r = b.w - 1;
  while (r > l && colH[r] > 0 && colH[r] <= thin) r--;
  if (l >= r) return { box: b, area: colH.reduce((a, v) => a + v, 0), trimmed: false, ledgerY: null };
  // 纵向也收一收：剪完之后重算上下沿
  let top = b.h;
  let bottom = -1;
  let area = 0;
  for (let x = l; x <= r; x++)
    for (let y = 0; y < b.h; y++)
      if (bin.data[(b.y + y) * bin.w + b.x + x]) {
        area++;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
  const trimmed = l > 0 || r < b.w - 1;
  // **剪掉那几列的墨的 y 就是加线的 y。** 不能拿符头中心代替：
  // 符头骑在加线上时两者的确差不多，但符头落在加线**上方那一间**时差半格，
  // `ledgerGrid` 的四分之一格容差一卡，加线就被丢掉——而这正是最常见的一档
  //（实测未认领的符头里「需要 1 条加线、找到 0 条」占 159/259）。
  let ly = 0;
  let ln = 0;
  for (let x = 0; x < b.w; x++) {
    if (x >= l && x <= r) continue;
    for (let y = 0; y < b.h; y++)
      if (bin.data[(b.y + y) * bin.w + b.x + x]) {
        ly += b.y + y;
        ln++;
      }
  }
  const ledgerY = ln ? ly / ln : null;
  if (bottom < top) return { box: b, area, trimmed, ledgerY };
  return { box: { x: b.x + l, y: b.y + top, w: r - l + 1, h: bottom - top + 1 }, area, trimmed, ledgerY };
}

/** 竖段端点离头盒不到这么多格、中间那一列一路是墨的，也算挂着（给了去线图 `nl` 时）：
 *  竖段表把干截在谱线上，头在加线上、干从头底到顶线那几像素没进段（我灵镇静 m23 C4，差 4 像素）。 */
const STEM_JOIN = 0.3;

/** 竖段端点没够到盒的，补到盒缘（`stemOf` 按 `STEM_JOIN` 连上的），后面挂干（`findStems`）才对得上。 */
function extendStem(s: LineSeg, b: Rect): void {
  const top = Math.min(s.y0, s.y1);
  const bottom = Math.max(s.y0, s.y1);
  const up = s.y0 <= s.y1;
  if (top > b.y + b.h) up ? (s.y0 = b.y + b.h) : (s.y1 = b.y + b.h);
  else if (bottom < b.y) up ? (s.y1 = b.y) : (s.y0 = b.y);
}

/** 贴在这个符头左缘或右缘、且纵向相交的竖段。 */
function stemOf(b: Rect, stems: LineSeg[], unit: RasterUnit, nl?: Binary, mid = false): LineSeg | null {
  const tol = Math.max(unit.lineThick * 2, unit.space * 0.25);
  for (const s of stems) {
    const x = (s.x0 + s.x1) / 2;
    if (Math.abs(x - b.x) > tol && Math.abs(x - (b.x + b.w)) > tol) continue;
    const top = Math.min(s.y0, s.y1);
    const bottom = Math.max(s.y0, s.y1);
    const gy = nl ? unit.space * STEM_JOIN : 0;
    if (bottom < b.y - gy || top > b.y + b.h + gy) continue;
    if (bottom < b.y || top > b.y + b.h) {
      if (!nl) continue;
      // 竖段端点离盒差几像素：那一列（段宽内任一列）一路是墨才算连着
      const [y0, y1] = top > b.y + b.h ? [b.y + b.h, top] : [bottom, b.y];
      let joined = false;
      for (let xx = Math.round(Math.min(s.x0, s.x1) - 1); xx <= Math.round(Math.max(s.x0, s.x1) + 1) && !joined; xx++) {
        joined = true;
        for (let y = Math.round(y0); y <= Math.round(y1); y++) if (!nl.data[y * nl.w + xx]) { joined = false; break; }
      }
      if (!joined) continue;
    }
    // **符头要在符干的某一端**，不能在中间——小节线也常擦着符头过
    // （与矢量路 `page.ts::findStems` 同一条闸）。
    const cy = b.y + b.h / 2;
    if (!mid && Math.abs(cy - top) > unit.space && Math.abs(cy - bottom) > unit.space) continue;
    return s;
  }
  return null;
}


// ── 空心符头：**按内腔（洞）找** ────────────────────────────────────────────
//
// 空心符头在位图上最不稳：去谱线把它的圈切断、符干残根粘在旁边、叠置的和弦还会
// 碎成四五片——实测宁静 p2 钢琴右手那个二分和弦碎成 0.66×0.50 / 0.77×1.10 /
// 0.99×0.39 / 0.83×0.33 四块，一块都判不成符头，整条右手序列只剩 8 个音
// （那条谱表逐 staff 只有 56.2%，全曲最大的一个洞，GT 660 音）。
//
// 但**内腔一直在**：外圈再破，只要没破到透，中间那团白就还围着。
// 所以反过来找：在**去谱线之前**的图上取全页的孔（`contour.ts::findHoles`），
// 尺寸像符头内腔的，往外扩一圈就是符头。
//
// 骑在谱线上的头，内腔被谱线豁成上下两半（实测 0.77×0.28 两个），
// 所以先把「x 上重叠、纵向挨着」的孔并回一个。

/** 孔并回来之后，像不像符头的内腔（线距的倍数）。 */
const HOLE_W = [0.45, 1.25] as const;
const HOLE_H = [0.3, 1.0] as const;
/** 两个孔并成一个内腔：x 上要重叠这么多（窄的那个的比例），纵向缝不超过这么多格。 */
const HOLE_OVERLAP = 0.6;
/** 被一条线切开的两半内腔（扁、只隔一条线宽）并起来要的横向重叠。 */
const HOLE_OVERLAP_CUT = 0.4;
const HOLE_VGAP = 0.45;
/** 内腔往外扩多少（线距）——空心符头的圈实测 0.15~0.25 格厚。 */
const RING = 0.22;
/** 扩出来的盒里墨占多少才算「一个圈」。扫过 0.18 / 0.25 / 0.30 / 0.35：
 *  音符 67.61 / 69.57 / **69.60** / 69.41%。
 *  **按扫描件重扫过**（0.25 / 0.30 / 0.35）：扫描件音符 54.78 / **54.90** / 54.91%、
 *  干净档 84.91 / **84.94** / 84.71%——0.35 扫描档只多 0.01 而干净档掉 0.23，维持 0.30。 */
/** 内腔的宽高比下限：符头是**横椭圆**，字里的框、噪声的空隙多半接近方的。 */
const HOLE_RATIO = 1.2;
/** 贴着真符干时内腔宽高比的下限。 */
const HOLE_RATIO_ROUND = 0.95;
/** 全音符（圈厚、内腔斜）内腔宽高比的下限，见 `ringOuter`。 */
const HOLE_RATIO_WHOLE = 0.6;
/** 二分符头一定带符干（全音符才不带，靠宽度分）。放开这一条实测音符 69.57% → 67.81%。 */
const HOLE_NEED_STEM = true;
const FILL_RING = [0.3, 0.75] as const;
/** 图上量出的墨柱往一头伸出多长（格）才算符干：够一根干，又不是花括号、谱号那种长竖笔。 */
const INK_STEM = [2.5, 7] as const;
/** 叠置空心和弦里两个头的中心最多隔几格（闭合谱两声部同干可到八度多，3.5 格）。 */
const MATE_GAP = 3.5;

/** 把被谱线豁开的内腔并回一个。 */
export function mergeHoles(holes: Rect[], unit: RasterUnit, onLine: (y: number) => boolean = () => false): Rect[] {
  const sp = unit.space;
  // **先按尺寸筛一道再并**。页面上最大的一批「孔」是**谱线之间被小节线围住的那些间**
  // （实测 28×20 格一个），不筛就会顺着它们连锁并成整页一个盒（实测并完只剩 155 个、
  // 全是巨块）。符头的内腔连被谱线豁开的半截算在内，不会超过 1.4×1.2 格。
  const sorted = holes.filter((b) => b.w <= sp * 1.4 && b.h <= sp * 1.2).sort((a, b) => a.y - b.y);
  const used = new Uint8Array(sorted.length);
  const out: Rect[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    let box = { ...sorted[i] };
    for (let again = true; again; ) {
      again = false;
      for (let j = 0; j < sorted.length; j++) {
        if (used[j] || sorted[j] === box) continue;
        const r = sorted[j];
        const ov = Math.min(box.x + box.w, r.x + r.w) - Math.max(box.x, r.x);
        const gap = r.y > box.y ? r.y - (box.y + box.h) : box.y - (r.y + r.h);
        // **斜椭圆被一条线切开的两半**在 x 上错开，重叠只有四五成（《高举主大能》下加一线的 C4：
        // 12×5 与 11×5 两半、重叠 0.45）。两半都扁、中间只隔一条线宽的，重叠四成就并。
        const gapY = r.y > box.y ? box.y + box.h + gap / 2 : r.y + r.h + gap / 2;
        // 缝要落在谱线/加线网格上：棋盘网纹底本满页是小孔，不卡网格就并出假内腔（父恩广大 −1.8）
        const lineCut = ov >= Math.min(box.w, r.w) * HOLE_OVERLAP_CUT && gap <= unit.lineThick + 1 && box.h <= sp * 0.4 && r.h <= sp * 0.4 && onLine(gapY);
        if (!lineCut && ov < Math.min(box.w, r.w) * HOLE_OVERLAP) continue;
        if (gap > sp * HOLE_VGAP) continue;
        const x0 = Math.min(box.x, r.x);
        const y0 = Math.min(box.y, r.y);
        box = { x: x0, y: y0, w: Math.max(box.x + box.w, r.x + r.w) - x0, h: Math.max(box.y + box.h, r.y + r.h) - y0 };
        used[j] = 1;
        again = true;
      }
    }
    used[i] = 1;
    out.push(box);
  }
  return out;
}

/**
 * 内腔 → 空心符头。返回还没被认出来的那些（与已认出的符头盒重叠的会跳过）。
 *
 * @param nl 去谱线之后的图（量填充率、判符干用它）。
 * @param holes **去谱线之前**取的孔，已经并过（`mergeHoles`）。
 */
export function hollowHeadsFromHoles(
  nl: Binary,
  holes: Rect[],
  unit: RasterUnit,
  stems: LineSeg[],
  inStaffBand: (y: number) => boolean,
  taken: Rect[],
  bars: LineSeg[] = [],
): { box: Rect; code: SmuflName; weak?: boolean }[] {
  const sp = unit.space;
  const ring = Math.max(2, Math.round(sp * RING));
  const out: { box: Rect; code: SmuflName; weak?: boolean }[] = [];
  /** 过了尺寸与填充、只差「符干一端」那道闸的：叠置和弦里夹在中间的头（见下）。 */
  const midStem: { box: Rect; stem: LineSeg }[] = [];
  for (const hole of holes) {
    const hw = hole.w / sp;
    const hh = hole.h / sp;
    if (hw < HOLE_W[0] || hw > HOLE_W[1] || hh < HOLE_H[0] || hh > HOLE_H[1]) continue;
    // 内腔是**横椭圆**：字里的框、噪声的空隙多半接近方的。
    // 接近圆的（0.95~1.2）只在贴着一根真符干时收——粗体铅字本的二分头内腔是斜的、近乎圆
    //（《来敬拜荣耀王》C♯5、B4 两个二分头，内腔 12×11px、1.09）。
    const round = hole.w / hole.h < HOLE_RATIO;
    if (round && hole.w / hole.h < HOLE_RATIO_WHOLE) continue;
    // 一侧紧贴一根小节线形的竖段（两端压在谱表首末线上，`bars`）、另一侧一格内还有个同高的洞：
    // 是小节线、谱线与旁边的圈围出的空当，真内腔是旁边那个（有一位神 m11 小节线后那个二分头被去线切成两半，
    // 空当读成了错位的头）。旁边没洞的不剔：和谱表一样高的干也在 `bars` 里，真内腔贴着它（独唱谱音符 −0.05）
    const hcy = hole.y + hole.h / 2;
    const walled = bars.some((s0) => {
      const half = s0.maxLw / 2, cx = (s0.x0 + s0.x1) / 2;
      if (Math.min(s0.y0, s0.y1) > hole.y || Math.max(s0.y0, s0.y1) < hole.y + hole.h) return false;
      const onLeft = Math.abs(cx + half - hole.x) <= 1.5, onRight = Math.abs(hole.x + hole.w - (cx - half)) <= 1.5;
      if (!onLeft && !onRight) return false;
      // 旁边那个洞要够得上内腔的尺寸：头与谱线之间的小三角白不算
      return holes.some((o) => {
        if (o === hole || Math.abs(o.y + o.h / 2 - hcy) > sp * 0.3) return false;
        if (o.w < sp * HOLE_W[0] || o.h < sp * HOLE_H[0]) return false;
        // 旁边那个洞的另一侧也贴着一根小节线形竖段的，是小节线与谱线围出的一格空当（赞美三一真神 m15，
        // 小节线与共干 G3 二分之间），不是真内腔
        const far = bars.some((s1) => {
          if (s1 === s0) return false;
          const h1 = s1.maxLw / 2, x1 = (s1.x0 + s1.x1) / 2;
          return onLeft ? Math.abs(o.x + o.w - (x1 - h1)) <= 1.5 : Math.abs(x1 + h1 - o.x) <= 1.5;
        });
        if (far) return false;
        return onLeft ? o.x > hole.x && o.x <= hole.x + hole.w + sp : o.x + o.w < hole.x + hole.w && o.x + o.w >= hole.x - sp;
      });
    });
    if (walled) continue;
    let pairedWhole = false; // 并排有同形内腔的全音符（见下）
    // 内腔占满一个间的细圈头（望十架 p1 m4 的 F4 二分：内腔 0.86 格高），上下圈压在两条谱线里，照满圈外扩盒就高出 `H_MAX`：
    // 上下那一圈收到正好够得上 `H_MAX`
    const ringY = Math.max(1, Math.min(ring, Math.floor((sp * H_MAX - hole.h) / 2)));
    let box: Rect = { x: hole.x - ring, y: hole.y - ringY, w: hole.w + ring * 2, h: hole.h + ringY * 2 };
    if (round && (hole.w / hole.h < HOLE_RATIO_ROUND || (!stemOf(box, stems, unit, nl) && !stemThrough(box, stems, unit)))) {
      // 没干（或更瘦）的近圆内腔只可能是**全音符**：这类字体的全音符圈厚、内腔斜得竖起来（我一生要赞美你，
      // 头 25px 宽 1.7 格、内腔被谱线豁开并回来 9×11），内腔外扩一圈的盒只有 1 格、够不上全音符宽。
      // 头盒按图上的圈量到外缘，够全音符宽的才往下走。
      let outer = ringOuter(nl, hole, sp);
      let clipped = false; // 并排有同形内腔
      // 同一高度左右紧挨着另一个内腔的（两个声部同音的全音符并排贴着，我灵镇静末小节），两个头的圈连成一段，
      // 外缘量到了邻头那边（1.9 格，超了上限）：截到两个内腔之间的中线
      if (outer) {
        const hcy = hole.y + hole.h / 2;
        for (const o of holes) {
          if (o === hole || Math.abs(o.y + o.h / 2 - hcy) > sp * 0.3) continue;
          // 邻孔要长得一样（并排两个全音符的内腔），也是偏竖的近圆
          if (o.w / hole.w < 0.7 || o.w / hole.w > 1.4 || o.h / hole.h < 0.7 || o.h / hole.h > 1.4 || o.w / o.h >= HOLE_RATIO) continue;
          if ((o.x >= hole.x + hole.w && o.x - (hole.x + hole.w) < sp * 1.2) || (o.x + o.w <= hole.x && hole.x - (o.x + o.w) < sp * 1.2)) clipped = true;
          if (o.x >= hole.x + hole.w && o.x - (hole.x + hole.w) < sp * 1.2) {
            const mid = Math.round((hole.x + hole.w + o.x) / 2);
            if (mid < outer.x + outer.w) outer = { ...outer, w: mid - outer.x };
          } else if (o.x + o.w <= hole.x && hole.x - (o.x + o.w) < sp * 1.2) {
            const mid = Math.round((o.x + o.w + hole.x) / 2);
            if (mid > outer.x) outer = { ...outer, x: mid, w: outer.x + outer.w - mid };
          }
        }
      }
      // 并排有个同形内腔的（两声部同音的全音符「oo」），宽度放到 1.25 格：这本的全音符头只有 1.37 格宽（新编赞美诗 218 m4 的 A3），
      // 过不了单个全音符的宽度门（`W_WHOLE`，防的是没挂上干的二分头——那种不会成对并排）
      if (!outer || outer.w / sp < (clipped ? 1.25 : W_WHOLE)) continue;
      pairedWhole = clipped && outer.w / sp < W_WHOLE;
      box = outer;
    }
    const w = box.w / sp;
    const h = box.h / sp;
    if (w < W_HOLLOW_MIN || w > W_MAX || h < H_MIN || h > H_MAX) continue;
    if (w / h < R_HOLLOW_MIN) continue;
    if (!inStaffBand(box.y + box.h / 2)) continue;
    // 圈要**围得住**：盒里的墨占三成到七成（全实心的是实心符头、太空的是别的东西的空隙）
    let ink = 0;
    for (let y = box.y; y < box.y + box.h; y++)
      for (let x = box.x; x < box.x + box.w; x++)
        if (x >= 0 && y >= 0 && x < nl.w && y < nl.h && nl.data[y * nl.w + x]) ink++;
    const fill = ink / Math.max(1, box.w * box.h);
    if (fill < FILL_RING[0] || fill > FILL_RING[1]) continue;
    // 已经认出来的符头不重复收
    if (taken.some((t) => overlaps(t, box, sp * 0.4))) continue;
    let stem: LineSeg | true | null = stemOf(box, stems, unit, nl);
    if (!stem) {
      // 竖段表里没有的干：闭合谱男声 B3 往下一根干穿过整个谱表到 G♯2（齐来称颂），
      // 长得像小节线，没进竖段表。照 Audiveris `HeadLinker` 的做法直接在图上沿盒边量墨柱，
      // 往一头伸出 2.5~7 格就算有干。
      const col = inkColumn(nl, box, unit);
      const cy = box.y + box.h / 2;
      const reach = col ? Math.max(cy - col[0], col[1] - cy) : 0;
      if (reach >= sp * INK_STEM[0] && reach <= sp * INK_STEM[1]) stem = true;
    }
    if (!stem) {
      const through = stemThrough(box, stems, unit);
      if (through) midStem.push({ box, stem: through });
    }
    // 二分符头一定带符干，全音符才不带（宽度那一档与 `judgeHeadBox` 共用 `W_WHOLE`）。
    // 试过把全音符的宽度门槛单独抬到 1.65：时值 90.3% → 90.5%，但音符 69.60% → 69.52%，
    // 不划算。
    if (HOLE_NEED_STEM && !stem && w < W_WHOLE && !pairedWhole) continue;
    // 靠墨柱认下的头标 `weak`：不进空心头模板的样本（`buildHollowMasks`）。它们多半拖着
    // 一根穿过窗口的长干，混进去模板就偏了——善牧恩慈歌两处真二分头认出来，却让模板
    // 再也配不上后面的全音符和弦（音符 90.0% → 89.3%，不进样本 → 91.4%）。
    if (stem && stem !== true) extendStem(stem, box);
    out.push({ box, code: (w >= W_WHOLE || pairedWhole) && !stem ? "noteheadWhole" : "noteheadHalf", ...(stem === true ? { weak: true } : {}) });
    taken.push(box);
  }
  // **叠置空心和弦**：符干从一端的头穿过另一个头往外伸（齐来称颂 A4/E4 二分和弦，
  // 干从 E4 起、穿过 A4 再往上两格），夹在中段的那个头过不了「符头在符干一端」。
  // 同一根干上 2.2 格内已有收下的空心头，它就是和弦的一员。
  //
  // 同干的另一个头只要**碰到这根干**就算（干常常只到那个头的中线上一两像素，
  // 「穿过中线」差一像素就落空），相隔放到 3.5 格（齐来称颂男声 A3/C♯3 隔 2.5 格）。
  // 这就是 Audiveris 的「符头柱」：两头都伸出去的是柱中段，由柱端那个连上干的头来定。
  const tol = Math.max(unit.lineThick * 2, sp * 0.25);
  for (const m of midStem) {
    if (taken.some((t) => overlaps(t, m.box, sp * 0.4))) continue;
    const cy = m.box.y + m.box.h / 2;
    const top = Math.min(m.stem.y0, m.stem.y1);
    const bottom = Math.max(m.stem.y0, m.stem.y1);
    const x = (m.stem.x0 + m.stem.x1) / 2;
    // 同干的伙伴也可以是**别的路已认出的头**（`taken`）：粗体本 C♯5/E4 二分和弦，E4 是单头那一路收的
    const mate = [...out.map((o) => o.box), ...taken].some((o) => {
      if (o === m.box) return false;
      if (Math.abs(x - o.x) > tol && Math.abs(x - (o.x + o.w)) > tol) return false;
      if (bottom < o.y || top > o.y + o.h) return false;
      return Math.abs(o.y + o.h / 2 - cy) <= sp * MATE_GAP;
    });
    if (!mate) continue;
    out.push({ box: m.box, code: "noteheadHalf" });
    taken.push(m.box);
  }
  return out;
}

/**
 * 内腔四周的圈量到外缘：逐行从内腔最左 / 最右的白往外、逐列从最上 / 最下的白往外，穿过一段墨到白为止，
 * 墨段超过 0.7 格的那一道不算（连着别的笔画）；四边各取最远。谱线常从内腔中间横穿过去
 *（头上下都连着墨，去线时留下了），所以不从中心点出发。
 */
function ringOuter(nl: Binary, hole: Rect, sp: number): Rect | null {
  const cap = Math.round(sp * 0.7);
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < nl.w && y < nl.h && nl.data[y * nl.w + x] === 1;
  const run = (x: number, y: number, dx: number, dy: number): number | null => {
    let j = 0;
    while (j <= cap && ink(x + dx * j, y + dy * j)) j++;
    return j === 0 || j > cap ? null : j;
  };
  let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
  for (let y = hole.y; y < hole.y + hole.h; y++) {
    let xa = -1, xb = -1;
    for (let x = hole.x; x < hole.x + hole.w; x++) if (!ink(x, y)) { if (xa < 0) xa = x; xb = x; }
    if (xa < 0) continue;
    const a = run(xa - 1, y, -1, 0);
    const c = run(xb + 1, y, 1, 0);
    if (a !== null) l = Math.min(l, xa - a);
    if (c !== null) r = Math.max(r, xb + c);
  }
  for (let x = hole.x; x < hole.x + hole.w; x++) {
    let ya = -1, yb = -1;
    for (let y = hole.y; y < hole.y + hole.h; y++) if (!ink(x, y)) { if (ya < 0) ya = y; yb = y; }
    if (ya < 0) continue;
    const a = run(x, ya - 1, 0, -1);
    const c = run(x, yb + 1, 0, 1);
    if (a !== null) t = Math.min(t, ya - a);
    if (c !== null) b = Math.max(b, yb + c);
  }
  if (!isFinite(l) || !isFinite(r) || !isFinite(t) || !isFinite(b)) return null;
  return { x: l, y: t, w: r - l + 1, h: b - t + 1 };
}

/**
 * **开口内腔** → 空心符头：低分辨率小图上头右上那一笔印得极淡（万福泉源歌第二行末的二分音符，
 * 原图灰度 240 以上，不是二值化丢的），内腔从缺口漏到谱线间的空白里，`findHoles` 找不到孔。
 * 内腔由调用方按「四向都碰得到墨」拼出来（`restshape.ts::openCavities`），常连着头与符干之间那一截、
 * 近乎圆，过不了 `hollowHeadsFromHoles` 的横椭圆闸——这里不看内腔形状，
 * 头盒取本页已认二分头的中位尺寸、以内腔中心为心，再按那边同一套填充与符干判据收。
 */
export function hollowHeadsFromCavities(
  nl: Binary,
  cavities: Rect[],
  unit: RasterUnit,
  stems: LineSeg[],
  inStaffBand: (y: number) => boolean,
  taken: Rect[],
  size: { w: number; h: number },
  /**
   * 已认出的**实心**符头（带符尾的只能是实心头；空心的是和弦伙伴，不拦）。
   * 上下隔一格以上、横向与盒相交或边缘相接的，说明两者之间那根干是那个头的，
   * 这「内腔」是弯回符干的八分符尾：有一位神两处（头在干左下，旁边还挨着小节线，墨柱量到的是小节线）、
   * 圣哉三一歌伴奏与来敬拜荣耀王三处（干朝下、头在正上方）。三度和弦的两个头只隔一格不到，不受影响。
   */
  heads: Rect[],
): { box: Rect; code: SmuflName }[] {
  const sp = unit.space;
  const tol = Math.max(unit.lineThick * 2, sp * 0.25);
  const out: { box: Rect; code: SmuflName }[] = [];
  const flagOf = (b: Rect) =>
    heads.some((h) => {
      const dy = Math.abs(h.y + h.h / 2 - (b.y + b.h / 2));
      if (dy < sp || dy > sp * INK_STEM[1]) return false;
      return h.x <= b.x + b.w + tol && h.x + h.w >= b.x - tol;
    });
  for (const cav of cavities.slice().sort((a, b) => a.y - b.y)) {
    const cw = cav.w / sp;
    const ch = cav.h / sp;
    if (cw < HOLE_W[0] || cw > HOLE_W[1] || ch < HOLE_H[0] || ch > HOLE_H[1]) continue;
    const cx = cav.x + cav.w / 2;
    const cy = cav.y + cav.h / 2;
    if (!inStaffBand(cy)) continue;
    const box: Rect = { x: Math.round(cx - size.w / 2), y: Math.round(cy - size.h / 2), w: size.w, h: size.h };
    let ink = 0;
    for (let y = box.y; y < box.y + box.h; y++)
      for (let x = box.x; x < box.x + box.w; x++)
        if (x >= 0 && y >= 0 && x < nl.w && y < nl.h && nl.data[y * nl.w + x]) ink++;
    const fill = ink / Math.max(1, box.w * box.h);
    if (fill < FILL_RING[0] || fill > FILL_RING[1]) continue;
    if (taken.some((t) => overlaps(t, box, sp * 0.4))) continue;
    if (flagOf(box)) continue;
    // 二分头一定带干：竖段表里头落在一端的，或图上量得出的墨柱（穿过头的不算，旁边的小节线也穿得过）
    if (!stemOf(box, stems, unit)) {
      const col = inkColumn(nl, box, unit);
      const reach = col ? Math.max(cy - col[0], col[1] - cy) : 0;
      if (reach < sp * INK_STEM[0] || reach > sp * INK_STEM[1]) continue;
    }
    out.push({ box, code: "noteheadHalf" });
    taken.push(box);
  }
  return out;
}

// ── 空心头：**按音高位置逐一配模板**（Audiveris 式）────────────────────────
//
// 叠成「8」字的三度空心和弦，两个内腔中间只隔两像素细圈，`mergeHoles` 把它们当成
// 被谱线豁开的一个内腔并掉（齐来称颂 E4/B3、G♯3/E3、C♯4/A3，并出来 1.7~1.8 格高），
// 过不了内腔尺寸闸。拦合并试过四种都不行（圣哉三一歌伴奏的斜缝内腔一个头切成三四片，
// 必须并）。Audiveris（`NoteHeadsBuilder.processStaff`）不从内腔反推头，而是沿谱线、间、
// 加线的每个音高位置逐一配模板，重叠按音级差判（`HeadInter.overlaps`：差 ≥2 级不算重叠）
// ——三度的两个头在隔两级的两个位置上各自得分，天然分得开。
//
// 这里只在**有内腔的地方**这么找：「拿模板去空地里找」对实心头每档都低于不做
// （`docs/实现/位图五线谱识别/符头与加线.md`），内腔是空心头最硬的先验，留着。

/** 候选区：并过的内腔高过一个头、又不超过两个头（格）。实测真叠头 1.69~1.87 格；
 *  八分音符的符尾弯回符干、被谱线切成几片再并起来的「孔」1.88~2.87 格（宁静的伯利恒二十多处）。 */
const STACK_H = [1.0, 2.0] as const;
/** 候选区的宽度下限（格）：真叠头的内腔 0.93~1.11 格宽；八分符尾弯回符干围出来的窄孔
 *  0.64~0.88 格（破碎干净版五处，得分也只有 0.30 上下）。 */
const STACK_W = 0.9;
// 下面三个门槛是在 `STACK_H` 上限 3.5 格、不要求两个头时扫的；加上那两条与 `STACK_W` 之后，
// 图片九首合计不变（93.41%），合唱谱两档回到基线以上。
/** 打分窗口只留中间这么高（格）。整窗 1.5 格高会把叠着的邻头的圈框进来、算成「不该有的墨」，
 *  间位的头只打到 0.26~0.33 分（线位 0.5~0.7）。扫过整窗 / 1.2 / 1.1 / **1.0** / 0.9 / 0.8：
 *  九首合计 92.39 / 92.86 / 93.41 / **93.41** / 93.41 / 92.76%，1.0 这一档对下面的门槛最不敏感。 */
const PITCH_CORE = 1.0;
/** 模板得分门槛。核心窗下扫过 0.27 / **0.30** / 0.33 / 0.40：93.51 / 93.41 / 93.41 / 92.11%。 */
const PITCH_SCORE = 0.3;
/** 内腔佐证：该位置的内腔椭圆里落在原始孔里的白像素占比。扫过 0.35 / 0.40 / 0.45 / **0.50** / 0.55：
 *  93.23 / 93.23 / 93.23 / **93.41** / 92.76%。低了圣哉三一歌伴奏的斜缝内腔只收半边、
 *  挡住模板再搜那一路（它两个都认得出）；高了齐来称颂 C4 那种骑加线的头佐证不够（0.54）。 */
const CAVITY_MIN = 0.5;
/** **成对放宽**：圈粗、内腔是斜缝的三度空心叠头（「8」字），两个头的模板分常卡在门槛下一点
 *  （我灵镇静 0.29 / 0.28、大地风光 0.39 / 0.29）。区里恰好两个位置、隔着至少两级，
 *  各自模板分过 `PAIR_SCORE`、内腔佐证过 `PAIR_CAVITY`、头盒墨占比过 `PAIR_INK`，就一起收。
 *  墨占比那一条挡的是八分符尾斜笔 + 符干 + 谱线围出的空框（向主唱新歌：内腔佐证 1.0、模板 0.31 / 0.28，
 *  墨只有 0.27~0.28；真叠头 0.35~0.43）。独唱谱上模板分扫过 0.20 / 0.22 / **0.25**，内腔 0.6 / **0.7**，
 *  墨 0.30 / **0.32** / 0.34：都在 ±0.01 以内；0.22 在合唱谱扫描档多收三对 0.24 上下的，扫描歌词 −0.17。 */
const PAIR_SCORE = 0.25;
const PAIR_CAVITY = 0.7;
const PAIR_INK = 0.32;

/** 一个音高位置：中心 y，以及它是不是线位（含加线位）。 */
export interface PitchStep {
  y: number;
  line: boolean;
}

/** 按音高位置配模板的公用件：核心窗模板、内腔佐证、「同一个头」判定、定干。 */
function pitchScorer(bin: Binary, nl: Binary, rawHoles: Rect[], allMasks: HeadMask[], unit: RasterUnit, stems: LineSeg[]) {
  const sp = unit.space;
  const masks = allMasks.map((m) => {
    const h = Math.min(m.h, Math.max(3, Math.round(sp * PITCH_CORE)));
    const top = Math.floor((m.h - h) / 2);
    return { ...m, h, p: m.p.slice(top * m.w, (top + h) * m.w) };
  });
  /** 内腔椭圆的半轴：内腔实测约 1.0×0.8 格。 */
  const rx = sp * 0.45;
  const ry = sp * 0.32;
  /** 该位置的内腔椭圆里，落在原始孔里的白像素占比。 */
  const cavity = (cx: number, cy: number): number => {
    let n = 0;
    let hit = 0;
    for (let y = Math.round(cy - ry); y <= Math.round(cy + ry); y++)
      for (let x = Math.round(cx - rx); x <= Math.round(cx + rx); x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
        n++;
        if (x < 0 || y < 0 || x >= bin.w || y >= bin.h || bin.data[y * bin.w + x]) continue;
        if (rawHoles.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) hit++;
      }
    return n ? hit / n : 0;
  };
  /** 在 y 这个位置、x 从 xa 到 xb 扫，取骑线/在间对应模板的最高分。 */
  const best = (st: PitchStep, xa: number, xb: number): { x: number; s: number } | null => {
    const m = masks.find((k) => k.onLine === st.line) ?? masks[0];
    let b: { x: number; s: number } | null = null;
    for (let x = Math.round(xa); x <= Math.round(xb); x++) {
      const sc = scoreAt(bin, m, x, st.y);
      if (!b || sc > b.s) b = { x, s: sc };
    }
    return b;
  };
  /** 同 `best`，但谱线行与 `stemX` 那根干的列不计（`scoreAtMasked`）。 */
  const bestMasked = (st: PitchStep, xa: number, xb: number, stemX: number): { x: number; s: number; y: number } | null => {
    const m = masks.find((k) => k.onLine === st.line) ?? masks[0];
    const half = Math.max(1, Math.ceil(unit.lineThick));
    let b: { x: number; s: number; y: number } | null = null;
    const dy = Math.round(sp * ALONG_DY);
    for (let x = Math.round(xa); x <= Math.round(xb); x++)
      for (let d = -dy; d <= dy; d++) {
        const sc = scoreAtMasked(bin, m, x, st.y + d, stemX, half);
        if (!b || sc > b.s) b = { x, s: sc, y: st.y + d };
      }
    return b;
  };
  /** **行向围合的白**：头心附近（谱线行不算）每个白像素，同一行左右 `sp*0.6` 内都有墨的占比。圈断了口、
   *  内腔不成闭合的孔（`cavity` 看的原始孔）时，也看得出「这里是被圈夹着的白」；实心头这里没有白。 */
  const enclosed = (cx: number, cy: number): number => {
    let n = 0;
    let hit = 0;
    const reach = Math.round(sp * 0.6);
    const half = Math.round(sp * 0.85);
    for (let y = Math.round(cy - ry); y <= Math.round(cy + ry); y++) {
      if (y < 0 || y >= bin.h) continue;
      let row = 0;
      for (let x = Math.round(cx) - half; x <= Math.round(cx) + half; x++) if (x >= 0 && x < bin.w) row += bin.data[y * bin.w + x];
      if (row >= (half * 2 + 1) * 0.9) continue;
      for (let x = Math.round(cx - rx * 0.6); x <= Math.round(cx + rx * 0.6); x++) {
        if (x < 0 || x >= bin.w) continue;
        n++;
        if (bin.data[y * bin.w + x]) continue;
        let l = false;
        let r = false;
        for (let d = 1; d <= reach && !(l && r); d++) {
          if (!l && x - d >= 0 && bin.data[y * bin.w + x - d]) l = true;
          if (!r && x + d < bin.w && bin.data[y * bin.w + x + d]) r = true;
        }
        if (l && r) hit++;
      }
    }
    return n ? hit / n : 0;
  };
  /** 与已有的头差不到两级（同一位置或相邻半格）、横向又压着的，算同一个头。 */
  const clash = (b: Rect, list: Rect[]) =>
    list.some(
      (t) =>
        Math.abs(t.y + t.h / 2 - (b.y + b.h / 2)) < sp * 0.75 &&
        Math.abs(t.x + t.w / 2 - (b.x + b.w / 2)) < (t.w + b.w) / 2 - sp * 0.2,
    );
  /** 时值：与 `hollowHeadsFromHoles` 同一套——竖段表的干、墨柱、同干成员。没干又不够宽的返回 null。 */
  const codeOf = (box: Rect, picked: Rect[]): { code: SmuflName; ink?: LineSeg } | null => {
    let stem: LineSeg | true | null = stemOf(box, stems, unit);
    let ink: LineSeg | undefined;
    if (!stem) {
      const col = inkColumn(nl, box, unit);
      const cy = box.y + box.h / 2;
      const reach = col ? Math.max(cy - col[0], col[1] - cy) : 0;
      if (col && reach >= sp * INK_STEM[0] && reach <= sp * INK_STEM[1]) {
        stem = true;
        ink = { x0: col[2], y0: col[0], x1: col[2], y1: col[1], lw: unit.lineThick, maxLw: unit.lineThick * 2 };
      }
    }
    if (!stem) {
      const through = stemThrough(box, stems, unit);
      if (through && picked.some((o) => o !== box && Math.abs(o.y - box.y) <= sp * MATE_GAP)) stem = through;
    }
    if (!stem && box.w / sp < W_WHOLE) return null;
    return { code: stem ? "noteheadHalf" : "noteheadWhole", ink };
  };
  /** 以 (cx, cy) 为中心、宽 w、高 0.9 格的头盒里的墨占比，**跳过整行是墨的行**（谱线、加线）。 */
  const inkIn = (cx: number, cy: number, w: number): number => {
    const x0 = Math.max(0, Math.round(cx - w / 2));
    const x1 = Math.min(bin.w - 1, Math.round(cx + w / 2));
    let n = 0;
    let k = 0;
    for (let y = Math.max(0, Math.round(cy - sp * 0.45)); y <= Math.min(bin.h - 1, Math.round(cy + sp * 0.45)); y++) {
      let row = 0;
      for (let x = x0; x <= x1; x++) row += bin.data[y * bin.w + x];
      if (row >= (x1 - x0 + 1) * 0.9) continue;
      n += x1 - x0 + 1;
      k += row;
    }
    return n ? k / n : 0;
  };
  return { enclosed, cavity, best, bestMasked, clash, codeOf, inkIn };
}

export function hollowHeadsByPitch(
  bin: Binary,
  nl: Binary,
  rawHoles: Rect[],
  holes: Rect[],
  allMasks: HeadMask[],
  unit: RasterUnit,
  stepsIn: (y0: number, y1: number) => PitchStep[],
  stems: LineSeg[],
  inStaffBand: (y: number) => boolean,
  taken: Rect[],
): { box: Rect; code: SmuflName; weak?: boolean }[] {
  const sp = unit.space;
  if (!allMasks.length) return [];
  const { cavity, best, clash, codeOf, inkIn } = pitchScorer(bin, nl, rawHoles, allMasks, unit, stems);
  const ring = Math.max(2, Math.round(sp * RING));
  const out: { box: Rect; code: SmuflName; weak?: boolean }[] = [];
  const headH = Math.round(sp * 1.1);
  for (const hole of holes) {
    const hw = hole.w / sp;
    const hh = hole.h / sp;
    if (hw < STACK_W || hw > HOLE_W[1] || hh <= STACK_H[0] || hh > STACK_H[1]) continue;
    const cx0 = hole.x + hole.w / 2;
    if (!inStaffBand(hole.y + hole.h / 2)) continue;
    const bw = hole.w + ring * 2;
    const cands: { x: number; y: number; s: number }[] = [];
    const loose: { x: number; y: number; s: number }[] = [];
    for (const st of stepsIn(hole.y - sp * 0.3, hole.y + hole.h + sp * 0.3)) {
      const b = best(st, cx0 - sp * 0.2, cx0 + sp * 0.2);
      if (!b) continue;
      const cav = cavity(b.x, st.y);
      if (b.s >= PAIR_SCORE && cav >= PAIR_CAVITY && inkIn(b.x, st.y, hole.w + ring * 2) >= PAIR_INK) loose.push({ x: b.x, y: st.y, s: b.s });
      if (b.s < PITCH_SCORE || cav < CAVITY_MIN) continue;
      cands.push({ x: b.x, y: st.y, s: b.s });
    }
    const relaxed = cands.length < 2 && loose.length === 2 && Math.abs(loose[0].y - loose[1].y) > sp * 0.75;
    if (relaxed) cands.splice(0, cands.length, ...loose);
    cands.sort((a, b) => b.s - a.s);
    const picked: Rect[] = [];
    for (const c of cands) {
      const box: Rect = { x: Math.round(c.x - bw / 2), y: Math.round(c.y - headH / 2), w: bw, h: headH };
      if (clash(box, picked) || clash(box, taken)) continue;
      picked.push(box);
    }
    // 两个内腔并成的区就该认出两个头。只认出一个的：符尾围出来的假孔（宁静的伯利恒），
    // 或斜缝内腔上面那个头佐证不够（圣哉三一歌伴奏）——收了半边反倒挡住「空心头按模板再搜」
    // 那一路（它两个都认得出），整区交回去。
    if (picked.length < 2) continue;
    // 放宽收来的一对**要找得到干**：找不到干的会记成全音符，而那种叠头后面「空心头按模板再搜」
    // 那一路认得对（大地风光 m8 的 B3/D4 二分，抢过来就成了全音符）。
    if (relaxed && picked.some((b) => codeOf(b, picked)?.code !== "noteheadHalf")) continue;
    for (const box of picked) {
      const c = codeOf(box, picked);
      if (!c) continue;
      out.push({ box, code: c.code, weak: true });
      taken.push(box);
    }
  }
  return out;
}

// ── 空心头：**沿着已挂了空心头的干**按音高位置配模板 ─────────────────────────
//
// 和弦里夹在干中段的空心头（恩友歌 m2 的 D5/B♭4「8」字叠头，下面的 F4 认出来了），内腔被谱线切成两个小三角，
// 够不上内腔的尺寸；干底端挂着 F4，也不是光杆干。Audiveris 找符头时借竖直种子（符干）在合适的位置评估候选，
// 这里照做：干上已有空心头的，从那个头往自由端方向、到自由端往回 `ALONG_FREE` 格为止——或者干在头上方断开的，
// 在断口与头之间（干被叠头的圈切断）——逐个音高位置拿本页空心模板打分，头心横坐标照那个头，
// 墨占比（跳过谱线行）要像空心头、内腔佐证要够。
// 独唱谱音符 93.55 → 93.73%、时值 91.45 → 91.62%（流血歌伴奏 +4.1，恩友歌、称谢歌、当我们回到天家各 +0.4~0.6），无一首掉；合唱谱不动。

/** 自由端最后这么多格是干本身，不找头。 */
const ALONG_FREE = 2.5;
/** 干的近端离头心不过这么多格，算干断在两者之间（中间夹着没认出的头）。 */
const ALONG_GAP = 3.5;
/** 头离干的近端也有这么多格，算悬在干中段。 */
const ALONG_MID = 1.5;
/** 模板分、头盒墨占比（跳过谱线行）、内腔佐证的门槛。内腔那条分得开「两个头相接的中间位置」（恩友歌 0.19，
 *  两个真头心 0.55 / 0.42）——那里墨占比与真头心一样是 0.5。扫过模板 0.25 / **0.3** / 0.35、墨下限 **0.35** / 0.4、
 *  内腔 0.3 / **0.35** / 0.45：93.70 / 93.73 / 93.71、93.73 / 93.71、93.70 / 93.73 / 93.64%。 */
const ALONG_SCORE = 0.3;
const ALONG_INK = [0.35, 0.8] as const;
const ALONG_CAVITY = 0.35;
/** 悬在干中段的头往近端找时，离干端这么多格以内那一级的模板分门槛（我灵镇静 m10 的 F4 0.26：
 *  上下缘正压两条谱线，模板窗口里的谱线行拉低了分）。 */
const ALONG_END_TOL = 0.3;
/** 干断在头上、再往外一格那个位置的放宽：模板分过这个数时内腔佐证只要这么多。 */
const BEYOND_SCORE = 0.4;
const BEYOND_CAVITY = 0.2;
const ALONG_END_SCORE = 0.2;
/** 往干里一个三度那一级（「8」字叠头）：内腔佐证到这么多时，模板分门槛放到这么低。 */
const THIRD_CAVITY = 0.4;
const THIRD_SCORE = 0.2;
/** 内腔印糊、靠「同干同时值」认的头：模板分、墨占比下限，与「夹在两头中间」的判定距离（格）。 */
const ALONG_FILLED_SCORE = 0.35;
const ALONG_FILLED_INK = 0.4;
const ALONG_SANDWICH = 1.25;
/** 干端那一级细圈头的放宽：模板分、内腔佐证到这么多时，墨占比下限放到 `ink`。 */
const END_THIN = { score: 0.4, cavity: 0.6, ink: 0.3 } as const;
/** 干穿过一个头又多伸出一格、端上那一级的模板分到这么多，内腔不作证也认（157 m11 高音 0.68、墨 0.38）。 */
const TIP_SCORE = 0.5;
/** 沿干找头的横向搜索半宽（格）：叠头常比参照头偏出几像素（001 m12 的 B♭4 偏右 5 像素）。 */
const ALONG_XW = 0.3;
/** 纵向微调半宽（格）：谱表外加线旁的头心离音高网格三四像素（138 m9 的 B3）。 */
const ALONG_DY = 0.15;
/** 行向围合的白（`enclosed`）到这么多，算内腔作证（圈断了口、不成闭合孔的细圈头：126 m1 的 E♭4 0.38、138 m9 的 B3 0.69）。 */
const ALONG_ENCLOSED = 0.3;
/** 原始孔作证时行向围合的下限（见用处）。 */
const ALONG_ENCLOSED_MIN = 0.1;
/** 「印糊」那一档的墨占比上限：同干上面是实心四分、下面是二分的（017 m8 的 F♯3，墨 0.72），不能靠「同干同时值」收成二分；真印糊的 0.43。 */
const ALONG_FILLED_INK_MAX = 0.6;

/** 重新落位：相邻一级的模板分要高出本级这么多（202 m9：本级 0.18、上一级 0.54；读对的头本级 0.5~0.7），头心也要比本级更贴干端。
 *  新编前 80 首扫过 0.1 / 0.2：音符档 90.00 / 89.99%。 */
const RESEAT_MARGIN = 0.1;
/** 相邻一级的模板分下限。 */
const RESEAT_SCORE = 0.35;

/**
 * **挂在干端的空心头重新落位**：头盒按内腔外扩，骑加线的头内腔只剩线下那半，盒就低了一级（202 m9 的 A3 读成 G3，干端停在 A3 的头心）。
 * 在本级与上下相邻一级各配一次对齐过的模板（谱线行、干列不计），相邻一级明显高（`RESEAT_MARGIN`）、头心离干端也更近的，挪过去。
 * 返回挪过的个数（就地改盒）。
 */
export function reseatHollowHeads(
  bin: Binary,
  nl: Binary,
  rawHoles: Rect[],
  allMasks: HeadMask[],
  unit: RasterUnit,
  stepsIn: (y0: number, y1: number) => PitchStep[],
  stems: LineSeg[],
  heads: { box: Rect; code: string }[],
): number {
  if (!allMasks.length) return 0;
  const sp = unit.space;
  const { bestMasked, enclosed, cavity } = pitchScorer(bin, nl, rawHoles, allMasks, unit, stems);
  const tol = Math.max(unit.lineThick * 2, sp * 0.25);
  let moved = 0;
  for (const h of heads) {
    if (h.code !== "noteheadHalf") continue;
    const cy = h.box.y + h.box.h / 2;
    const cx = h.box.x + h.box.w / 2;
    // 干：盒缘贴着、一端离头心不过 0.75 格
    let v: LineSeg | undefined;
    let endY = 0;
    for (const s of stems) {
      const vx = (s.x0 + s.x1) / 2;
      if (Math.min(Math.abs(h.box.x - vx), Math.abs(h.box.x + h.box.w - vx)) > tol) continue;
      const top = Math.min(s.y0, s.y1);
      const bot = Math.max(s.y0, s.y1);
      if (bot - top < sp * 1.5) continue;
      const e = Math.abs(top - cy) < Math.abs(bot - cy) ? top : bot;
      if (Math.abs(e - cy) > sp * 0.75) continue;
      v = s;
      endY = e;
      break;
    }
    if (!v) continue;
    const vx = (v.x0 + v.x1) / 2;
    const steps = stepsIn(cy - sp * 0.8, cy + sp * 0.8);
    if (steps.length < 2) continue;
    const own = steps.reduce((p, q) => (Math.abs(q.y - cy) < Math.abs(p.y - cy) ? q : p));
    const ownB = bestMasked(own, cx - sp * 0.3, cx + sp * 0.3, vx);
    if (!ownB) continue;
    let pick: { st: PitchStep; b: { x: number; s: number; y: number } } | null = null;
    for (const st of steps) {
      if (st === own || Math.abs(Math.abs(st.y - own.y) - sp / 2) > sp * 0.2) continue;
      const b = bestMasked(st, cx - sp * 0.3, cx + sp * 0.3, vx);
      if (!b || b.s < RESEAT_SCORE || b.s < ownB.s + RESEAT_MARGIN) continue;
      if (Math.abs(st.y - endY) >= Math.abs(own.y - endY)) continue;
      if (cavity(b.x, b.y) < ALONG_CAVITY && enclosed(b.x, b.y) < ALONG_ENCLOSED) continue;
      if (!pick || b.s > pick.b.s) pick = { st, b };
    }
    if (!pick) continue;
    h.box = { ...h.box, y: Math.round(h.box.y + pick.st.y - cy) };
    moved++;
  }
  return moved;
}

// ── 空心头：**以干为锚、不要参照头** ─────────────────────────────────────────
//
// 「8」字叠头两个头都没认出时（069 m1 低音 B3/G3：干 3.7 格，两个头都是被谱线切开的细斜缝），沿干找头那一路没有参照头。
// 照「竖直种子」的思路：两端都没挂头的干，在端头那一带逐个音高位置配本页对齐过的空心模板（谱线行与干列不计），
// 头盒按惯例的一侧贴干——干的上端挂头的头在干右（干朝下），下端挂头的头在干左（干朝上）。端带里过门槛的都收
// （三度叠头两个都落在端带里：069 m1 干端的 B3 模板 0.32、围合 0.35，往里一级的 G3 0.36），更远的交给 `hollowHeadsAlongStems`。
// 整本新编音符档 90.42 → 90.59%（64 升 9 降，031 掉一步：补对了 B3，声部分配连带变了）。

/** 干长（格）。新编前 80 首扫过下限 3 / **2.5** / 2：音符档 90.24 / 90.35 / 90.35%（2 那档 021 掉一步）；
 *  升降号、还原号的竖笔有临时记号符号挡着，没认出的也过不了模板分与内腔佐证。 */
const SEED_LEN = [2.5, 7] as const;
const SEED_SHORT = 3;
/** 竖段宽过线宽这么多倍算粗线（复纵线、终止线的粗线）。 */
const THICK_BAR = 2.5;
/** 端带：端点往外、往里各这么多格以内的音高位置。 */
const SEED_OUT = 0.5;
const SEED_IN = 1.25;
/** 头心横向微调半宽（格）。 */
const SEED_XW = 0.15;

export function hollowHeadsOnStemSeeds(
  bin: Binary,
  nl: Binary,
  rawHoles: Rect[],
  allMasks: HeadMask[],
  unit: RasterUnit,
  stepsIn: (y0: number, y1: number) => PitchStep[],
  stems: LineSeg[],
  syms: { box: Rect; code: string }[],
  beams: Rect[],
  isBar: (s: LineSeg) => boolean,
  /** 盒落在行首谱号、调号区里 */
  inHeader: (b: Rect) => boolean,
): { box: Rect; code: SmuflName; weak?: boolean }[] {
  if (!allMasks.length) return [];
  const sp = unit.space;
  const { enclosed, bestMasked, clash, inkIn, cavity } = pitchScorer(bin, nl, rawHoles, allMasks, unit, stems);
  const heads = syms.filter((s) => s.code.startsWith("notehead"));
  const halves = heads.filter((s) => s.code === "noteheadHalf");
  const w = halves.length ? median(halves.map((q) => q.box.w)) : Math.round(sp * 1.3);
  const h = halves.length ? median(halves.map((q) => q.box.h)) : Math.round(sp * 1.1);
  const taken = heads.map((q) => q.box);
  const out: { box: Rect; code: SmuflName; weak?: boolean }[] = [];
  const tol = Math.max(unit.lineThick * 2, sp * 0.25);
  const seen = new Set<string>();
  for (const v of stems) {
    const vx = (v.x0 + v.x1) / 2;
    const top = Math.min(v.y0, v.y1);
    const bot = Math.max(v.y0, v.y1);
    const len = bot - top;
    // 复纵线的粗线不当干，细粗两线之间的白也不是内腔（f40 m10 低音收进两个假二分）
    const thick = (u: LineSeg) => u.lw > unit.lineThick * THICK_BAR;
    if (len < sp * SEED_LEN[0] || len > sp * SEED_LEN[1] || isBar(v) || thick(v)) continue;
    // 同一根干在几张表里各有一份
    const key = `${Math.round(vx / 2)}:${Math.round(top / 4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 干上（含两端外一格）已挂着头的交给沿干找头
    if (taken.some((t) => Math.min(Math.abs(t.x - vx), Math.abs(t.x + t.w - vx)) <= sp * 0.4 && t.y + t.h / 2 >= top - sp && t.y + t.h / 2 <= bot + sp)) continue;
    // 短段在行首段里多是调号降号的竖笔，而调号此时常只认出头一个（倚靠主永远膀臂第二页行首，2.7 格的竖笔、模板落进前一个降号的圆肚）：
    // 同一高度带（中点上下 4 格）左边一个认出的头都没有的短段不找
    const mid = (top + bot) / 2;
    if (len < sp * SEED_SHORT && !heads.some((q) => q.box.x + q.box.w < vx - sp && Math.abs(q.box.y + q.box.h / 2 - mid) <= sp * 4)) continue;
    // 端头扎进符杠、挂着符尾的不是二分的干
    if (beams.some((q) => vx >= q.x - tol && vx <= q.x + q.w + tol && ((top >= q.y - tol && top <= q.y + q.h + tol) || (bot >= q.y - tol && bot <= q.y + q.h + tol)))) continue;
    if (syms.some((q) => /^(flag|accidental)/.test(q.code) && q.box.x <= vx + tol && q.box.x + q.box.w >= vx - tol && q.box.y <= bot && q.box.y + q.box.h >= top)) continue;
    const picks: { box: Rect; s: number }[] = [];
    for (const end of ["top", "bot"] as const) {
      const e = end === "top" ? top : bot;
      const cx = end === "top" ? vx + w / 2 : vx - w / 2;
      const steps = end === "top" ? stepsIn(e - sp * SEED_OUT, e + sp * SEED_IN) : stepsIn(e - sp * SEED_IN, e + sp * SEED_OUT);
      for (const st of steps) {
        const b = bestMasked(st, cx - sp * SEED_XW, cx + sp * SEED_XW, vx);
        if (!b || b.s < ALONG_SCORE) continue;
        const ink = inkIn(b.x, b.y, w);
        if (ink < ALONG_INK[0] || ink > ALONG_INK[1]) continue;
        const enc = enclosed(b.x, b.y);
        // 不到 `SEED_SHORT` 格的短段只认行向围合：原始孔作证的会把实心头边上的白收进来（万古磐石歌 m8：漏认的八分 F3 旁，内腔 0.76、围合 0.12）
        if (!((cavity(b.x, b.y) >= ALONG_CAVITY && enc >= ALONG_ENCLOSED_MIN && len >= sp * SEED_SHORT) || enc >= ALONG_ENCLOSED)) continue;
        const box: Rect = { x: end === "top" ? Math.round(vx) : Math.round(vx - w), y: Math.round(st.y - h / 2), w, h };
        // 落在行首谱号、调号区里的不收
        if (inHeader(box)) continue;
        if (stems.some((u) => thick(u) && (u.x0 + u.x1) / 2 > box.x && (u.x0 + u.x1) / 2 < box.x + box.w && Math.min(u.y0, u.y1) < box.y + box.h && Math.max(u.y0, u.y1) > box.y)) continue;
        picks.push({ box, s: b.s });
      }
    }
    // 端带里过了门槛的都收（三度叠头两个都在端带里），按模板分先后、与已收的相邻一级让位
    picks.sort((p, q) => q.s - p.s);
    for (const p of picks) {
      if (clash(p.box, taken)) continue;
      out.push({ box: p.box, code: "noteheadHalf", weak: true });
      taken.push(p.box);
    }
  }
  return out;
}

export function hollowHeadsAlongStems(
  bin: Binary,
  nl: Binary,
  rawHoles: Rect[],
  allMasks: HeadMask[],
  unit: RasterUnit,
  stepsIn: (y0: number, y1: number) => PitchStep[],
  stems: LineSeg[],
  heads: { box: Rect; code: string }[],
): { box: Rect; code: SmuflName; weak?: boolean }[] {
  const sp = unit.space;
  const { enclosed, bestMasked, clash, inkIn, cavity } = pitchScorer(bin, nl, rawHoles, allMasks, unit, stems);
  const tol = Math.max(unit.lineThick * 2, sp * 0.25);
  const out: { box: Rect; code: SmuflName; weak?: boolean }[] = [];
  const taken = heads.map((h) => h.box);
  const cyOf = (h: { box: Rect }) => h.box.y + h.box.h / 2;
  const ranges: { ref: { box: Rect }; vx: number; y0: number; y1: number; end?: number; beyond?: boolean; third?: boolean; tip?: boolean }[] = [];
  for (const v of stems) {
    const vx = (v.x0 + v.x1) / 2;
    const top = Math.min(v.y0, v.y1);
    const bot = Math.max(v.y0, v.y1);
    if (bot - top < sp * 1.5) continue;
    for (const h of heads) {
      // 叠头的盒是按内腔外扩出来的，缘离干常差出半个线宽：「干外一格」那一条容差放到 0.4 格（太阳颂 m2 差 0.27 格）；
      // 别的几条照旧——都放宽的话合唱谱扫描档音符 80.66 → 79.94
      const tolX = Math.max(tol, sp * 0.4);
      const edge = Math.min(Math.abs(h.box.x + h.box.w - vx), Math.abs(h.box.x - vx));
      if (h.code !== "noteheadHalf" || edge > tolX) continue;
      const strict = edge <= tol;
      const hy = cyOf(h);
      if (hy >= top - sp * 0.5 && hy <= bot + sp * 0.5) {
        const nearBot = Math.abs(bot - hy) <= Math.abs(top - hy);
        // **干就断在这个头上**：再往外一个三度处可能还叠着一个没认出的头——两声部的二分三度，两个圈连成一块，
        // 竖段只抽到上面那个头为止（新编赞美诗 14 太阳颂 m2 的 E♭4/G4：干到 G4 就断，底下的 E♭4 没认）。
        // 只看往外一格那一个位置，门槛同别处。
        if (Math.abs((nearBot ? bot : top) - hy) <= sp * 0.6) {
          ranges.push(nearBot ? { ref: h, vx, y0: hy + sp * 0.75, y1: hy + sp * 1.25, beyond: true } : { ref: h, vx, y0: hy - sp * 1.25, y1: hy - sp * 0.75, beyond: true });
          // **往干里一个三度**：闭合谱两声部的二分三度（「8」字叠头）共一根干，下一个头离干端的头正好一格；正常长的干（3.5 格）
          // 过不了下面「自由端 ALONG_FREE 格不找」那道，这一级永远搜不到（新编赞美诗 001 m4 的 E♭4/G4：干 3.4 格，G4 离干顶 2.4 格；
          // 全书漏掉的空心头里三度叠头九百多个）。门槛同「干外一格」
          ranges.push(nearBot ? { ref: h, vx, y0: hy - sp * 1.25, y1: hy - sp * 0.75, beyond: true, third: true } : { ref: h, vx, y0: hy + sp * 0.75, y1: hy + sp * 1.25, beyond: true, third: true });
        }
        if (!strict) continue;
        // 头挂在干的一端：往另一端（自由端）找，到自由端往回 ALONG_FREE 格为止
        if (bot - top < sp * (ALONG_FREE + 1)) continue;
        if (nearBot) ranges.push({ ref: h, vx, y0: top + sp * ALONG_FREE, y1: hy - sp * 0.75 });
        else ranges.push({ ref: h, vx, y0: hy + sp * 0.75, y1: bot - sp * ALONG_FREE });
        // 头悬在干中段（离近端也有 ALONG_MID 格以上）：近端挂着的是没认出的和弦头（我灵镇静 m10，
        // F4 上下缘正压两条谱线、内腔够不上，上面的 C5 认出来却在干中段）——近端那头也找
        const near = nearBot ? bot : top;
        if (Math.abs(near - hy) >= sp * ALONG_MID)
          ranges.push(nearBot ? { ref: h, vx, y0: hy + sp * 0.75, y1: bot + sp * 0.3, end: bot } : { ref: h, vx, y0: top - sp * 0.3, y1: hy - sp * 0.75, end: top });
        // **干穿过这个头、又多伸出一格**（离近端 0.75~1.5 格）：干不会白伸出去，端上还挂着一个三度的头——闭合谱两声部的二分三度，
        // 认出的是靠里那个（新编赞美诗 157 m11 两行、138 m9、254 m12、355 m9）。只看干端那一级
        else if (Math.abs(near - hy) >= sp * 0.75)
          ranges.push(nearBot ? { ref: h, vx, y0: bot - sp * 0.3, y1: bot + sp * 0.3, end: bot, third: true, tip: true } : { ref: h, vx, y0: top - sp * 0.3, y1: top + sp * 0.3, end: top, third: true, tip: true });
      } else if (!strict) {
        continue;
      } else if (hy > bot && hy - bot <= sp * ALONG_GAP) {
        // 干断在头上方：中间夹着没认出的和弦头（干被叠头的圈切断）
        ranges.push({ ref: h, vx, y0: bot - sp * 0.3, y1: hy - sp * 0.75 });
      } else if (hy < top && top - hy <= sp * ALONG_GAP) {
        ranges.push({ ref: h, vx, y0: hy + sp * 0.75, y1: top + sp * 0.3 });
      }
    }
  }
  for (const { ref, vx, y0, y1, end, beyond, third, tip } of ranges) {
    if (y1 <= y0) continue;
    const cx = ref.box.x + ref.box.w / 2;
    for (const st of stepsIn(y0, y1)) {
      // 干端那一级：干必挂着头，模板分放宽；干端以外的位置照常
      const atEnd = end !== undefined && Math.abs(st.y - end) <= sp * ALONG_END_TOL;
      // 模板沿用本页对齐过的空心模板，谱线行与这根干的列不计（`scoreAtMasked`）；墨占比、内腔都在微调后的头心上量
      // 本页一张空心模板都凑不出时（空心头太少），只按墨判
      const b = allMasks.length ? bestMasked(st, cx - sp * ALONG_XW, cx + sp * ALONG_XW, vx) : { x: Math.round(cx), s: 1, y: st.y };
      if (!b) continue;
      const ink = inkIn(b.x, b.y, ref.box.w);
      const cav = cavity(b.x, b.y);
      // 干外那一格：模板分够高（`BEYOND_SCORE`）时内腔佐证放到 `BEYOND_CAVITY`——斜缝内腔被谱线切碎，够不上原始孔的尺寸
      const cavMin = beyond && b.s >= BEYOND_SCORE ? BEYOND_CAVITY : ALONG_CAVITY;
      // 往干里一个三度那一级：两个头粘成「8」字，模板对不齐（001 m4 G4 0.23），内腔佐证够强（≥ `THIRD_CAVITY`）时模板分放到 `THIRD_SCORE`
      const minS = third && cav >= THIRD_CAVITY ? THIRD_SCORE : atEnd ? ALONG_END_SCORE : ALONG_SCORE;
      // 干端那一级、模板与内腔都够硬的（`END_THIN`）：细圈的头墨占比够不上 0.35（新编赞美诗 141 m10 干端的 D4：模板 0.43、内腔 0.63、墨 0.32）
      const inkMin = atEnd && b.s >= END_THIN.score && cav >= END_THIN.cavity ? END_THIN.ink : ALONG_INK[0];
      if (b.s < minS || ink < inkMin || ink > ALONG_INK[1]) continue;
      // 内腔佐证来自原始孔、行向却一点不围合的：原始孔里有谱线之间被干、小节线围成的大格，空着的线间挨着下面一个头，
      // 模板分也有 0.3、内腔佐证 0.66、围合 0.02（高举主大能 m13）。只滤大孔反倒伤圈断口、内腔连进线间的真头（新编 059、070）
      if (cav >= cavMin && enclosed(b.x, b.y) < ALONG_ENCLOSED_MIN) continue;
      const box: Rect = { x: Math.round(b.x - ref.box.w / 2), y: Math.round(st.y - ref.box.h / 2), w: ref.box.w, h: ref.box.h };
      // 近干那条盒缘钉在干上：盒宽照搬参照头，头心又微调过，盒缘常越过干好几像素，后面挂干（`findStems` 两倍线宽的窗口）挂不上，
      // 两个头都落成全音符（027 m5 的 F4/D4：盒右缘过干 8 像素）
      if (Math.abs(box.x + box.w - vx) <= Math.abs(box.x - vx)) box.x = Math.round(vx - box.w);
      else box.x = Math.round(vx);
      // **内腔印糊了的头**：同一根干上挂着二分头，这根干上别的头也只能是二分（一根干不会一半空心一半实心），
      // 内腔不作证也行（新编赞美诗 346 m12/m14 低音谱表 A3 压着第五线、圈里糊满，内腔 0、模板 0.37、墨 0.43）。
      // 只防「夹在两个头中间」那个位置（墨量也像头心，恩友歌）：上下 `ALONG_SANDWICH` 格内同时有已认出的头的不放宽。
      const near = (dir: number) => taken.some((t) => {
        const d = (t.y + t.h / 2 - st.y) * dir;
        return d > 0 && d <= sp * ALONG_SANDWICH && Math.abs(t.x + t.w / 2 - b.x) < sp * 0.6;
      });
      // 圈断了口、内腔不成闭合孔的细圈头：行向围合的白够（`ALONG_ENCLOSED`）也算内腔作证，同样防「夹在两头中间」
      // 「干外一格」那档不认：干端外空着时，下一根干或符尾也能围出白来（晨曦破晓 m8：模板 0.36、围合 0.40，多出 E4）
      const encOk = !beyond && enclosed(b.x, b.y) >= ALONG_ENCLOSED && !(near(1) && near(-1));
      if (cav < cavMin && !encOk) {
        // 干多伸出一格的那个端头：位置已由干钉死，模板分够高（`TIP_SCORE`）就不再要墨占比到「印糊」那一档
        if (b.s < ALONG_FILLED_SCORE || ink > ALONG_FILLED_INK_MAX || (ink < ALONG_FILLED_INK && !(tip && b.s >= TIP_SCORE)) || (near(1) && near(-1))) continue;
      }
      if (clash(box, taken)) continue;
      out.push({ box, code: "noteheadHalf", weak: true });
      taken.push(box);
    }
  }
  return out;
}

// ── 空心头：**沿加线按音高位置配模板** ──────────────────────────────────────
//
// 谱表外骑着加线的斜缝空心头（赞美三一真神末三小节：C4、C4/A3、C4/G3、D4/C4 二度错排），
// 内腔是一道斜缝，被加线横着切成左上、右下两截，两截横向几乎不交叠，`mergeHoles` 并不起来，
// 两端又被干封住；按内腔找、按模板再搜都认不出。Audiveris 在加线上也是逐位置配模板：
// 这里拿**没压着头的加线**当候选，在它本身和上下两个间位上逐位置打分，x 沿加线扫。

/** 加线候选的长度（格）：一个头宽出一点到两个头（二度错排）。 */
const LEDGER_LEN = [1.2, 2.8] as const;
/** 加线上的头的模板得分门槛。扫过 0.25 / 0.30 / **0.35** / 0.40：九首合计 94.53 / 94.53 / **94.53** / 94.43%；
 *  合唱谱（内腔 0.25 时）0.30 那档干净版按 staff 映射掉 0.08 点（加线旁的误收）；0.35 配内腔 0.30/0.35，
 *  干净档 85.43 → 85.50%、扫描档不降。 */
const LEDGER_SCORE = 0.35;
/** 加线上的头的内腔佐证：斜缝被切成小片，比叠头那一路（0.5）低——赞美三一真神那几个真头实测 0.36~0.39。
 *  扫过 0.15 / 0.25 / **0.30** / 0.35，九首与合唱谱都一样，取离真头留点余量的一档。 */
const LEDGER_CAVITY = 0.3;

export function hollowHeadsOnLedgers(
  bin: Binary,
  nl: Binary,
  rawHoles: Rect[],
  allMasks: HeadMask[],
  unit: RasterUnit,
  ledgers: { x0: number; x1: number; y: number }[],
  stepsIn: (y0: number, y1: number) => PitchStep[],
  stems: LineSeg[],
  taken: Rect[],
  /** 出参：靠墨柱判出来的干（竖段表里没有，`buildNotes` 定时值要用）。 */
  inkStems: LineSeg[],
): { box: Rect; code: SmuflName; weak?: boolean }[] {
  const sp = unit.space;
  if (!allMasks.length) return [];
  const { cavity, best, codeOf } = pitchScorer(bin, nl, rawHoles, allMasks, unit, stems);
  const out: { box: Rect; code: SmuflName; weak?: boolean }[] = [];
  const bw = Math.round(sp * 1.3);
  const headH = Math.round(sp * 1.1);
  const picked: Rect[] = [];
  const cands: { x: number; y: number; s: number }[] = [];
  for (const l of ledgers) {
    const len = (l.x1 - l.x0) / sp;
    if (len < LEDGER_LEN[0] || len > LEDGER_LEN[1]) continue;
    for (const st of stepsIn(l.y - sp * 0.7, l.y + sp * 0.7)) {
      const b = best(st, l.x0 + sp * 0.4, l.x1 - sp * 0.4);
      if (!b || b.s < LEDGER_SCORE) continue;
      const cv = cavity(b.x, st.y);
      if (cv < LEDGER_CAVITY) continue;
      cands.push({ x: b.x, y: st.y, s: b.s });
    }
  }
  cands.sort((a, b) => b.s - a.s);
  // 二度错排的两个头（m15 的 D4/C4）横向只差一个头宽，`clash` 的「横向压着」会把它们判成同一个；
  // 相邻音级（差半格）只在横向差不到 0.6 个头宽时才算重叠——照 Audiveris `HeadInter.overlaps`
  const second = (b: Rect, list: Rect[]) =>
    list.some((t) => {
      const dy = Math.abs(t.y + t.h / 2 - (b.y + b.h / 2));
      const dx = Math.abs(t.x + t.w / 2 - (b.x + b.w / 2));
      return dy < sp * 0.25 ? dx < (t.w + b.w) / 2 - sp * 0.2 : dy < sp * 0.75 && dx < ((t.w + b.w) / 2) * 0.6;
    });
  for (const c of cands) {
    const box: Rect = { x: Math.round(c.x - bw / 2), y: Math.round(c.y - headH / 2), w: bw, h: headH };
    if (second(box, picked) || second(box, taken)) continue;
    picked.push(box);
  }
  for (const box of picked) {
    const c = codeOf(box, picked);
    if (!c) continue;
    out.push({ box, code: c.code, weak: true });
    if (c.ink) inkStems.push(c.ink);
    taken.push(box);
  }
  return out;
}

/**
 * 竖段表之外、直接在图上量的符干：盒左右缘附近各列，从盒中心往上下沿墨走（断口 ≤2 像素），
 * 取纵向最长的一列，返回 `[上端, 下端, 列 x]`。
 */
export function inkColumn(nl: Binary, b: Rect, unit: RasterUnit, sided = false): [number, number, number] | null {
  const tol = Math.round(Math.max(unit.lineThick * 2, unit.space * 0.25));
  const cy = Math.round(b.y + b.h / 2);
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < nl.w && y < nl.h && nl.data[y * nl.w + x] === 1;
  const walk = (x: number, dir: number): number => {
    let last = cy;
    for (let y = cy, miss = 0; miss <= 2 && y >= 0 && y < nl.h; y += dir) {
      if (at(x, y)) {
        last = y;
        miss = 0;
      } else miss++;
    }
    return last;
  };
  let best: [number, number, number] | null = null;
  for (const edge of [b.x, b.x + b.w]) {
    for (let x = Math.round(edge) - tol; x <= Math.round(edge) + tol; x++) {
      // `sided`：左缘只量往下的、右缘只量往上的（朝下的干挂头左缘、朝上的挂右缘）
      const top = sided && edge === b.x ? cy : walk(x, -1);
      const bottom = sided && edge !== b.x ? cy : walk(x, 1);
      if (!best || bottom - top > best[1] - best[0]) best = [top, bottom, x];
    }
  }
  return best;
}

/** 贴着盒左右缘、纵向穿过盒的竖段（不管盒在段的哪一截）。 */
function stemThrough(b: Rect, stems: LineSeg[], unit: RasterUnit): LineSeg | null {
  const tol = Math.max(unit.lineThick * 2, unit.space * 0.25);
  for (const s of stems) {
    const x = (s.x0 + s.x1) / 2;
    if (Math.abs(x - b.x) > tol && Math.abs(x - (b.x + b.w)) > tol) continue;
    if (Math.max(s.y0, s.y1) < b.y + b.h / 2 || Math.min(s.y0, s.y1) > b.y + b.h / 2) continue;
    return s;
  }
  return null;
}

function overlaps(a: Rect, b: Rect, tol: number): boolean {
  return Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < tol + (a.w + b.w) / 4 && Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < tol + (a.h + b.h) / 4;
}

// ── **光杆符干端头的无主墨**（叠成「8」字的三度空心和弦，以及漏掉的单个头）────────
//
// 这套字体（圈粗、内腔是一道斜缝）的三度空心和弦，两个内腔的斜缝常通到圈外，
// `findHoles` 连一个闭合孔都取不到，按内腔找的三路都进不来；取得到孔的，按音高配模板
// 也只打到 0.27~0.29（门槛 0.30）——页内自举的空心模板太糊，把两张模板合成一张给一对位置整体打分
// 也只有 0.27（试过撤了）。去谱线又把这团墨切成几片，按单块判也不成。
// 于是整团墨无人认领（齐来谢主歌、我灵镇静、父恩广大）。
//
// 先验取**符干**：一根够长的干、两端都没挂上符头，本身就是「这里漏了音」
//（干朝下的和弦中段的头常认得出、只漏端头那个，所以只看两端）。在端头一侧收拢无主碎片：
// 一个头宽、一个或两个头高，头心在原图里是空的就落空心头，一个头高且头心实的落实心头。
/** 光杆干的长度（格）：下限挡符尾碎段，上限挡系统左端的连谱线。 */
const BARE_LEN = [2.5, 6] as const;
/** 比这还小的碎片不收（附点、噪点）。 */
const DOT_MAX = 0.45;

export interface BareStemProbe {
  stem: LineSeg;
  /** 这根「干」形同小节线（两端正落在首末线上）。 */
  bar?: boolean;
  end: "top" | "bottom";
  box: Rect;
  area: number;
  ids: number[];
}

/**
 * 同一列上下几截竖段（隔着不到一格）合起来贯穿整个谱表的，是被别的笔画切断的小节线：跨小节线的连音线把它切成两截，
 * 单看一截不像小节线，当了光杆干，弧尾收成了头（我灵镇静 m5、低音 m5/m18 读出一个 C5/E3/F3）。
 */
function barPiece(s: LineSeg, stems: LineSeg[], isBar: (s: LineSeg) => boolean, unit: RasterUnit): boolean {
  const xOf = (q: LineSeg) => (q.x0 + q.x1) / 2;
  let top = Math.min(s.y0, s.y1);
  let bot = Math.max(s.y0, s.y1);
  const col = stems.filter((t) => Math.abs(xOf(t) - xOf(s)) <= unit.lineThick + 1);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of col) {
      const a = Math.min(t.y0, t.y1);
      const b = Math.max(t.y0, t.y1);
      if (b < top - unit.space || a > bot + unit.space || (a >= top && b <= bot)) continue;
      top = Math.min(top, a);
      bot = Math.max(bot, b);
      grew = true;
    }
  }
  return (top < Math.min(s.y0, s.y1) || bot > Math.max(s.y0, s.y1)) && isBar({ ...s, y0: top, y1: bot });
}

export function probeBareStems(
  stems: LineSeg[],
  heads: Rect[],
  free: { id: number; box: Rect; area: number }[],
  unit: RasterUnit,
  isBar: (s: LineSeg) => boolean,
  /** 叠头和弦的短干：墨团连着干本身，中心常落在窗口外；盒把干端包在里面的也收 */
  attached = false,
): BareStemProbe[] {
  const sp = unit.space;
  const out: BareStemProbe[] = [];
  for (const s of stems) {
    const top = Math.min(s.y0, s.y1);
    const bot = Math.max(s.y0, s.y1);
    if (bot - top < sp * BARE_LEN[0] || bot - top > sp * BARE_LEN[1]) continue;
    // 形同小节线（两端正落在首末线上）的：压第一线 / 第五线的二分音符，干长 3.5 格，正好也是首线到末线
    //（新编赞美诗 002 m17 的 E4/G4「8」字叠头）。端头**贴着**一团符头大小的墨（盒的近干一边离干 0.3 格内）才当干，否则照旧当小节线
    const barLike = isBar(s);
    if (!barLike && barPiece(s, stems, isBar, unit)) continue;
    const sx = (s.x0 + s.x1) / 2;
    /** 端头挂着头。只看两端不看中段：干朝下的和弦，中段的头照常认得出、只有端头那个漏了。 */
    const headAt = (e: number) =>
      heads.some((h) => Math.abs(h.x + h.w / 2 - sx) < sp * 1.6 && Math.abs(h.y + h.h / 2 - e) < sp * 1.2);
    for (const end of ["top", "bottom"] as const) {
      const e = end === "top" ? top : bot;
      // 另一端挂着头的，这一端是干的自由端（符尾就挂在这里，别当成头）
      if (headAt(e) || headAt(end === "top" ? bot : top)) continue;
      const y0 = end === "top" ? e - sp * 0.9 : e - sp * 2.0;
      const y1 = end === "top" ? e + sp * 2.0 : e + sp * 0.9;
      // 干朝上（光杆的是下端）头在干左，干朝下头在干右；另一侧的附点、邻音不收
      const x0 = end === "bottom" ? sx - sp * 1.8 : sx - sp * 0.3;
      const x1 = end === "bottom" ? sx + sp * 0.3 : sx + sp * 1.8;
      const got = free.filter((f) => {
        const cx = f.box.x + f.box.w / 2;
        const cy = f.box.y + f.box.h / 2;
        if (f.box.w < sp * DOT_MAX && f.box.h < sp * DOT_MAX) return false;
        if (attached && sx >= f.box.x - 2 && sx <= f.box.x + f.box.w + 2 && e >= f.box.y - 2 && e <= f.box.y + f.box.h + 2) return true;
        return cx > x0 && cx < x1 && cy > y0 && cy < y1;
      });
      if (!got.length) continue;
      let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity, area = 0;
      for (const f of got) {
        l = Math.min(l, f.box.x);
        r = Math.max(r, f.box.x + f.box.w);
        t = Math.min(t, f.box.y);
        b = Math.max(b, f.box.y + f.box.h);
        area += f.area;
      }
      if (barLike) {
        const touch = end === "bottom" ? Math.abs(r - sx) <= sp * 0.3 : Math.abs(l - sx) <= sp * 0.3;
        if (!touch || r - l < sp * BARE_W[0] || b - t < sp * BARE_H1[0]) continue;
      }
      out.push({ stem: s, end, box: { x: l, y: t, w: r - l, h: b - t }, area, ids: got.map((f) => f.id), bar: barLike || undefined });
    }
  }
  return out;
}

/**
 * **两根光杆干夹着一个头**：两声部同音共用一个符头，干一上一下——朝上那根贴在头的右边、下端落在头心，朝下那根贴在头的左边、上端落在头心
 *（新编赞美诗五线谱 026 m2 低音谱表的 A♭3 二分音符：头压在第五线上，圈被去谱线切碎，收拢不出一个头大小的墨，端头收墨那一路进不来）。
 * 两根干的这两端都没挂上头、横向隔一个头宽（0.8~1.7 格）、纵向对齐（差 ≤0.7 格），中间就是那个头；盒里（谱线行不算）得有墨。
 * 头心空的落空心头，实的落实心头。头盒取本页空心头的中位尺寸。
 */
export function headsBetweenStemPairs(
  stems: LineSeg[],
  heads: Rect[],
  unit: RasterUnit,
  snap: (y: number) => number | null,
  size: { w: number; h: number },
  bin: Binary,
  onLine: (y: number) => boolean,
  isBar: (s: LineSeg) => boolean,
): { box: Rect; code: SmuflName; ids: number[]; weak: true }[] {
  const sp = unit.space;
  const out: { box: Rect; code: SmuflName; ids: number[]; weak: true }[] = [];
  const xOf = (s: LineSeg) => (s.x0 + s.x1) / 2;
  const cand = stems.filter((s) => { const len = Math.abs(s.y1 - s.y0); return len >= sp * 2 && len <= sp * BARE_LEN[1] && !isBar(s) && !barPiece(s, stems, isBar, unit); });
  const headAt = (x: number, y: number) => heads.some((h) => Math.abs(h.x + h.w / 2 - x) < sp * 1.6 && Math.abs(h.y + h.h / 2 - y) < sp * 1.2);
  const inkIn = (cx: number, cy: number, w: number, h: number): number => {
    let n = 0, ink = 0;
    for (let y = Math.round(cy - h / 2); y <= Math.round(cy + h / 2); y++) {
      if (y < 0 || y >= bin.h || onLine(y)) continue;
      for (let x = Math.round(cx - w / 2); x <= Math.round(cx + w / 2); x++) {
        if (x < 0 || x >= bin.w) continue;
        n++;
        if (bin.data[y * bin.w + x]) ink++;
      }
    }
    return n ? ink / n : 0;
  };
  const used = new Set<LineSeg>();
  for (const up of cand) {
    if (used.has(up)) continue;
    const ux = xOf(up), uy = Math.max(up.y0, up.y1), uTop = Math.min(up.y0, up.y1);
    if (headAt(ux, uy) || headAt(ux, uTop)) continue;
    for (const dn of cand) {
      if (dn === up || used.has(dn)) continue;
      const dx = xOf(dn), dy = Math.min(dn.y0, dn.y1), dBot = Math.max(dn.y0, dn.y1);
      if (ux - dx < sp * 0.8 || ux - dx > sp * 1.7 || Math.abs(uy - dy) > sp * 0.7) continue;
      if (headAt(dx, dy) || headAt(dx, dBot)) continue;
      const cx = (ux + dx) / 2;
      const cy = snap((uy + dy) / 2) ?? (uy + dy) / 2;
      const fill = inkIn(cx, cy, size.w * 0.9, size.h * 0.9);
      if (fill < 0.12) continue;
      const core = inkIn(cx, cy, sp * 0.6, sp * 0.4);
      const box = { x: Math.round(cx - size.w / 2), y: Math.round(cy - size.h / 2), w: size.w, h: size.h };
      // 网纹印的实心头里散着白点，头心墨占比到不了 `BARE_SOLID`（我灵镇静 m22 B♭4/G4 四分读成全音符）：
      // 最大的一块封闭白不到头盒的 `BARE_HOLE` 也算实心——空心头的内腔是整整一块
      const solid = core >= BARE_SOLID || largestHole(bin, box, onLine) < box.w * box.h * BARE_HOLE;
      out.push({ box, code: solid ? "noteheadBlack" : "noteheadHalf", ids: [], weak: true });
      used.add(up); used.add(dn);
      break;
    }
  }
  return out;
}

/** 光杆干端头收拢出来的墨，够得上一个 / 两个（三度叠头）头的尺寸（格）与填充。 */
const BARE_W = [0.8, 1.6] as const;
const BARE_H1 = [0.8, 1.35] as const;
const BARE_H2 = [1.6, 2.5] as const;
const BARE_FILL = [0.15, 0.6] as const;
/** 头心墨占比：空心头的斜缝内腔实测 0.0~0.51（我灵镇静一处糊的 0.74），实心头 1.0。扫过 0.7 / **0.8**：92.10 / 92.14%。 */
const BARE_CORE = 0.8;
/** 压线头按放宽的窗口量头心时，判空心的上限。 */
const BARE_CORE_WIDE = 0.62;
/** 一个头高、头心墨占比到这么多才落实心头。 */
const BARE_SOLID = 0.9;
/** 两干夹头那一路：盒里最大一块封闭白占盒的比例不到这么多算实心（网纹实心头，见用处）。 */
const BARE_HOLE = 0.06;
/** 按封闭白判网纹实心头时，头心墨占比的下限（网纹本身只有一半上下是墨：我灵镇静 m22 0.48~0.55）。 */
const BARE_NETTED = 0.45;

/** 盒里不碰盒边的白连通块（谱线行算白）中最大的一块像素数。 */
function largestHole(bin: Binary, b: Rect, onLine: (y: number) => boolean, linesInk = true): number {
  const W = b.w;
  const H = b.h;
  if (W <= 2 || H <= 2) return 0;
  const white = (x: number, y: number) => {
    const X = b.x + x;
    const Y = b.y + y;
    return X < 0 || Y < 0 || X >= bin.w || Y >= bin.h || (linesInk && onLine(Y)) ? false : !bin.data[Y * bin.w + X] || onLine(Y);
  };
  const seen = new Uint8Array(W * H);
  let best = 0;
  for (let y0 = 0; y0 < H; y0++)
    for (let x0 = 0; x0 < W; x0++) {
      if (seen[y0 * W + x0] || !white(x0, y0)) continue;
      let n = 0;
      let edge = false;
      const stack = [x0, y0];
      seen[y0 * W + x0] = 1;
      while (stack.length) {
        const y = stack.pop()!;
        const x = stack.pop()!;
        n++;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny * W + nx] || !white(nx, ny)) continue;
          seen[ny * W + nx] = 1;
          stack.push(nx, ny);
        }
      }
      if (!edge) best = Math.max(best, n);
    }
  return best;
}

/**
 * 光杆干端头 → 空心头（一个，或三度叠着的两个），或一个实心头（被连音线之类粘住漏掉的四分，晨曦破晓）。
 * `snap` 把 y 吸到线/间中心。头心判空实（`core`）：填充比挡不住被去谱线切过的实心头
 *（晨曦破晓两声部同音共用一个实心头，朝下那根干被当成光杆）。
 * 头盒取本页已认空心头的尺寸（`size`）、以收拢墨的中心定位：收拢出来的墨被去谱线啃过，
 * 照它的外框出盒偏窄，混进后面「空心头按模板再搜」的样本与中位尺寸，会把别处的头带偏（齐来谢主歌实测丢两个）。
 */
export function headsOnBareStems(
  probes: BareStemProbe[],
  unit: RasterUnit,
  snap: (y: number) => number | null,
  size: { w: number; h: number },
  bin: Binary,
  onLine: (y: number) => boolean,
): { box: Rect; code: SmuflName; ids: number[]; weak: true }[] {
  const sp = unit.space;
  /** 头心一小块（0.6×0.4 格）在原图里的墨占比，谱线那几行不算。实心头近 1，空心头的斜缝内腔低得多。 */
  /** 加线行：穿过头心的连续墨段横贯 1.8 格以上、两端是薄的（加线穿过头心，是爱 p1 m3 A5）；只数墨点总数的话实心头连着旁边的墨也够数（破碎扫描版 p3 m39） */
  const ledgerRow = (cx: number, y: number): boolean => {
    const ink = (x: number) => x >= 0 && x < bin.w && bin.data[y * bin.w + x] === 1;
    const x0 = Math.round(cx);
    if (!ink(x0)) return false;
    let a = x0, b = x0;
    while (ink(a - 1)) a--;
    while (ink(b + 1)) b++;
    if (b - a + 1 < sp * 1.8) return false;
    // 还得是薄的：墨段两端那一列上下 0.3 格外是白的（网点符杠也横贯头心，杠那几行跳过了就把杠端量成空心头，耶和华是我的牧者 p2）
    const k = Math.max(2, Math.round(sp * 0.3));
    const white = (x: number) => [y - k, y + k].every((yy) => yy < 0 || yy >= bin.h || !bin.data[yy * bin.w + x]);
    return white(a + 1) && white(b - 1);
  };
  // 压线的头，±0.2 格里几乎全是线行（是爱 p1 m3 F5 只剩一行、落在圈边上），可量的行不到三行就再按 ±0.35 格量一次：
  // 返回 [判空心用的, 判实心用的]。宽窗口量到圈边，判空心要过更紧的 `BARE_CORE_WIDE`（空心 0.58/0.60，
  // 压线带白点的实心 0.67/0.78，破碎扫描版 p9 m93、p11 m100）；判实心取两者大的（压线的实心头 0.885，p3 m39）
  const core = (cx: number, cy: number, half = 0.2): [number, number] => {
    let n = 0;
    let ink = 0;
    let rows = 0;
    for (let y = Math.round(cy - sp * half); y <= Math.round(cy + sp * half); y++) {
      if (y < 0 || y >= bin.h || onLine(y) || ledgerRow(cx, y)) continue;
      rows++;
      for (let x = Math.round(cx - sp * 0.3); x <= Math.round(cx + sp * 0.3); x++) {
        if (x < 0 || y < 0 || x >= bin.w || y >= bin.h) continue;
        n++;
        if (bin.data[y * bin.w + x]) ink++;
      }
    }
    const v = n ? ink / n : 1;
    if (rows < 3 && half < 0.35) {
      const [w] = core(cx, cy, 0.35);
      return [Math.min(v, w <= BARE_CORE_WIDE ? w : 1), Math.max(v, w)];
    }
    return [v, v];
  };
  const out: { box: Rect; code: SmuflName; ids: number[]; weak: true }[] = [];
  const used = new Set<number>();
  /** 一块墨按尺寸判成一个 / 两个头（y 与空实）；判不成返回 null。 */
  /** 头心上下 0.25 格内（谱线行不算）墨最宽的那一行有多宽（盒的横向范围内）。 */
  const widest = (box: Rect, y: number): number => {
    let most = 0;
    for (let yy = Math.round(y - sp * 0.25); yy <= Math.round(y + sp * 0.25); yy++) {
      if (yy < 0 || yy >= bin.h || onLine(yy)) continue;
      let x0 = -1;
      let x1 = -1;
      for (let x = box.x; x < box.x + box.w; x++)
        if (bin.data[yy * bin.w + x]) {
          if (x0 < 0) x0 = x;
          x1 = x;
        }
      if (x0 >= 0) most = Math.max(most, x1 - x0 + 1);
    }
    return most;
  };
  const judge = (box: Rect, area: number, strict = false): { ys: number[]; code: SmuflName; cx: number; netted?: boolean } | null => {
    const w = box.w / sp;
    const h = box.h / sp;
    const fill = area / (box.w * box.h);
    if (w < BARE_W[0] || w > BARE_W[1] || fill < BARE_FILL[0]) return null;
    let ys: number[];
    if (h >= BARE_H1[0] && h <= BARE_H1[1]) {
      const c = snap(box.y + box.h / 2);
      if (c === null) return null;
      ys = [c];
    } else if (h >= BARE_H2[0] && h <= BARE_H2[1]) {
      // 两个头各高 box.h − 1 格（中心隔一格）
      const hh = Math.max(sp * 0.8, box.h - sp);
      const a = snap(box.y + hh / 2);
      const b = snap(box.y + box.h - hh / 2);
      if (a === null || b === null || Math.abs(Math.abs(b - a) - sp) > sp * 0.3) return null;
      ys = [a, b];
    } else return null;
    // 削过的块：每个头心那一带都要有一个头宽的墨（五度的两个头被窗口截成一截，吸到中间两个线位上，齐来谢主歌 m3）
    if (strict && ys.some((y) => widest(box, y) < sp * 0.8)) return null;
    const cx = box.x + box.w / 2;
    const cores = ys.map((y) => core(cx, y));
    // 网纹印的实心头里散着白点，头心墨占比到不了 `BARE_SOLID`、还常落到 `BARE_CORE` 以下（我灵镇静 m22 B♭4/G4 四分读成全音符）：
    // 每个头盒里最大的一块封闭白都不到盒的 `BARE_HOLE` 的算实心——空心头的内腔是整整一块
    const netted = ys.every((y) => largestHole(bin, { x: Math.round(cx - size.w / 2), y: Math.round(y - size.h / 2), w: size.w, h: size.h }, onLine) < size.w * size.h * BARE_HOLE);
    if (netted && cores.every((c) => c[1] >= BARE_NETTED)) return { ys, code: "noteheadBlack", cx, netted: true };
    if (fill <= BARE_FILL[1] && cores.every((c) => c[0] <= BARE_CORE)) return { ys, code: "noteheadHalf", cx };
    if (ys.length === 1 && cores[0][1] >= BARE_SOLID) return { ys, code: "noteheadBlack", cx };
    return null;
  };
  for (const p of probes) {
    if (p.ids.some((id) => used.has(id))) continue;
    // 收拢来的墨判不成头、又比一个头高的：多半连着干本身（干没抹掉、头与干连成一块），或另一个声部朝反方向伸出去的干，
    // 只取端头窗口里扣掉干、加线之后的那一截再判一次（万福泉源歌 m21 E♭4/C4「8」字叠头、耶和华是我的牧者 m11
    // 两根干共用的 A3 空心头）。先判原块：两个头高的叠头照原块判得对，削过反倒切坏（我灵镇静 m15、m23）
    let got = judge(p.box, p.area);
    if (!got && p.box.h / sp > BARE_H1[1]) {
      const cut = endInk(bin, p, sp, onLine);
      if (cut) got = judge(cut.box, cut.area, true);
      // 只收空心头：实心的那几种前后别的路认得出，这里截出来的位置反倒偏（晨曦破晓 m8 低音 A3）。网纹实心头除外（别的路认不出）
      if (got?.code !== "noteheadHalf" && !got?.netted) got = null;
    }
    if (!got) continue;
    // 形同小节线的那一档，空心头要有自己围出的内腔（谱线行当白）：跨小节线的连音线尾巴贴着小节线，弧与谱线围出一块白，
    // 照判据收成了二分头（我灵镇静 m5 C5、低音 m5 E3/m18 F3）
    if (p.bar && got.code === "noteheadHalf" && got.ys.every((y) => largestHole(bin, { x: Math.round(got!.cx - size.w / 2), y: Math.round(y - size.h / 2), w: size.w, h: size.h }, onLine, false) < size.w * size.h * BARE_HOLE)) continue;
    for (const id of p.ids) used.add(id);
    // 网纹实心头按收拢墨的中心出盒常离干几像素、挂不上干（读成全音符）：盒贴到干的那一侧
    let x0 = Math.round(got.cx - size.w / 2);
    if (got.netted) {
      const sx = (p.stem.x0 + p.stem.x1) / 2;
      x0 = sx > got.cx ? Math.round(sx - size.w) : Math.round(sx);
    }
    for (const y of got.ys) out.push({ box: { x: x0, y: Math.round(y - size.h / 2), w: size.w, h: size.h }, code: got.code, ids: p.ids, weak: true });
  }
  return out;
}

/**
 * 光杆干端头窗口里（与 `probeBareStems` 同一个窗口）的墨，扣掉干本身那几列、谱线行与加线行（横向一格半以上的薄行），
 * 再把上下两头只剩一根竖笔（不到 0.4 格宽）的行削掉——另一个声部朝反方向伸出去的干。返回那一截的盒与墨量。
 */
function endInk(bin: Binary, p: BareStemProbe, sp: number, onLine: (y: number) => boolean): { box: Rect; area: number } | null {
  const s = p.stem;
  const sx = (s.x0 + s.x1) / 2;
  const e = p.end === "top" ? Math.min(s.y0, s.y1) : Math.max(s.y0, s.y1);
  // 干端外侧的窗口跟着收拢来的墨团伸（至多 2 格）：干端只到下面那个头里，上面那个头整个在 0.9 格外（是爱 p1 m2 G5/B♭5）
  const ya = Math.max(0, Math.round(p.end === "top" ? Math.max(e - sp * 2.0, Math.min(e - sp * 0.9, p.box.y)) : e - sp * 2.0));
  const yb = Math.min(bin.h - 1, Math.round(p.end === "top" ? e + sp * 2.0 : Math.min(e + sp * 2.0, Math.max(e + sp * 0.9, p.box.y + p.box.h - 1))));
  const xa = Math.max(0, Math.round(p.end === "bottom" ? sx - sp * 1.8 : sx - sp * 0.3));
  const xb = Math.min(bin.w - 1, Math.round(p.end === "bottom" ? sx + sp * 0.3 : sx + sp * 1.8));
  const lw = Math.max(1, s.lw);
  const rows: { y: number; x0: number; x1: number; n: number; span: number }[] = [];
  for (let y = ya; y <= yb; y++) {
    if (onLine(y)) continue;
    // 这一行在窗口外左右各一格也算上的墨宽：加线比头宽，只在窗口里数分不开
    let span = 0;
    for (let x = Math.max(0, xa - Math.round(sp)); x <= Math.min(bin.w - 1, xb + Math.round(sp)); x++) span += bin.data[y * bin.w + x];
    let n = 0;
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let x = xa; x <= xb; x++) {
      if (Math.abs(x - sx) <= lw || !bin.data[y * bin.w + x]) continue;
      n++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
    }
    rows.push({ y, x0, x1, n, span });
  }
  // 窗口伸出 0.9 格的那段只收连着的墨：一碰到空行就截（破碎扫描版 p3 m39 F♯5 头上方隔着空白的记号）
  {
    const near0 = p.end === "top" ? e - sp * 0.9 : e + sp * 0.9;
    const outer = (r: { y: number }) => (p.end === "top" ? r.y < near0 : r.y > near0);
    const order = p.end === "top" ? [...rows].reverse() : rows;
    let cut: number | null = null;
    for (const r of order) if (outer(r) && r.n < 2) { cut = r.y; break; }
    if (cut !== null) {
      const c = cut;
      for (let i = rows.length - 1; i >= 0; i--) if (p.end === "top" ? rows[i].y <= c : rows[i].y >= c) rows.splice(i, 1);
    }
  }
  // 加线行：连窗口外一共横贯 1.8 格以上、上下三行外就没这么宽了（薄）；两侧紧挨着头那几行的（加线穿过头）留着
  const wide = (i: number) => rows[i].span >= sp * 1.8;
  const thin = (i: number) => wide(i) && [-3, 3].every((k) => rows[i + k] === undefined || rows[i + k].span < sp * 1.8);
  // 加线的边行墨常不齐（宽不到 1.8 格），挨着加线两行内的也算加线
  const led = rows.filter((_, i) => thin(i)).map((r) => r.y);
  const onLed = (r: { y: number }) => led.some((y) => Math.abs(y - r.y) <= 2);
  const keep = rows.filter((r) => r.n >= sp * 0.4 && !(onLed(r) && !rows.some((q) => Math.abs(q.y - r.y) <= 4 && !onLed(q) && q.n >= sp * 0.4)));
  if (!keep.length) return null;
  const y0 = keep[0].y;
  const y1 = keep[keep.length - 1].y;
  // 窗口干那一侧的边外还有头那么宽的墨：头比窗口还长（和弦五度的两个头，齐来谢主歌 m3），窗口截出来的尺寸不作数
  for (let k = 1; k <= 2; k++) {
    const y = p.end === "bottom" ? ya - k : yb + k;
    if (y < 0 || y >= bin.h || onLine(y)) continue;
    let n = 0;
    for (let x = xa; x <= xb; x++) if (Math.abs(x - sx) > lw && bin.data[y * bin.w + x]) n++;
    if (n >= sp * 0.4) return null;
  }
  // 横向范围不算加线行（加线穿过头时比头宽）
  const body = keep.filter((r) => !onLed(r));
  const x0 = Math.min(...(body.length ? body : keep).map((r) => r.x0));
  const x1 = Math.max(...(body.length ? body : keep).map((r) => r.x1));
  // 墨量同样不算加线行（谱线行本来就没数）
  let area = 0;
  for (const r of rows) if (r.y >= y0 && r.y <= y1 && !onLed(r)) area += r.n;
  return { box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, area };
}

/** 斜缝至少这么长（线距的倍数，取外接盒的长边）。 */
const SLIT_LEN = 0.45;
/** 斜缝至少这么大（线距平方的倍数）。 */
const SLIT_AREA = 0.06;
/** 刨掉斜缝之后，头的内切椭圆里墨密度不超过这么多。 */
const SLIT_DENS = 0.88;
/** 斜缝重心离盒心最多这么远（盒宽、盒高的倍数）。 */
const SLIT_OFF = 0.2;

/**
 * **实心头盒里藏着空心头的内腔**：在去谱线**之前**的图上，盒里被墨围住的最大一块白够长、够大，
 * 而且刨掉它之后内切椭圆里的墨并不满——就是空心头。
 *
 * 为什么要第二条：网点印的实心头（万口欢唱、信心使我得胜、当我们回到天家）墨里满是白点，
 * 按 4 连通也能连成一条 0.4~0.5 格的长链，长度、面积、「内部像素」都与骑线空心头的斜缝重叠；
 * 可网点链之外的墨是满的（刨掉后密度 0.94~1.0），空心头除了那道缝，圈的外缘与另半截缝（被谱线切开）
 * 还留着白（0.76~0.83）。
 */
export function hollowSlit(bin: Binary, b: Rect, sp: number): boolean {
  const W = b.w + 2;
  const H = b.h + 2;
  const ink = (x: number, y: number) => {
    const X = b.x - 1 + x;
    const Y = b.y - 1 + y;
    return X >= 0 && Y >= 0 && X < bin.w && Y < bin.h && !!bin.data[Y * bin.w + X];
  };
  // 先从盒外一圈灌白：碰得到盒边的白都不是内腔
  const seen = new Uint8Array(W * H);
  const st: number[] = [];
  const seed = (x: number, y: number) => {
    const i = y * W + x;
    if (!seen[i] && !ink(x, y)) {
      seen[i] = 1;
      st.push(i);
    }
  };
  const flood = (): [number, number, number, number] => {
    let n = 0;
    let sx = 0;
    let sy = 0;
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    while (st.length) {
      const i = st.pop()!;
      const x = i % W;
      const y = (i / W) | 0;
      n++;
      sx += x;
      sy += y;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      if (x > 0) seed(x - 1, y);
      if (x < W - 1) seed(x + 1, y);
      if (y > 0) seed(x, y - 1);
      if (y < H - 1) seed(x, y + 1);
    }
    return [n, Math.max(x1 - x0 + 1, y1 - y0 + 1), sx / Math.max(1, n), sy / Math.max(1, n)];
  };
  for (let x = 0; x < W; x++) { seed(x, 0); seed(x, H - 1); }
  for (let y = 0; y < H; y++) { seed(0, y); seed(W - 1, y); }
  flood();
  let best = 0;
  let bestLen = 0;
  let cx = 0;
  let cy = 0;
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      if (seen[y * W + x] || ink(x, y)) continue;
      seed(x, y);
      const [n, len, mx, my] = flood();
      if (n > best) { best = n; bestLen = len; cx = mx; cy = my; }
    }
  if (bestLen < sp * SLIT_LEN || best < sp * sp * SLIT_AREA) return false;
  // 内腔在头的正中（重心离盒心不过盒宽高的 `SLIT_OFF`）：升号中间那个方孔、字里的「口」都偏在一边
  if (Math.abs(cx - W / 2) > b.w * SLIT_OFF || Math.abs(cy - H / 2) > b.h * SLIT_OFF) return false;
  let inE = 0;
  let inkE = 0;
  const rx = b.w / 2;
  const ry = b.h / 2;
  for (let y = 0; y < b.h; y++)
    for (let x = 0; x < b.w; x++) {
      const u = (x + 0.5 - rx) / rx;
      const v = (y + 0.5 - ry) / ry;
      if (u * u + v * v > 1) continue;
      inE++;
      if (ink(x + 1, y + 1)) inkE++;
    }
  return inkE / Math.max(1, inE - best) <= SLIT_DENS;
}

/**
 * 空心头盒里的「内腔」其实是**弧与谱线围出的空当**吗：连音线、短弧骑在谱线上（有一位神 m19），
 * 或弧尾斜着搭到符干上（齐来崇拜 m22 低音），弧、干与谱线围出一块白，被当成空心头的内腔。
 * 逐行量盒里夹在两段墨之间最长的白（谱线那几行不量），连续有白的几行算内腔：
 * **一头紧贴谱线、往那头一路变宽到最宽，另一头收得很窄**的，是拱形（或楔形）的空当——真头的内腔是斜缝或椭圆，
 * 贴线那头不会是最宽的（斜缝各行差不多宽，椭圆中间最宽）。
 * 谱线从头中间横穿的（骑线头），线另一边盒中段接着还有墨，不算。
 */
export function archCavity(bin: Binary, box: Rect, onLine0: (y: number) => boolean): boolean {
  // 紧挨谱线、整行八成以上是墨的也算谱线行：扫描件谱线上的白点让那一行量出一两像素的「缝」，混进内腔，形状就量歪了（望十架 p7 m55）
  const onLine = (y: number): boolean => {
    if (onLine0(y)) return true;
    if (y < 0 || y >= bin.h || !(onLine0(y - 1) || onLine0(y + 1))) return false;
    let n = 0;
    const x0 = Math.max(0, box.x), x1 = Math.min(bin.w, box.x + box.w);
    for (let x = x0; x < x1; x++) if (bin.data[y * bin.w + x]) n++;
    return n >= (x1 - x0) * 0.8;
  };
  /** 这一行盒里夹在两段墨之间最长的一段白。 */
  const gap = (y: number): number => {
    if (y < 0 || y >= bin.h) return 0;
    let most = 0;
    let run = -1;
    for (let x = Math.max(0, box.x); x < Math.min(bin.w, box.x + box.w); x++)
      if (bin.data[y * bin.w + x]) {
        if (run > most) most = run;
        run = 0;
      } else if (run >= 0) run++;
    return most;
  };
  let best: { a: number; b: number } | null = null;
  for (let y = box.y; y < box.y + box.h; ) {
    if (onLine(y) || gap(y) <= 0) {
      y++;
      continue;
    }
    let b = y;
    while (b + 1 < box.y + box.h && !onLine(b + 1) && gap(b + 1) > 0) b++;
    if (!best || b - y > best.b - best.a) best = { a: y, b };
    y = b + 1;
  }
  if (!best || best.b - best.a < 2) return false;
  const ws: number[] = [];
  for (let y = best.a; y <= best.b; y++) ws.push(gap(y));
  const most = Math.max(...ws);
  /** 从这一头越过谱线，线那边还有内腔、或盒的中段（左右各让两成）还有墨吗：骑线头的另半截（半截内腔常靠盒外的干围住，量不出白）。
   *  中段的墨只数贴线那一行（`ref`）里是白的列：贴着干的盒（弧尾搭在干上，望十架 p7 m55 女高），干那一列线两边都是墨，不是另半截。 */
  const beyond = (y: number, dy: number, ref: number): boolean => {
    while (onLine(y)) y += dy;
    if (y < 0 || y >= bin.h) return false;
    if (gap(y) > 0) return true;
    const m = Math.round(box.w * 0.2);
    for (let x = box.x + m; x < box.x + box.w - m; x++) if (x >= 0 && x < bin.w && bin.data[y * bin.w + x] && !bin.data[ref * bin.w + x]) return true;
    return false;
  };
  // 往贴线那头一路变宽（容一像素的抖动）：拱与楔是这样，斜缝与椭圆不是
  const widening = (xs: number[]) => xs.every((w, i) => i === 0 || w >= xs[i - 1] - 1);
  const bottom = onLine(best.b + 1) && ws[ws.length - 1] >= most * 0.9 && ws[0] <= most * 0.4 && widening(ws) && !beyond(best.b + 1, 1, best.b);
  const top = onLine(best.a - 1) && ws[0] >= most * 0.9 && ws[ws.length - 1] <= most * 0.4 && widening([...ws].reverse()) && !beyond(best.a - 1, -1, best.a);
  return bottom || top;
}

/**
 * 空心头盒里的内腔**有一侧直接就是符干**吗：八分音符的尾往下弯回来，与干围出一块白（所信有根基 m4、m12，
 * 我一生要赞美你 m36）。真头的内腔与干之间多半隔着一圈头的墨，挨着内腔的那一列只有头那么高——
 * 但干从头中间穿过、或压在圈上的字体里也会直接挨着（万口欢唱的骑线二分和弦），所以只配合「落在符尾里」用。
 * 从盒中段离中心最近的白点灌出内腔（碰到盒边的不算封闭内腔），逐行看内腔最左、最右的白外面挨着的墨，
 * 那一列的竖墨长两格以上的行过六成就算。
 */
export function stemWalledCavity(bin: Binary, box: Rect, sp: number): boolean {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(bin.w - 1, box.x + box.w - 1);
  const y1 = Math.min(bin.h - 1, box.y + box.h - 1);
  const ink = (x: number, y: number) => !!bin.data[y * bin.w + x];
  const cx = Math.round((x0 + x1) / 2);
  const cy = Math.round((y0 + y1) / 2);
  const band = Math.round(box.h * 0.2);
  let seed: [number, number] | null = null;
  for (let r = 0; r <= box.w / 2 && !seed; r++)
    for (let dy = -band; dy <= band && !seed; dy++)
      for (const dx of [-r, r]) if (!seed && cx + dx > x0 && cx + dx < x1 && cy + dy > y0 && cy + dy < y1 && !ink(cx + dx, cy + dy)) seed = [cx + dx, cy + dy];
  if (!seed) return false;
  const w = x1 - x0 + 1;
  const seen = new Uint8Array(w * (y1 - y0 + 1));
  const stack: [number, number][] = [seed];
  seen[(seed[1] - y0) * w + seed[0] - x0] = 1;
  const rowMin = new Map<number, number>();
  const rowMax = new Map<number, number>();
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x === x0 || x === x1 || y === y0 || y === y1) return false; // 碰到盒边：不是封闭的内腔
    rowMin.set(y, Math.min(rowMin.get(y) ?? x, x));
    rowMax.set(y, Math.max(rowMax.get(y) ?? x, x));
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (ink(nx, ny)) continue;
      const k = (ny - y0) * w + nx - x0;
      if (seen[k]) continue;
      seen[k] = 1;
      stack.push([nx, ny]);
    }
  }
  const run = (x: number, y: number): number => {
    let t = y;
    let d = y;
    while (t > 0 && ink(x, t - 1)) t--;
    while (d < bin.h - 1 && ink(x, d + 1)) d++;
    return d - t + 1;
  };
  let left = 0;
  let right = 0;
  for (const [y, a] of rowMin) {
    if (ink(a - 1, y) && run(a - 1, y) >= sp * 2) left++;
    const b = rowMax.get(y)!;
    if (ink(b + 1, y) && run(b + 1, y) >= sp * 2) right++;
  }
  return rowMin.size >= 2 && Math.max(left, right) >= rowMin.size * 0.6;
}
