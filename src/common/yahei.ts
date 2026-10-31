// Microsoft YaHei（msyh.ttf 的 hmtx，upm 2048）的比例字形字面宽，em 比例。投影片（.pptx）写的就是这个字体、2019 年成品也是，
// 投影档横向按它算；字体本身不随软件分发，这里只记度量。汉字两套字都是 1 em，只有西文数字 / 连字符对不上。
const UPM = 2048;

export const YAHEI_ADVANCE: Readonly<Record<string, number>> = {
  "-": 886 / UPM,
  ".": 493 / UPM,
  "\u00b7": 493 / UPM,
  ...Object.fromEntries([..."0123456789"].map((d) => [d, 1201 / UPM])),
};
