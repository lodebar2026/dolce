// 应用能打开的文件类型。**规则只在这里写一次**——以前散在四处（app.ts 的 PU_EXT_RE、
// main.ts 的 RECOG_EXT_RE、拖放分支里的内联正则、文件对话框的 accept 串），
// 而且已经不一致：浏览器拖放分支根本不做白名单，Tauri 分支做。

/** 文本谱（番茄 / 诗歌本）。`.txt` 太泛，进来后还要靠 sniffDialect 二次确认。 */
export const PU_EXT = ["pu", "fq", "jps", "txt"] as const;
/** 123 格式（简谱主格式，ABC 方言）。UTF-8，一首一文件。 */
export const J123_EXT = ["123"] as const;
/** jianpu-ly 的输入文本。**扩展名是它自己 `--export-jly` 写出来的**（上游 README 命令行选项），
 *  也是判"这是不是 jianpu-ly"的**唯一决定性依据** —— 它的输入里没有版本行 / 签名 / 必需项，
 *  内容嗅探只能是特征猜测，所以不做（详见 `model/fromjly.ts` 文件头）。 */
export const JLY_EXT = ["jly"] as const;
/** 乐谱文档（编辑器直接打开的）。 */
/** 识别项目（原图 + 识别结果 + 在改的原文，`editor/omrproject.ts`）。 */
export const PROJECT_EXT = ["dolce"] as const;
export const DOC_EXT = [
  "jpwabc", ...J123_EXT, ...JLY_EXT, ...PU_EXT, "xml", "musicxml", "abc", ...PROJECT_EXT,
] as const;
// **以前这里有个 `CONVERTED_EXT`**：`.xml`/`.musicxml`/`.abc` 导入后要强制另存为别的格式，
// 所以不记文件路径。现在五种源格式都原生打开、存回原格式，这个概念没有了。

/** 走 OMR 识别的图片 / PDF。 */
export const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "bmp", "gif", "pdf"] as const;

const re = (exts: readonly string[]): RegExp => new RegExp(`\\.(${exts.join("|")})$`, "i");

export const isPuFile = (name: string): boolean => re(PU_EXT).test(name);
export const is123File = (name: string): boolean => re(J123_EXT).test(name);
export const isJlyFile = (name: string): boolean => re(JLY_EXT).test(name);
export const isDocFile = (name: string): boolean => re(DOC_EXT).test(name);
export const isImageFile = (name: string): boolean => re(IMAGE_EXT).test(name);
export const isProjectFile = (name: string): boolean => re(PROJECT_EXT).test(name);

/** `<input type=file accept>` 用的串。 */
export const acceptAttr = (exts: readonly string[]): string => exts.map((e) => `.${e}`).join(",");

/** 图片选择框的 accept（MIME + 扩展名双保险：部分浏览器只认其一）。 */
export const IMAGE_ACCEPT =
  "image/png,image/jpeg,image/webp,image/bmp,image/gif,application/pdf,.pdf";
