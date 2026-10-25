// 文字行的**词间空当**：按源图墨列补 rec 吞掉的空格、逐字对位回原始字位。简谱页眉（`omr/header.ts`）与五线谱页眉
// （`rasteromr/ocrlive.ts` 页眉带）共用；纯文本判据在 `headertext.ts`。
import type { Binary, Rect } from "./types";
import { median } from "./geom";

const hanziCount = (s: string) => (s.match(/[一-鿿]/g) || []).length;

/** 一行文本框里的空白列段：`[起列, 宽]`，按 x 序。两处判词间空当都用它。 */
export function inkBlanks(bin: Binary, bbox: Rect): Array<[number, number]> {
  const y1 = Math.min(bin.h, bbox.y + bbox.h), x1 = Math.min(bin.w, bbox.x + bbox.w);
  const blanks: Array<[number, number]> = [];
  let s = -1;
  for (let x = Math.max(0, bbox.x); x < x1; x++) {
    let ink = false;
    for (let y = Math.max(0, bbox.y); y < y1; y++) if (bin.data[y * bin.w + x]) { ink = true; break; }
    if (!ink) { if (s < 0) s = x; }
    else if (s >= 0) { blanks.push([s, x - s]); s = -1; }
  }
  return blanks;
}

/** 第 i 个字与第 i+1 个字之间，谱面上**真有一道空当**吗？（≥1.6 倍于本行空白宽度的中位数）
 *  后缀式著作者的「名字 ↔ 职能词」之间：脚步印的是「盛晓玫 词曲」（有空当），
 *  沧海一声笑印的是「黄 霑作词、作曲」（名字里有空当、名字与职能之间没有）。rec 从不吐空格，
 *  照谱面原样输出就得回源图上量这一道。 */
export function gapWideAt(bin: Binary, bbox: Rect, chars: { text: string; cx: number }[] | undefined, i: number): boolean {
  if (!chars || i < 0 || i + 1 >= chars.length) return false;
  const blanks = inkBlanks(bin, bbox);
  if (blanks.length < 3) return false;
  const med = median(blanks.map((b) => b[1])) || 1;
  const lo = chars[i].cx, hi = chars[i + 1].cx;
  return blanks.some(([bx, bw]) => bx + bw / 2 > lo && bx + bw / 2 <= hi && bw >= med * 1.6);
}

/** 中文标题的分句空当：「不怕劳累 不怕饥寒」「天不蓝了 水不清了」两半之间印着整整一字宽的白，
 *  rec 不吐空格。两道门：
 *  - **≥0.5 框高**：汉字的字间白本就只有 0.1~0.2 字高，这么宽只可能是有意排的空当（门按 det 框高量，
 *    框比字身松：新编赞美诗·四声部「刘廷芳 杨荫浏合译」的空当 28px、框高 49，按 0.6 差一点）；
 *  - **≥2 倍于本行字间白的中位数**：有的歌本整行拉开字距排（「赞 美 一 神」「因 有 主 同 在」），
 *    每道字间白都过得了第一道门，但它们彼此一样宽，不是分句——只有明显宽出一截的那道才算。
 *  「字间白」取每对相邻汉字之间最宽的那一道（字内偏旁之间的窄白不算）。
 *  只在两侧都是汉字时插，编号与标题之间（「1717 不怕…」）那道白不管——编号下游本来就要剥掉。 */
export function recoverHanziGaps(bin: Binary, text: string, bbox: Rect, chars?: { text: string; cx: number }[]): string {
  const cs = [...text];
  if (!chars || chars.length !== cs.length || hanziCount(text) < 4) return text;
  const isHan = (c: string) => /[一-鿿]/.test(c);
  const pairGap = new Map<number, number>();              // 左字下标 → 两字之间最宽的白
  for (const [bx, bw] of inkBlanks(bin, bbox)) {
    const mid = bx + bw / 2;
    let i = -1;
    while (i + 1 < chars.length && chars[i + 1].cx < mid) i++;
    if (i >= 0 && i + 1 < cs.length && isHan(cs[i]) && isHan(cs[i + 1])) pairGap.set(i, Math.max(pairGap.get(i) ?? 0, bw));
  }
  if (pairGap.size < 3) return text;
  const med = median([...pairGap.values()]);
  // 宽窄两档分明的（赞美诗歌1384 936「爱 喜乐 生命」：字间白 6、37、6、39，框高 91）：宽的一半、窄的一半，中位落在两档之间，
  // 空当又不到半个框高，上面两道门都过不去。按宽度排开、相邻两道跳到四倍以上处切开，宽的那档都有 0.35 框高就算分句。
  const ws = [...pairGap.values()].sort((a, b) => a - b);
  const k = ws.findIndex((w, i) => i > 0 && w >= Math.max(1, ws[i - 1]) * 4);
  const cut = k > 0 && ws[k] >= bbox.h * 0.35 ? ws[k] : Infinity;
  const after = new Set([...pairGap].filter(([, w]) => (w >= bbox.h * 0.5 && w >= med * 2) || w >= cut).map(([i]) => i));
  return cs.map((c, i) => (after.has(i) ? c + " " : c)).join("");
}

/**
 * 整句英文（副标题、英文著作者名）的词间空格：**按源图上真实的空白列**补，而不是靠 CTC 帧位
 * 算间距。早先另有一条按帧位间隙（右字左缘 − 左字右缘）判空格的路子，被同一个毛病拖垮：帧位是
 * 等宽量化的，`JohnLaudon` 的字母间隙就有 1 个基元与 2 个基元两档，而门是「>1.5 倍中位」——
 * 中位恰是 1 个基元时，2 个基元的那些全过，读成 `Joh n La ud on`。两条路合并成这一条。
 * 同一个毛病在整句英文上更明显（"It's justdifferent"、"T he spirit" 都是这么来的）；
 * 而谱面上词间那道白是实打实比字母间的白宽一截。
 *
 * 定界：把本行所有空白段按宽度排序，在**跳变最大处**切开，界取跳变两侧的中点（再要求
 * ≥0.12×行高，免得整行只有一个词时把字母间隙切出空格来）。落在界以上的空白，按它的位置
 * 找到左右两个字符，**两侧都是字母**才插空格——撇号/引号这类窄字形两边的白也很宽，
 * 但那儿不该有空格（"It's" 不能拆成 "It 's"）。
 *
 * `alnum`（五线谱页眉）：字母与数字之间的空白也算（「Goths 1715」「Witt 1715」），数字与数字之间不插（字距拉开的年份
 * 「1 7 7 6」不拆）；门改由 `splitGaps` 定——粗体标题的词距大小不一（「When We All Get to Heaven」词间 9~33、字母间 1~3），
 * 按最大跳变找会落在两档词距之间、只插出一个空格；全大写小字一个词里没有字母间白（「JOSEPH MOHR.」只有一道），空白不足三道也照判。
 */
export function recoverSpacesByInk(bin: Binary, text: string, bbox: Rect, chars?: { text: string; cx: number }[], alnum = false): string {
  if (!chars || chars.length !== [...text].length || !/[A-Za-z]{2}/.test(text)) return text;
  const blanks = inkBlanks(bin, bbox);
  if (blanks.length < (alnum ? 1 : 3)) return text;
  const cs = [...text];
  const isLetter = (c: string) => /[A-Za-z]/.test(c);
  // 每道空白的左侧字符下标（右侧即 +1）。
  const leftOf = (bx: number, bw: number): number => {
    const mid = bx + bw / 2;
    let i = -1;
    while (i + 1 < chars.length && chars[i + 1].cx < mid) i++;
    return i;
  };
  // **切分门只在字母↔字母的空白上算**：括号、连字符、汉字冒号旁边的白又宽又不成比例
  // （"Assisi (1182- 1226)" 里 `(` 两侧的白比词间空白宽一截），把它们算进来，最大跳变就落在
  // 那处outlier上、门被抬到词间空白之上，整行一个空格都插不出来（15《赞美真神》的作词行）。
  // 只在这一类空白里找跳变，两簇（词内 / 词间）才分得开。够不着 3 道就退回全体。
  const ll = blanks.filter(([bx, bw]) => {
    const i = leftOf(bx, bw);
    return i >= 0 && i + 1 < cs.length && isLetter(cs[i]) && isLetter(cs[i + 1]);
  });
  const widths = [...new Set((ll.length >= 3 ? ll : blanks).map((b) => b[1]))].sort((a, b) => a - b);
  let cut = 0, jump = 0;
  for (let i = 0; i < widths.length - 1; i++) {
    if (widths[i + 1] - widths[i] >= jump) { jump = widths[i + 1] - widths[i]; cut = (widths[i] + widths[i + 1]) / 2; }
  }
  const inkH = alnum ? inkHeight(bin, bbox) : 0;
  // `alnum`：门在字母、数字之间的全部空白上算（数字与数字之间的除外）——「Psalm118:24」字母间只有两道同宽的白，
  // 只看它们分不出两簇，字母与数字之间那道词间白就补不出来
  const wordBlanks = alnum
    ? blanks.filter(([bx, bw]) => {
        const i = leftOf(bx, bw);
        return i >= 0 && i + 1 < cs.length && /[A-Za-z0-9]/.test(cs[i]) && /[A-Za-z0-9]/.test(cs[i + 1]) && !(/\d/.test(cs[i]) && /\d/.test(cs[i + 1]));
      })
    : [];
  const thr = alnum ? Math.max(splitGaps((wordBlanks.length ? wordBlanks : blanks).map((b) => b[1]), inkH), inkH * 0.14) : Math.max(cut, bbox.h * 0.12);
  const spaceAfter = new Set<number>();
  const isWordCh = (c: string) => /[A-Za-z0-9]/.test(c);
  for (const [bx, bw] of alnum ? blanks : ll) {
    if (bw < thr) continue;
    const i = leftOf(bx, bw);
    if (i < 0 || i + 1 >= cs.length) continue;
    if (alnum ? isWordCh(cs[i]) && isWordCh(cs[i + 1]) && !(/\d/.test(cs[i]) && /\d/.test(cs[i + 1])) : true) spaceAfter.add(i);
  }
  // 半角句读之后接字母：英文排版逗号贴着前词、后面空一格（2075 副标题「Heal, O Lord, and restore
  // this land」读成了 `Heal,O Lord,and`）。句读本身窄，它右边那道白就是词间空白，同一道门量。
  // 半角句读**贴着前词**，左边那道白只有字母间距（2075 实测 ≤3px，右边 21px、门 9px）。全角「、」
  // 左右都留着白（圣哉三一歌副标题 `Holy、holy、holy、Lord God、almighty`，rec 读成 `,`；实测左 6~8px、
  // 右 6~8px、门 7px），那不是英文逗号、后面也不该有空格——左白够 0.6 门的 `,` 照谱面改回「、」。
  // 只有逗号有这层歧义：缩写点左边也常留白（「(william J. Kirkpatrick)」的 `J.`），右边照样补空格。
  const gapAfter = new Map<number, number>(); // 左字下标 → 与右字之间最宽的白
  for (const [bx, bw] of blanks) {
    const i = leftOf(bx, bw);
    if (i >= 0) gapAfter.set(i, Math.max(gapAfter.get(i) ?? 0, bw));
  }
  const ideoComma = new Set<number>();
  for (let i = 1; i + 1 < cs.length; i++) {
    if (!/[,;:!?.]/.test(cs[i]) || !isLetter(cs[i + 1])) continue;
    if (cs[i] === "," && (gapAfter.get(i - 1) ?? 0) >= thr * 0.6) ideoComma.add(i);
    else if ((gapAfter.get(i) ?? 0) >= thr) spaceAfter.add(i);
  }
  ideoComma.forEach((i) => { cs[i] = "、"; });
  return cs.map((c, i) => (spaceAfter.has(i) ? c + " " : c)).join("");
}

/**
 * 字母间白与词间白的分界（`recoverSpacesByInk` 的 `alnum` 口径）：空白宽度取对数、按**两类间方差最大**切成两簇（大津法），
 * 两簇的几何均值差 2.5 倍以上才算分得开（「TRINITY」字距匀开、2 与 4 两档不是词界），界取两簇相邻两值的几何中点；
 * 分不开（整行一个词、或字距匀开的一串大写）不插空格。只有一道空白的，宽过 0.3 墨高才算词界。
 * 一点宽的白不算（字母相挨处 rec 字位对不准、量出来的假白，字距拉开的「(Thomas Hastings)」被它们拉成三簇）；
 * 按墨高比例丢不行——粗体标题的字母间白也就两三点，丢光了只剩词间白一簇，反倒判成分不开。
 * 词少的小字行字母间白自己就分两档（1~2 与 3~4），大津法会切在中间，调用处另加墨高 0.14 倍的下限
 * （按墨高不按框高：行框比字松，新心本标题框高 90、墨高六十上下，按框高量词间 9 的那道就过不了）。
 */
function splitGaps(ws: number[], h: number): number {
  const v = ws.filter((w) => w > 1).sort((a, b) => a - b);
  if (v.length < 2) return h * 0.3;
  const lg = v.map((w) => Math.log(w));
  const total = lg.reduce((a, b) => a + b, 0);
  let best = -1, k = 0, s0 = 0;
  for (let i = 1; i < lg.length; i++) {
    s0 += lg[i - 1];
    const m0 = s0 / i, m1 = (total - s0) / (lg.length - i);
    const b = i * (lg.length - i) * (m1 - m0) ** 2;
    if (lg[i] > lg[i - 1] && b > best) { best = b; k = i; }
  }
  if (!k) return Infinity;
  const m0 = lg.slice(0, k).reduce((a, b) => a + b, 0) / k;
  const m1 = lg.slice(k).reduce((a, b) => a + b, 0) / (lg.length - k);
  if (m1 - m0 < Math.log(2.5)) return Infinity;
  return Math.sqrt(v[k - 1] * v[k]);
}

/** 行框里有墨的最上一行到最下一行的高。 */
function inkHeight(bin: Binary, bbox: Rect): number {
  const x0 = Math.max(0, bbox.x), x1 = Math.min(bin.w, bbox.x + bbox.w);
  let top = -1, bot = -1;
  for (let y = Math.max(0, bbox.y); y < Math.min(bin.h, bbox.y + bbox.h); y++) {
    let ink = false;
    for (let x = x0; x < x1 && !ink; x++) ink = !!bin.data[y * bin.w + x];
    if (ink) { if (top < 0) top = y; bot = y; }
  }
  return top < 0 ? bbox.h : bot - top + 1;
}

/** 把展示文本(可能已规整：去编号前缀、冒号全角化、截尾噪声)逐字对位回 OCR 原始字位，
 *  供识别模式按源图 x 逐字叠加。贪心在 raw 里顺序找等字符；标点全/半角差异等取下一个原始位近似。 */
export function charsForText(text: string, raw?: { text: string; cx: number }[]): { text: string; cx: number }[] | undefined {
  if (!raw || !raw.length) return undefined;
  const res: { text: string; cx: number }[] = [];
  let ri = 0;
  for (const ch of text.trim()) {
    if (ch === " ") continue; // 恢复出来的词间空格无字形，不占原始字位
    let j = ri;
    while (j < raw.length && raw[j].text !== ch) j++;
    if (j < raw.length) { res.push({ text: ch, cx: raw[j].cx }); ri = j + 1; }        // 精确命中
    else if (ri < raw.length) { res.push({ text: ch, cx: raw[ri].cx }); ri++; }       // 归一化字符：取下一原始位
    else if (res.length) { res.push({ text: ch, cx: res[res.length - 1].cx + 1 }); }  // raw 用尽：顺延
  }
  return res.length ? res : undefined;
}

