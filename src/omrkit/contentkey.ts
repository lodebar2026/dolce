// 像素条的**内容指纹**：`<前缀><宽>x<高>-<FNV-1a 36 进制>`。OCR 离线缓存（`rasteromr/*.json`）与在线结果都按它寻址，
// 几何一动指纹就变、旧缓存自然失效。**格式一字不能改**：改了全部离线缓存要重建。
export function contentKey(prefix: string, w: number, h: number, px: ArrayLike<number>): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < px.length; i++) {
    h1 ^= px[i]!;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `${prefix}${w}x${h}-${h1.toString(36)}`;
}
