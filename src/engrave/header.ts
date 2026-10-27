// 页眉文字（标题、副标题、经文、词曲）的字体：旧简谱引擎与五线谱/混排共用一个取法。
import { Font } from "../pagetree/font";
import type { HeaderFont } from "../style/header";

/**
 * 某一角色的页眉字：设置/样式表给了族或粗体就用，没给的沿用 `base`（各引擎自己的出厂字：
 * 旧简谱引擎是歌词字体、五线谱是 credit 自带的字）。字号由调用方定。
 */
export function headerRoleFont(hf: HeaderFont | undefined, size: number, base: Font): Font {
  if (!hf?.family && hf?.bold === undefined) return base.makeWithSize(size);
  return new Font(hf.family ?? base.family, size, hf.bold ?? base.bold, base.italic);
}
