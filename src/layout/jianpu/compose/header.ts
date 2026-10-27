// 页眉：标题、副标题、词曲、调号拍号、TL/TR、XL/XR。位置由 place/header.ts::placeHeader 定，这里只照它画。
import { barlineSpan, type JianpuGrid } from "../metrics";
import { Font } from "../../../pagetree/font";
import { Group } from "../../../pagetree/pageitem";
import { TimeSigGlyph } from "../../../engrave/timesig";
import { KeyLabel, keyNameOf } from "../../../engrave/keysig";
import { EQ_PAD_EM } from "../../../engrave/spacing";
import { emptyMetadata, type Meter } from "../../../jianpu/ast";
import { timeSigRule, type HeaderMeasurer, type HeaderTextRole, type PlacedHeader, type PlacedHeaderLine } from "../place/header";
import { type OriginalCtx, text } from "./ctx";
import { textItem } from "../../../engrave/prims";

/** 页眉各角色的字（`scale` 是窄纸缩排倍率，只作用于标题、副标题、经文、署名）。 */
export function headerRoleFont(m: JianpuGrid, role: HeaderTextRole, scale = 1): Font {
  const hs = m.style.header;
  const fam = m.style.font.text.family;
  switch (role) {
    case "title": return new Font(hs.title.family ?? fam, hs.title.size * scale, true);
    case "subtitle": return new Font(hs.subtitle.family ?? fam, hs.subtitle.size * scale, false);
    case "scripture": return new Font(hs.scripture.family ?? fam, (hs.scripture.size ?? hs.subtitle.size) * scale, false);
    case "credit": return new Font(hs.credit.family ?? fam, hs.credit.size * scale);
    case "top": return new Font(fam, m.style.size.header);
    case "index": return new Font(fam, hs.title.size * 0.62);
    case "tempo": return new Font(fam, m.style.size.keyMeter * 0.85);
    case "slide-title": return slideFont(m, hs.title, hs.title.size);
    case "slide-subtitle": return slideFont(m, hs.subtitle, hs.subtitle.size);
    case "slide-scripture": return slideFont(m, hs.scripture, hs.scripture.size ?? hs.subtitle.size);
    case "slide-credit": return slideFont(m, hs.credit, hs.credit.size);
    case "slide-footer": return new Font(m.style.font.lyric.family, m.style.size.lyric * 0.8);
  }
}

/** 展开档标题页的字：设置里给了族 / 粗体就用，否则歌词字、不加粗（同旧简谱引擎 `headerRoleFont(…, lrcFont)`） */
function slideFont(m: JianpuGrid, face: { family?: string; bold?: boolean }, size: number): Font {
  return new Font(face.family ?? m.style.font.lyric.family, size, face.bold ?? false);
}

/** 页眉量具（place/header.ts 用）：角色字按出厂字号量（缩排倍率由定位端乘）；调号拍号行的墨迹上下缘与「=」中心。 */
export function headerMeasurer(m: JianpuGrid): HeaderMeasurer {
  const fonts = new Map<HeaderTextRole, Font>();
  const fontOf = (role: HeaderTextRole): Font => fonts.get(role) ?? fonts.set(role, headerRoleFont(m, role)).get(role)!;
  const headFont = new Font(m.style.font.text.family, m.style.size.keyMeter);
  return {
    headerText: (str, role) => ({ advance: fontOf(role).measureText(str), ink: fontOf(role).charBound(str) }),
    keyLine(meter: Meter | undefined) {
      // 拍号取分子墨迹顶、分母墨迹底（分数线对准「=」，同 paintHeader 的落位）；没有拍号就只看调号字母
      const f = headFont.charBound("F");
      const eq = headFont.charBound("=");
      const eqMid = (eq.top + eq.bottom) / 2;
      let top = f.top, bottom = f.bottom;
      if (meter) {
        const meterY = eqMid + timeSigRule(m) / 2;
        const r = new TimeSigGlyph(meter.numerator, meter.denominator, {
          height: m.style.vertical.barlineHeight, centerY: 0, ruleWidth: timeSigRule(m), color: 0, font: headFont,
        }).box();
        top = Math.min(top, meterY + r.top);
        bottom = Math.max(bottom, meterY + r.bottom);
      }
      return { top, bottom, eqMid };
    },
  };
}

/** 展开档的标题页、页脚各行（`placeTitlePage` / `placeSlideFooter` 定好的位置；居中按页宽）。文字标 `hdr`（标题页，可视化编辑认页眉）。 */
export function paintSlideLines(c: OriginalCtx, root: Group, lines: readonly PlacedHeaderLine[], tag: boolean): void {
  const anchor = { left: 0, center: c.pageWidth / 2, right: c.pageWidth };
  for (const l of lines) {
    // 不带逐字笔位（同旧简谱引擎的标题页、页脚）：PPTX 见到逐字笔位会拆成逐字文本框，页码「1/4」就散成三个框
    const t = textItem(l.text, headerRoleFont(c.metrics, l.role), c.ink, anchor[l.anchor] + l.dx, l.baseline, false);
    if (tag) t.classes.add("hdr");
    root.add(t);
  }
}

export function paintHeader(c: OriginalCtx, root: Group, songIndex: number, systemLeft: number): void {
  const head = c.heads?.[songIndex] ?? c.heads?.[0];
  if (!head) return;
  const before = root.children.length;
  paintHeaderItems(c, root, head, songIndex, systemLeft);
  // 可视化编辑认页眉：文字标 `hdr`（按字对回原文的字段），调号、拍号另标 `hdr-keysig` / `hdr-time`（`headerParts`）
  for (const it of root.children.slice(before)) {
    if (!it.classes.has("hdr-keysig") && !it.classes.has("hdr-time")) it.classes.add("hdr");
  }
}

function paintHeaderItems(c: OriginalCtx, root: Group, head: PlacedHeader, songIndex: number, systemLeft: number): void {
  const m = c.metrics;
  const meta = c.doc?.songs[songIndex]?.metadata ?? c.doc?.songs[0]?.metadata ?? emptyMetadata();
  // 连续长图会按内容收窄页宽，所以居中/右对齐都要用**实际**页宽，不能用 metrics 里的纸张宽
  const anchor = {
    left: systemLeft,
    center: c.pageWidth / 2 - c._pageShiftX,
    right: c.pageWidth - m.page.margin.right - c._pageShiftX,
  };
  for (const l of head.lines) {
    root.add(text(l.text, anchor[l.anchor] + l.dx, l.baseline, headerRoleFont(m, l.role, head.scale), c.ink));
  }

  const keyY = head.keyBaseline;
  const headFont = new Font(m.style.font.text.family, m.style.size.keyMeter);
  const tonic = meta.tonic ?? "1";
  let x = systemLeft;
  // 调号走公共那一份（engrave/keysig.ts）：升降号是 SMuFL csym 字形并抬高，`=` 两侧各让一点。
  const keyName = meta.mode ? keyNameOf(meta.mode) : null;
  if (keyName) {
    const k = new KeyLabel(tonic, keyName, {
      font: headFont,
      music: new Font("Bravura", headFont.size),
      color: c.ink,
      side: m.style.look.accidentalSide,
      classes: ["hdr-keysig"],
    });
    for (const it of k.items) {
      it.x += x;
      it.y += keyY;
      root.add(it);
    }
    // 调号 → 拍号的**墨迹**间距 = 「=」→ 调号的墨迹间距（用户口径）；分数线左端就是拍号墨迹左缘
    x += k.inkRight + (k.nameInkLeft - k.eqInkRight);
  } else if (meta.mode) {
    // 认不出的调名（不是「字母 + 升降」）照原文写，`=` 两侧照样让空
    const pad = headFont.size * EQ_PAD_EM;
    for (const [i, part] of [tonic, "=", meta.mode].entries()) {
      if (i > 0) x += pad;
      const t = text(part, x, keyY, headFont, c.ink);
      t.classes.add("hdr-keysig");
      root.add(t);
      x += headFont.measureText(part);
    }
    x += pad;
  }
  // 拍号的分数线与调号的「=」**视觉居中**（用户口径；偏移见 placeHeader 的 meterDy）
  const meterFrom = root.children.length;
  for (const meter of meta.meters) {
    x += paintMeter(c, root, x, keyY + head.meterDy, meter, headFont) + 14;
  }
  for (const it of root.children.slice(meterFrom)) it.classes.add("hdr-time");
}

/**
 * 分数式拍号（分子在上、分母在下、中间一横）。返回占用的宽度。
 * 头部的调号拍号与小节线上的临时拍号共用。
 */
export function paintMeter(c: OriginalCtx,
  root: Group,
  x: number,
  y: number,
  meter: { numerator: number; denominator: number },
  font: Font,
): number {
  // 尺寸走公共那一份：**一切长度都是小节线高度的比例**（engrave/timesig.ts::TimeSigGlyph），
  // 两个数字横向居中于分数线。原先这里各按 `font.size` 的 0.42/0.62/0.1 给，
  // 与谱面、混排三处口径各不相同。
  const r = new TimeSigGlyph(meter.numerator, meter.denominator, {
    height: c.metrics.style.vertical.barlineHeight,
    centerY: (barlineSpan(c.metrics).top + barlineSpan(c.metrics).bottom) / 2,
    ruleWidth: timeSigRule(c.metrics),
    color: c.ink,
    font,
  });
  for (const item of r.items) {
    item.x += x;
    item.y += y;
    root.add(item);
  }
  return r.width;
}
