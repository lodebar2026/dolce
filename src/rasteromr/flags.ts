// 位图五线谱的**符尾与符杠**：符尾自举（没有字典时从本页取样）、符杠形状、杠端贴干。
import type { Binary } from "../omrkit/types";
import type { Box } from "../staffomr/model";
import type { Rect } from "../omrkit/types";
import { type BeamShape } from "../staffomr/notedata";
import type { Seg, SPage } from "../staffomr/model";
import { type RasterSym } from "./adapt";
import { type BeamQuad } from "./prims";
import { type RasterUnit } from "./staffline";
import { overlapFrac } from "../omrkit/geom";

/**
 * **符尾按位置自举**（不查字典）。
 *
 * 字典对符尾几乎没用：`rasterglyphs.json` 里 4144 个类**没定名**，符尾只有 8 个类有名字
 * ——实测全书只认出 1 个 `flag8thUp`。更要命的是符尾在位图上**根本不成为独立的块**：
 * 它上半截是根粗竖笔，横向游程短，`findPrimitives` 把它当竖笔画抽走了；
 * 剩下的钩尾细而弯，落在窗口里的残块高度中位数只有 0.53 格（真符尾有一格半）。
 *
 * 所以改从**原始像素**上量，绕开原语划分：符尾一定长在符干**远离符头的那一端**、
 * 一定在符干**右侧**（刻谱通例，朝上朝下都在右）。量那个窗口里的墨占比，
 * 实测分得很开——没有符杠的音符里，占比要么是 0（真四分），要么在 0.35 以上
 *（破碎前三页 121 个里 27 个），中间几乎没有。
 *
 * **有符杠的符干不看**：符杠也横在这个窗口里，一量必中；而符杠那一路
 * 已经把层数算进时值了（`calcBeamLevels`），再补个符尾反而把十六分压回八分
 *（`buildStems` 里「有符尾的符干不接符杠」）。
 */
export function bootstrapFlags(bin: Binary, pg: SPage, beams: BeamQuad[], unit: RasterUnit, avoid: Rect[] = []): RasterSym[] {
  const sp = unit.space;
  const out: RasterSym[] = [];
  // **只看实心符头**：空心符头（二分/全音符）本来就不带符尾，
  // 给它安一个会把二分读成八分。
  const heads = pg.symbols.filter((s) => s.hasTag("Note") && s.code === "noteheadBlack");
  const lineYs = pg.staves.flatMap((stf) => stf.lineYs);
  const legers = pg.segsWithTag("Leger");
  /** 加线压着头盒的上沿或下沿（上下各容 0.2 格）。 */
  const besideLeger = (b: Box) =>
    legers.some((l) => l.box.left < b.right && l.box.right > b.left && [b.top, b.bottom].some((y) => l.box.top - sp * 0.2 <= y && y <= l.box.bottom + sp * 0.2));
  /** 干尖右边没长出符尾的干（下面看它是不是接着左邻那道符尾）。 */
  const bare: { cx: number; far: number; up: boolean }[] = [];
  for (const st of pg.segsWithTag("Stem")) {
    const on = heads.filter(
      (s) => (Math.abs(s.box.left - st.cx) < sp / 3 || Math.abs(s.box.right - st.cx) < sp / 3) && s.box.top < st.bottom && st.top < s.box.bottom,
    );
    if (!on.length) continue;
    // **远端按符干上所有的头定**：和弦的符干串着好几个头，只拿其中一个量，
    // 挂在中间的那个会把另一头的符头当成「远端」（《赞美一神》D4/D3 共干，
    // 拿 D3 量出远端在 D4 那头，D4 符头连着加线把窗口填满，整批读成八分）。
    const ys = on.map((s) => (s.box.top + s.box.bottom) / 2);
    const dTop = Math.min(...ys.map((y) => Math.abs(st.top - y)));
    const dBot = Math.min(...ys.map((y) => Math.abs(st.bottom - y)));
    // 两端都贴着符头：这是两个头之间被切出来的一截符干（加线、谱线把符干切断），没有自由端
    if (Math.max(dTop, dBot) < sp * FLAG_BOTH_ENDS) continue;
    let far = dTop > dBot ? st.top : st.bottom;
    const hy = far === st.top ? Math.min(...ys) : Math.max(...ys);
    // 符杠横在这个窗口里的，不看（理由见上）
    // 符杠斜着搭在符干中段的也算（不只远端那一小截）
    if (beams.some((b) => b.x0 - sp * 0.5 <= st.cx && st.cx <= b.x1 + sp * 0.5 && st.top - sp * 0.5 < (b.y0 + b.y1) / 2 && (b.y0 + b.y1) / 2 < st.bottom + sp * 0.5)) continue;
    const toward = Math.sign(hy - far) || 1;
    const frac = (d0: number, d1: number, side = 1) => {
      const x0 = Math.round(side > 0 ? st.cx + sp * FLAG_X[0] : st.cx - sp * FLAG_X[1]);
      const x1 = Math.round(side > 0 ? st.cx + sp * FLAG_X[1] : st.cx - sp * FLAG_X[0]);
      let ink = 0;
      let tot = 0;
      for (let dy = sp * d0; dy < sp * d1; dy++) {
        const y = Math.round(far + toward * dy);
        if (y < 0 || y >= bin.h) continue;
        for (let x = x0; x < x1; x++) {
          if (x < 0 || x >= bin.w) continue;
          tot++;
          ink += bin.data[y * bin.w + x];
        }
      }
      return tot ? ink / tot : 0;
    };
    // **符尾从符干尖端长出来**：贴着远端那一小截、紧挨符干右侧必须有墨。
    // 没这一条，从符干旁边路过的连音线、下一个音的符头都会把窗口填满
    // （实测只看整窗占比，小节自检 33.2% → 31.9%）。
    // 粗线扫描中符干可能伸出连接点几像素；在半格、两倍线宽以内找连接处。
    // 细线页仍用原尖端，避免把附近的弧线误认成符尾。门槛 0.2 → 0.15 格（`FLAG_REACH_LW`）、reach 两倍 → 三倍线宽：
    // 万古磐石歌线宽 4/22 = 0.18，符干冒出符尾连接点 10px，整页单尾八分读成四分。
    // 整窗墨占比也按连接点量，不在这之前按尖端先筛一道：干伸出符尾半格的，按尖端量窗口只罩到钩尾一角
    //（《向主唱新歌》下声部的八分 B3 读成四分，后面的休止整排错拍）。
    let offset = 0;
    // 干尖**落在谱线上**的也往里找（最多半格）：干冒过钩的起点、顶到线上（万福泉源歌低分辨率本，
    // 钩从干尖下半格才长出来，尖端窗口只罩到一角，八分和弦整批读成四分）
    const onLineTip = lineYs.some((ly) => Math.abs(ly - far) <= unit.lineThick * 1.5 + 1);
    // 细线页干尖没顶在线上的，也往里找半格（干冒过钩的起点 7 像素：颂赞与尊贵整页单尾八分读成四分），
    // 但窗口不能碰到头（离头心留 0.6 格）：短干上往里挪，窗口罩到干旁边的头本身（晨曦破晓 m6）
    const reach = unit.lineThick > sp * FLAG_REACH_LW
      ? Math.min(sp * 0.5, unit.lineThick * 3)
      : onLineTip ? sp * 0.5 : Math.max(0, Math.min(sp * 0.5, Math.abs(hy - far) - sp * (0.6 + FLAG_TIP_Y)));
    while (frac(offset, offset + FLAG_TIP_Y) < FLAG_TIP && offset * sp < reach) offset += 1 / sp;
    /** 干尖顺着干那一列往外延到墨断（上限 `FLAG_TIP_EXT` 格）。 */
    const tipOf = (from: number) => {
      const cx = Math.round(st.cx);
      const inkAt = (y: number) => y >= 0 && y < bin.h && [cx - 1, cx, cx + 1].some((x) => x >= 0 && x < bin.w && bin.data[y * bin.w + x]);
      let tip = from;
      while (Math.abs(tip - toward - from) <= sp * FLAG_TIP_EXT && inkAt(Math.round(tip - toward))) tip -= toward;
      return tip;
    };
    const noFlag = () => frac(offset, offset + FLAG_TIP_Y) < FLAG_TIP || frac(offset, offset + FLAG_Y) < FLAG_INK;
    let bareHere = noFlag();
    // **钩整个长在认出的干尖外边**：钩和干尖粘成一团、横游程太宽，干只认到钩团之前，
    // 干尖处的窗口是空的（万古磐石歌低音 m3、m9 的八分读成四分）——从延出的真干尖再看一次
    if (bareHere) {
      const tip = tipOf(far);
      if (Math.abs(tip - far) >= sp * FLAG_GLUED) {
        const keep = far;
        far = tip;
        offset = 0;
        while (frac(offset, offset + FLAG_TIP_Y) < FLAG_TIP && offset < 0.5) offset += 1 / sp;
        bareHere = noFlag();
        if (bareHere) far = keep;
      }
    }
    if (bareHere) {
      bare.push({ cx: st.cx, far, up: far < hy });
      continue;
    }
    if (frac(offset, offset + FLAG_TIP_Y, -1) >= FLAG_LEFT) continue;
    const up = far < hy;
    // **第二个钩**：十六分的两道钩沿符干错开约一格。只认出第一道的话
    // 十六分整批读成八分（实测补上第一道之后 `16th→eighth` 一下涨到 171 处）。
    // 窗口截在最近的符头边缘之前：朝下的短符干上，符头就在符干右边，离尖端一格多就罩到它
    //（《主我敬拜你》朝下的八分整批读成十六分）。截下来不到 0.6 格的就不看第二道钩。
    const room = Math.abs(hy - far) / sp - 0.6;
    const twoEnd = Math.min(offset + 2.2, room);
    // 还要**右缘轮廓有两个峰**：从尖端往符头走，逐行量钩的最右缘，先涨后落（第一道钩）再涨起来（第二道）
    // 才是两道钩。一道长钩（《主我敬拜你》的八分符尾有 2.3 格长）外沿也会填满第二道钩的窗口，但右缘只有一个峰。
    // 低分辨率放大的万古磐石歌两道钩在干边粘成一段，靠这一条。谱线那几行不算。
    // 或者**贴着干的那一窄条里墨分成两段**（两道钩各自连在干上，右缘对齐的字体靠这一条：来敬拜荣耀王）。
    const hookRuns = () => {
      const x0 = Math.round(st.cx + unit.lineThick);
      const x1 = Math.round(st.cx + sp * 0.35);
      let runs = 0;
      let gap = 2;
      for (let dy = offset * sp; dy < Math.min(offset + 2.4, room) * sp; dy++) {
        const y = Math.round(far + toward * dy);
        if (y < 0 || y >= bin.h || lineYs.some((ly) => Math.abs(ly - y) <= unit.lineThick)) continue;
        let ink = false;
        for (let x = Math.max(0, x0); x <= Math.min(x1, bin.w - 1) && !ink; x++) if (bin.data[y * bin.w + x]) ink = true;
        if (ink) {
          if (gap >= 2) runs++;
          gap = 0;
        } else gap++;
      }
      return runs;
    };
    const twoPeaks = () => {
      const x0 = Math.round(st.cx + unit.lineThick);
      const x1 = Math.round(st.cx + sp * 1.2);
      const prom = sp * HOOK_PROM;
      let max = -1;
      let dip = Infinity;
      for (let dy = offset * sp; dy < Math.min(offset + 2.4, room) * sp; dy++) {
        const y = Math.round(far + toward * dy);
        if (y < 0 || y >= bin.h || lineYs.some((ly) => Math.abs(ly - y) <= unit.lineThick)) continue;
        let r = -1;
        for (let x = Math.min(x1, bin.w - 1); x >= Math.max(0, x0); x--) if (bin.data[y * bin.w + x]) { r = x; break; }
        if (r < 0) continue;
        if (dip < Infinity && r - dip >= prom) return true;
        if (r > max) max = r;
        if (max - r >= prom) dip = Math.min(dip, r);
      }
      return false;
    };
    /**
     * **沿干右侧逐列竖扫黑白游程**：从干尖往头走，数黑段数（谱线行不算、隔不到 0.15 格的空白不断开、
     * 薄于 0.15 格的去线残渣不算一段），返回数出两段以上的列占比。两道钩在干边粘成一段、右缘又对齐的，
     * 离干 0.2–0.6 格的竖线上还是穿过两道钩（万古磐石歌低分辨率本、来敬拜荣耀王朝下的粗体钩）；
     * 八分在这一带全是一段。
     */
    const colRuns = (tip: number, end: number) => {
      const gapMin = Math.max(2, sp * 0.15);
      const runMin = Math.max(2, sp * 0.15);
      const lineRow = (y: number) => lineYs.some((ly) => Math.abs(ly - y) <= unit.lineThick);
      let cols = 0;
      let twos = 0;
      for (let x = Math.round(st.cx + unit.lineThick + sp * 0.1); x <= st.cx + sp * FLAG_COLS_X; x++) {
        if (x < 0 || x >= bin.w) continue;
        let runs = 0;
        let len = 0;
        let gap = gapMin;
        for (let dy = 0; dy < end * sp; dy++) {
          const y = Math.round(tip + toward * dy);
          if (y < 0 || y >= bin.h) continue;
          if (lineRow(y)) {
            if (gap === 0) len++;
            continue;
          }
          if (bin.data[y * bin.w + x]) {
            if (gap >= gapMin) {
              if (len >= runMin) runs++;
              len = 0;
            }
            len++;
            gap = 0;
          } else gap++;
        }
        if (len >= runMin) runs++;
        cols++;
        if (runs >= 2) twos++;
      }
      return cols ? twos / cols : 0;
    };
    // **两道钩粘着干尖**：干只认到钩团之前（万古磐石歌低音 m1 十六分，干尖少了 1.7 格，钩窗口朝头那边只剩 0.7 格），
    // 从延出的真干尖再竖扫一次。延出的尖只拿来补判第二道钩，不挪出块和一道钩的判断：
    // 普通八分的干尖本来就埋在钩里 0.6 格上下，全按延出的尖量，整批错位（信心使我得胜音符 97.8 → 96.7）
    const glued = () => {
      const tip = tipOf(far);
      if (Math.abs(tip - far) < sp * FLAG_GLUED) return false;
      const end = Math.min(2.4, Math.abs(hy - tip) / sp - 0.6);
      return end >= 1.6 && colRuns(tip, end) >= FLAG_COLS2;
    };
    const two = twoEnd - (offset + 1.0) >= 0.6 && frac(offset + 1.0, twoEnd) >= FLAG_INK2 && (twoPeaks() || hookRuns() >= 2 || colRuns(far + toward * offset * sp, Math.min(2.4, room - offset)) >= FLAG_COLS2) || glued();
    const code = two ? (up ? "flag16thUp" : "flag16thDown") : up ? "flag8thUp" : "flag8thDown";
    const h = sp * (two ? 2.2 : 1.5);
    // 出块也从**连接点**起算：`offset` 找到的才是符尾真正长出来的地方，
    // 还按符干末端 `far` 出块的话，粗线扫描件上整块会偏出半格。
    const anchor = far + toward * offset * sp;
    const y0 = toward > 0 ? anchor : anchor - h;
    const fbox = { x: Math.round(st.cx), y: Math.round(y0), w: Math.round(sp * 1.5), h: Math.round(h) };
    // **和弦字母不是符尾**：符干朝上顶到和弦行时，窗口里那点墨是「C/E」的 E、「Csus4」的 sus
    //（《主我敬拜你》三处，八分附点、附点二分都读成了带尾的八分）
    if (avoid.some((m) => overlapFrac(fbox, m) > FLAG_AVOID)) continue;
    // **窗口里那团墨是别的头**：两个头左缘连成的竖墨被当成干，下面那个头（吊在加线下的 B3）左缘离这根「干」稍远、没算作它的头，
    // 干尖于是成了自由端、头的墨当了符尾（耶和华是我的牧者 m9 E4/B3 读成八分）。已认的实心头大半落在出块里、又贴着加线的不出尾。
    // 要贴着加线：符尾那团墨自己也常被收成假头（我一生要赞美你 m18 E4 的尾），光看「盖住已认头」会把真尾剔掉
    if (heads.some((s) => !on.includes(s) && overlapFrac({ x: s.box.left, y: s.box.top, w: s.box.right - s.box.left, h: s.box.bottom - s.box.top }, fbox) > FLAG_ON_HEAD && besideLeger(s.box))) continue;
    out.push({ box: fbox, code });
  }
  // **两个八分的「符尾」连到一起**：左边那根干的符尾弯下来正落在右邻同朝向那根干的尖上（我一生要赞美你 m14 F4–D4），
  // 右边那根尖上自己的窗口是空的——照抄左邻那道。干尖要落在那道符尾盒里、离盒右缘不过 0.3 格
  const flagged = out.slice();
  /** 干尖往头那边一格内，有一行在干左边 0.25 格内就有墨（谱线行不算）。 */
  const touchesLeft = (b: { cx: number; far: number; up: boolean }) => {
    const x = Math.round(b.cx);
    const y0 = Math.round(b.up ? b.far : b.far - sp * 1.2), y1 = Math.round(b.up ? b.far + sp * 1.2 : b.far);
    for (let y = Math.max(0, y0); y <= Math.min(bin.h - 1, y1); y++) {
      if (lineYs.some((ly) => Math.abs(ly - y) <= unit.lineThick)) continue;
      let xx = x;
      while (xx > x - sp * 0.3 && xx >= 0 && bin.data[y * bin.w + xx]) xx--; // 干自己
      const edge = xx;
      while (xx >= 0 && edge - xx <= sp * 0.25 && !bin.data[y * bin.w + xx]) xx--;
      if (xx >= 0 && edge - xx <= sp * 0.25) return true;
    }
    return false;
  };
  for (const b of bare) {
    const f = flagged.find((q) => {
      const qUp = q.code.endsWith("Up");
      if (!(qUp === b.up && b.cx > q.box.x + sp * 0.5 && b.cx <= q.box.x + q.box.w + sp * 0.3 && b.far >= q.box.y - 2 && b.far <= q.box.y + q.box.h + 2)) return false;
      // 还得真连上：干尖落在那道尾的末端一侧（万古磐石 m2 弯下来接在谱线上），或尾墨贴着这根干（我一生 m14）。
      // 只看盒子的话，左邻八分的符尾盒伸到了右边那个四分的干上也照抄（有一位神 m3 A4 读成八分：干尖与左邻齐平、空着 0.8 格）
      const fromStart = (qUp ? b.far - q.box.y : q.box.y + q.box.h - b.far) / q.box.h;
      return fromStart >= 0.3 || touchesLeft(b);
    });
    if (f) out.push({ box: { ...f.box, x: Math.round(b.cx) }, code: f.code });
  }
  return out;
}

/**
 * 符尾窗口的墨占比门槛。
 *
 * 原来 0.25，收窄窗口之前是对的；收窄之后真符尾落在 **0.17~0.21**、
 * 真四分仍是 0.00（中间还是没人，只是整条尺子往下挪了）。
 * 扫过 0.10 / 0.14 / **0.16~0.18** / 0.20 / 0.22 / 0.25：
 * 时值 91.9 / 92.0 / **92.1** / 92.0 / 91.0 / 89.4%。
 * 0.18 → 0.15：低分辨率放大的万古磐石歌符尾只有三五像素粗，窗口占比 0.13~0.16。独唱谱时值 84.44 → 84.50%
 *（主使我喜乐 87.4 → 88.5、万古磐石歌 38.5 → 39.1%），合唱谱各档不退；0.12 时合唱谱干净档满拍自检 66.02 → 65.69%。
 */
const FLAG_INK = 0.15;

/**
 * 符尾那个窗口的**横向范围**（线距的倍数，从符干中心往右算）。
 *
 * 原来放到 1.5 格，太宽：这套底本的八分符尾是**一条细弧**，
 * 从符干尖端斜挂下来、横跨也只有 0.9 格（实测破碎 p2 x453 那个八分，
 * 符尾占 x453~468、纵跨 2.7 格，每行只有两三个像素）。
 * 窗口比符尾宽出一半，占比就被空白摊薄。
 * 扫过 0.8 / **1.0** / 1.3：时值 92.1 / 92.1 / 90.9%。
 */
const FLAG_X = [0.15, 1.0] as const;

const FLAG_LEFT = 0.25;

/** 符尾窗口的**纵向长度**（线距的倍数，从符干尖端往符头方向）。
 *  放到 2.5 格（罩住整条符尾）实测更差：符尾下半截是根细线，多罩进来的全是白的。 */
const FLAG_Y = 1.5;

/**
 * 贴着符干尖端那一小截要的墨（`FLAG_INK` 的伙伴）。
 *
 * 这一档**比整窗那一档松得多**：符尾在尖端是**贴着符干**走的（实测破碎 p2 x453
 * 那个八分，尖端往下 0.35 格里符尾只占符干右侧一两列，而窗口从 0.15 格外才开始数），
 * 拿整窗的门槛卡这一截，真符尾一个都过不去。这条闸要的只是「符尾确实从尖端长出来」，
 * 不是「这里墨很多」。
 */
const FLAG_TIP = 0.05;

/**
 * 那一小截的**纵向长度**（线距的倍数）。原来 0.35：合唱谱那套符尾在尖端就贴着符干。
 * 万古磐石歌那种老铅字的符尾从尖端**细细地**长出来，往下 0.3 格才变粗（放大后线距 22px，
 * 尖端 8 行里符干右侧只有一两个像素），八分整批读成四分。
 * 扫过 0.35 / 0.5 / **0.6**：万古磐石歌时值 22.4 / 23.0 / **31.6**%，别的曲子与合唱谱不动。
 */
const FLAG_TIP_Y = 0.6;

/** 第二道钩（十六分）的门槛。比第一道**严**：那一段窗口里还可能扫到下一个音的符干或符头。
 *  0.3 → 0.25：有了右缘双峰 / 贴干两段的形状判据兜底，万古磐石歌的细钩（0.28~0.29）才过得去，时值 64.9 → 67.2%；
 *  0.2 与 0.25 一样，合唱谱扫描件满拍自检略退。 */
const FLAG_INK2 = 0.25;

/** 线宽过了这么多格才往里找符尾的连接点（细线页只看尖端，防弧线）。 */
const FLAG_REACH_LW = 0.15;

/** 两道钩的右缘轮廓中间要凹下去这么多格。 */
const HOOK_PROM = 0.15;

/** 符尾窗口与和弦字母条交叠超过这一成就不认。 */
const FLAG_AVOID = 0.2;
/** 出块盖住一个已认实心头的比例上限（见用处）。 */
const FLAG_ON_HEAD = 0.5;

/** 干尖顺着干往外延的上限（格）。 */
const FLAG_TIP_EXT = 2.0;

/** 干尖顺着干要延出这么多（格），才从延出的真干尖重找符尾、补判第二道钩。 */
const FLAG_GLUED = 0.5;

/** 第二道钩：干右侧竖扫能数出两段黑的列至少占这么多。 */
const FLAG_COLS2 = 0.25;

/** 竖扫只扫到干右侧这么远（格）：再往外，八分长尾回弯的尖也会被数成第二段。 */
const FLAG_COLS_X = 0.6;

/** 符干两端离干上的头心都不过这么多格：是两个头之间被切出来的一截干，没有自由端，不找符尾。
 *  0.75 → 1.0：我灵镇静低音谱表 C4/A3 和弦的干被加线切成两截，上一截下端离 A3 头心 0.94 格，
 *  A3 头的右半边被当成了八分符尾。 */
const FLAG_BOTH_ENDS = 0.95;

/** 位图符杠 → 矢量路的 `BeamShape`（`buildNotes` / `findTuplets` 吃这个）。 */
export function toBeamShapes(beams: BeamQuad[]): BeamShape[] {
  return beams.map((b) => {
    const box: Box = { left: b.box.x, right: b.box.x + b.box.w, top: b.box.y, bottom: b.box.y + b.box.h };
    return { box, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, level: 0 };
  });
}

/** 杠端续到干：干在杠端外这个范围（格）里；过了 `BEAM_SNAP_FAR` 格的另加两道（见下）。 */
const BEAM_SNAP = [0.2, 1.5] as const;

const BEAM_SNAP_FAR = 1.0;

/** 杠端续到干：干的一端离杠延长线不过这么多格；杠端与干之间沿杠走向有墨的列占比下限。 */
const BEAM_SNAP_END = 0.75;

const BEAM_SNAP_INK = 0.8;

/**
 * **杠端没够着干的，续到干上**：斜的网点杠靠干那一截薄、又有网孔，检出的杠盒比真杠短半格
 *（当我们回到天家 m2：杠从 x=712 起，干在 704），`beamConnect` 的容差只有 0.2 格，那根干就接不上杠、八分读成四分。
 * 杠端外 `BEAM_SNAP` 格内有根干、干的一端正落在杠的延长线上、中间沿杠走向（杠厚上下各放一像素）的列大多有墨，就把杠端挪到干上。
 * 一格开外的（破碎扫描版 p6 m74 男低 A3–G3 一对八分：杠压在第一线上，杠尾那截薄、横向断开进不了杠的掩模，杠停在离干 1.26 格处）
 * 另加两道：这一段沿杠的墨要比线厚两像素以上（压在线上时线墨处处都有，只看有没有墨等于没判），那根干也还没挂别的杠
 *（只按有没有墨续到 1.5 格，望十架、破碎干净版各错接几处，十六分读成三十二分）。
 */
export function snapBeamEnds(beams: BeamShape[], stems: Seg[], bin: Binary, sp: number, lineThick: number): void {
  const yAt = (b: BeamShape, x: number) => (b.x1 === b.x0 ? b.y0 : b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0));
  for (const b of beams) {
    const half = (b.box.bottom - b.box.top) / 2 + 1;
    const inkCol = (x: number): boolean => {
      const cy = yAt(b, x);
      for (let y = Math.round(cy - half); y <= Math.round(cy + half); y++) if (y >= 0 && y < bin.h && bin.data[y * bin.w + x]) return true;
      return false;
    };
    /** 这一列沿杠（上下各一个杠厚）最长的竖墨比线厚两像素以上 */
    const thickCol = (x: number): boolean => {
      const cy = yAt(b, x);
      let run = 0, best = 0;
      for (let y = Math.round(cy - half * 2); y <= Math.round(cy + half * 2); y++) (run = y >= 0 && y < bin.h && bin.data[y * bin.w + x] ? run + 1 : 0), (best = Math.max(best, run));
      return best >= lineThick + 2;
    };
    const beamedElsewhere = (st: Seg) => beams.some((o) => o !== b && st.cx >= o.box.left - 3 && st.cx <= o.box.right + 3 && st.bottom >= o.box.top - sp * 0.4 && st.top <= o.box.bottom + sp * 0.4);
    for (const side of [0, 1] as const) {
      const end = side === 0 ? b.x0 : b.x1;
      let got: Seg | null = null;
      for (const st of stems) {
        const d = side === 0 ? end - st.cx : st.cx - end;
        if (d < sp * BEAM_SNAP[0] || d > sp * BEAM_SNAP[1]) continue;
        const y = yAt(b, st.cx);
        // 干从杠的高度穿过去、离杠端不到半格的也续：多层杠里靠头那一层，干端在外层杠上（破碎扫描版 p7 m84 A3，第二层杠停在干前 3.9 像素）
        const through = d <= sp * 0.5 && st.top < y && st.bottom > y;
        if (!through && Math.min(Math.abs(st.top - y), Math.abs(st.bottom - y)) > sp * BEAM_SNAP_END) continue;
        if (d > sp * BEAM_SNAP_FAR && beamedElsewhere(st)) continue;
        if (!got || Math.abs(st.cx - end) < Math.abs(got.cx - end)) got = st;
      }
      if (!got) continue;
      const xa = Math.round(Math.min(got.cx, end)) + 1;
      const xb = Math.round(Math.max(got.cx, end)) - 1;
      let n = 0;
      let k = 0;
      const far = Math.abs(got.cx - end) > sp * BEAM_SNAP_FAR;
      for (let x = xa; x <= xb; x++, n++) if (far ? thickCol(x) : inkCol(x)) k++;
      if (n && k < n * BEAM_SNAP_INK) continue;
      const y = yAt(b, got.cx);
      if (side === 0) {
        b.x0 = got.cx;
        b.y0 = y;
        b.box.left = Math.min(b.box.left, got.cx);
      } else {
        b.x1 = got.cx;
        b.y1 = y;
        b.box.right = Math.max(b.box.right, got.cx);
      }
    }
  }
}
