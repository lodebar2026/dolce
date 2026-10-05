// 帮助对话框：四个标签页（功能帮助、可视化编辑、记谱法、关于）。只读，自建 overlay（参照 export.ts 的
// showExportDialog），复用 .modal-overlay/.modal-box 样式 + 本文件专属的 .help-* 样式。
// 功能帮助 = 可展开主题列表（<details>）；记谱法 = 分节说明 + 实时渲染的 SVG 示例。
import type { App } from "./app";
import { PaintResources, ScorePainter } from "../layout/painter";
import { JpwFile, LayoutSection } from "../jpword/jpwfile";
import { jpwToScoreDoc } from "../model/fromjpw";
import { jianpuInputOfDoc, jianpuInputOfJpw } from "../model/jianpuinput";
import { parse123 } from "../j123/parse";
import type { JScore } from "../layout/input";
import type { StyleSheet } from "../style/sheet";
import { THEMES, computeStyleForPaper, themeOfMode } from "../style/themes";
import { PlayItem } from "../score/playorder";
import type { MetaData } from "../smufl/smufl";
import { isTauriRuntime } from "./fileio";
import { FEEDBACK_EMAIL, openFeedbackMail } from "./feedback";
import { VISUAL_ACTIONS, groupLabel } from "./visual/keys";
import { getLang, t } from "../i18n";
import { FEATURE_TOPICS_EN, GLOSSARY_EN, NOTATION_TEXT_EN, SHORTCUTS_EN, VISUAL_TOPICS_EN } from "./help.en";
import { EXAMPLES_123_TEXT_EN, GLOSSARY_123_EN, INTRO_123_EN } from "./help123.en";
import { EXAMPLES_123, GLOSSARY_123, INTRO_123, SPEC_123_URL, wrap123, type NotationExample } from "./help123";
import {
  APP_VERSION, HOMEPAGE, checkForUpdate, isAutoCheckEnabled, openExternal,
  promptUpdate, setAutoCheckEnabled,
} from "./update";

// ---- 记谱法示例的渲染 -------------------------------------------------------
// 从 app.ts 搬来：它用的是一次性的 painter、不碰实时谱面，和编辑器本身没有关系，
// 只有本文件（帮助对话框的「记谱法」页）调它。

/**
 * Render a standalone `.jpwabc` snippet to its own `<svg>` for the help /
 * notation documentation examples. Returns null on parse/layout failure so
 * the caller can silently drop unsupported examples.
 * The svg keeps the full page viewBox; crop to content via getBBox after it
 * is attached to the DOM.
 *
 * `titlePage: true` renders the standalone title page (Title/SubTitle/credit/
 * expression layout); otherwise renders the first content page with its
 * footer (running title + page number) stripped so only the music remains.
 */
export function renderExampleSvg(meta: MetaData, jpwabc: string, opts: ExampleOpts = {}): SVGSVGElement | null {
  let f: JpwFile | null;
  try {
    f = JpwFile.fromString(jpwabc);
  } catch {
    return null;
  }
  if (!f) return null;
  let score;
  try {
    score = jianpuInputOfJpw(jpwToScoreDoc(f));
  } catch {
    return null;
  }
  if (!score) return null;
  return renderExampleScore(meta, score, f.getSection(LayoutSection)?.desc ?? null, opts);
}

/** 同上，源码是 123：`parse123` → `jianpuInputOfDoc`（与编辑器里 123 的原样档同一条投影）。有 error 诊断即不画。 */
export function render123ExampleSvg(meta: MetaData, text: string, opts: ExampleOpts = {}): SVGSVGElement | null {
  let score;
  try {
    const doc = parse123(text);
    if (doc.diagnostics.some((d) => d.severity === "error")) return null;
    score = jianpuInputOfDoc(doc);
  } catch {
    return null;
  }
  if (!score) return null;
  return renderExampleScore(meta, score, null, opts);
}

interface ExampleOpts { width?: number; height?: number; titlePage?: boolean }

/** 示例用的样式表：**出厂的原样档**（印刷主题），不带当前文档与用户的纸张、字体层。
 *  与编辑器原样档同一套预设——多段词叠排、反复不展开、和弦与段落词、标题块排在谱行上方。 */
let exampleStyle: StyleSheet | null = null;
function exampleStyleSheet(): StyleSheet {
  return (exampleStyle ??= computeStyleForPaper([THEMES[themeOfMode("original")]], { mode: "original", engine: "jianpu" }));
}

/** 一次性 painter 排一份引擎输入、取第一页（不碰实时谱面，共用 App 的 SMuFL 元数据）。 */
function renderExampleScore(
  meta: MetaData,
  score: JScore,
  breakDesc: string | null,
  opts: ExampleOpts,
): SVGSVGElement | null {
  // 纸宽约等于卡片宽（1:1 显示）：长示例在纸上折行，而不是排成一长条再整体缩小
  const width = opts.width ?? 760;
  const height = opts.height ?? 540;
  // Lyric-less snippets get pass=0 → empty playData → blank layout. Synthesize
  // a single play pass over all measures so examples without lyrics still render.
  if (score.playData.measures.length === 0 && score.parts[0]) {
    const pi = new PlayItem();
    pi.pass = 1;
    pi.mid = 0;
    pi.end = score.parts[0].measures.length;
    score.playData.measures.push(pi);
    score.playData.isSimpple = true;
  }
  const p = new ScorePainter(PaintResources.fixed(meta));
  try {
    p.loadSync({
      view: "original",
      score,
      breakDesc,
      style: exampleStyleSheet(),
      // 示例画在压暗的米白纸上（styles.css 的 --help-paper），墨色也从纯黑收一档，
      // 免得深色界面上黑白对比过硬。真正的谱面预览仍是纯白纸 + 用户设定的颜色。
      ink: 0xff1a1a1a,
      page: { w: width, h: height },
      // 带标题的示例排原样档的第一页（标题块 + 谱行）；其余只排谱行
      snippet: !opts.titlePage,
    });
    if (p.pageCount === 0) return null;
    return p.renderPage(0);
  } catch {
    return null;
  }
}


// ---- 小工具 ----------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 内联富文本：把 `**粗**`、`` `代码` `` 转成 span，避免手搓一堆 createElement。 */
function rich(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] != null) frag.append(el("strong", undefined, m[1]));
    else if (m[2] != null) frag.append(el("code", "help-code", m[2]));
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function para(text: string, cls = "help-p"): HTMLParagraphElement {
  const p = el("p", cls);
  p.append(rich(text));
  return p;
}

// ---- 功能帮助 --------------------------------------------------------------

type Badge = "desktop" | "browser" | "mac";
const badgeText = (b: Badge): string => t(`help.badge.${b}`);

interface Topic {
  title: string;
  badges?: Badge[];
  /** 段落文本（支持 **粗** 与 `代码`）。 */
  body: string[];
  /** 可选：额外自定义节点（如快捷键表）。 */
  extra?: () => HTMLElement;
}

const FEATURE_TOPICS_ZH: Topic[] = [
  {
    title: "打开、保存与另存为",
    body: [
      "从开始页的 **导入乐谱** 打开，或直接把文件拖入页面：123（`.123`，简谱主格式，见「123 格式」页）、`.jpwabc`（JP-Word）、jianpu-ly（`.jly`，上游 Silas S. Brown 的 jianpu-ly 文本谱，可直接排成 LilyPond）、文本谱（番茄简谱 / 诗歌本，`.pu` `.fq` `.jps` `.txt`）、MusicXML（`.xml` / `.musicxml`）、ABC（`.abc`）、Muse 曲谱软件（`.jcx`），以及识别项目 `.dolce`（见「识别项目」）。",
      "右上角 **保存** 按原格式存回（`.jpwabc` 与 JP-Word 兼容）；**另存为** 可换成 123、JPWABC、ABC、番茄简谱、诗歌本文本谱、jianpu-ly、Muse 简谱（`.jcx`，新旧版 Muse 都能打开）——换格式前会列出目标格式装不下的内容，确认后才写；**导出** 生成 PPTX、MIDI、MusicXML、jianpu-ly（`.jly`，可直接交给上游 `jianpu-ly` 排 LilyPond），五线谱 / 混排下还有 PNG、PDF。",
      "代码区标题栏的格式下拉可把识别结果或刚打开的文件直接切成别的格式来编辑，切回「原文」即可还原。",
      "**桌面版**：打开/保存用系统原生对话框，可直接写回磁盘；下次启动会自动恢复上次打开的文件。**浏览器版**：用网页文件选择器打开，保存则以下载方式导出。",
    ],
  },
  {
    title: "编辑与实时排版",
    body: [
      "左侧是带语法高亮的源码编辑区，**边打字边重排**——停顿约 0.2 秒后右侧谱面自动更新。",
      "**点选**：在谱面上点音符、歌词，代码区同步定位；也可以直接在谱面上改谱，见「可视化编辑」页。",
      "MusicXML 没有源码区；混排、识别核对时代码区只读或隐藏（详见对应主题）。",
    ],
  },
  {
    title: "翻页与缩放",
    body: [
      "**翻页**：底部状态栏 上一页 / 下一页，或键盘 `PageUp` / `PageDown`；`Ctrl/⌘+Home` 跳首页、`Ctrl/⌘+End` 跳末页。",
      "**缩放**：底部状态栏 `−` / `100%` / `＋`，或 `Ctrl/⌘ +` / `-` / `0`，或按住 `Ctrl/⌘` 滚滚轮。",
      "**macOS 桌面版**还支持触控板双指捏合缩放。",
    ],
  },
  {
    title: "图片识谱",
    body: [
      "把简谱**图片或 PDF**（PNG/JPG/WEBP/PDF）拖进页面，或点开始页 **图片识谱**，会自动识别成 123 简谱并载入编辑，四声部简谱按声部分开。识别在**本地离线**完成，图片不会上传，浏览器版和桌面版都能用。",
      "**五线谱**也能识别：文字层完整的五线谱 PDF 直接读文字与矢量；扫描、拍照的五线谱图片或 PDF（独唱谱、合唱谱、简线混排谱）走位图识别，结果进五线谱 / 混排视图，谱面上可直接改（见「可视化编辑 → 编辑 MusicXML」）。独唱谱较可靠（音符约 97%），合唱谱扫描件需要较多校对。",
      "**走哪条路**：缺省按页面上有没有五线谱表自动判断（看前三页，封面目录页不算）；起始页与工具栏的 **识别为** 可改成「简谱」或「五线谱」，工具栏那个改了会用刚才那份图重新识别。一次拖入或选中几张图（五线谱的多页）按文件名排成一首；简谱一次识别一张。五线谱识别逐页显示进度，按 `Esc` 取消。",
      "识别完成后默认进入「二值图 + 半透明识别结果叠加」的核对视图，对着原图核对的方式都在底部状态栏的 **核对** 下拉里：不核对（只看排版稿）/ 并排原图 / 原图片段 / 附近浮窗 / 原位叠加 / 仅原图——前三种都在可编辑的排版稿里，后三种进核对视图。状态栏的 **源码** 复选框随时可勾掉，收起代码区让谱面占满（并排时原图与排版稿各占一半）。",
      "**在核对视图上直接改**：点识别框选中那个音（或歌词字），键盘、右键菜单、记号面板与排版稿完全一样；改完叠加层立刻按原图位置重画——改过的音标青色、删掉的划掉变灰、新插的音按前后两个音插位并加青色虚框，改过的歌词在原位盖上新字。小节拍数不对的红框也随改随变。（123 与文本谱格式的识别结果可以这样改；输出成 JPWABC / ABC 时核对视图只能看。）",
      "**五线谱识别的原图对照**（扫描 / 拍照的五线谱，以及文字层完整的五线谱 PDF）：状态栏 **核对** 选 附近浮窗 / 原位叠加 / 仅原图，逐页显示原图，每个识别出的音一个框、框上标它现在的音名；在对照上点框就能改，改过的标青、删掉的划掉。",
      "**可疑项**（简谱识别）：识别时把握不大的音与歌词字在核对视图里用**黄色虚框**标出——比同一行高出一截的「音」（多半是小字附注）、正上方像有高音点却没认出来的、八度点形状不像点的、歌词字认得没把握的。底部状态栏的 **N 处可疑** 点一下跳到下一处并选中它，状态栏左边写着为什么可疑；改过的音、改过的字就不再标。标黄的不一定错（在测试曲目上大约十处里有一两处真错），但真错的大多会被标出来，校对时先看这些。",
      "**原图页**（工具栏，识别过的谱才有）：列出这次识别用的几份原图，可以调顺序、删掉、再加几张，图片还能顺时针转 90°（横着拍的）、裁剪（按住拖出要留的那块，裁掉页边或旁边的另一页），行可以拖动换顺序，改完点 **按这些页重新识别** 整首重跑（谱面上已做的修改会丢，事先会问）。PDF 只能调顺序和删。起始页勾上 **识别前先调整原图**，选图或拖图后会先弹这个面板，摆好了点「开始识别」。不支持只重跑某一页：各页的拍号调号是接着前一页的。",
      "**并排原图**（状态栏 **核对** 下拉，识别过的谱才有）：回到排版稿后，左边铺整页原图、右边是排版稿。排版稿里选中哪个音，原图上那个音就框出来并滚到眼前；在原图上点一个音，排版稿里就选中它（接着可以直接改）。简谱、扫描的五线谱都能用；再点一次收起。并排时取消状态栏的 **源码** 勾选，原图与排版稿各占一半。",
      "**原图片段**（状态栏 **核对** 下拉，识别过的谱才有）：打开后回到排版稿，选中哪个音，右下角小窗就显示原图上那一行并框出这个音，边看排版稿边对原谱。",
      "识别结果建议再人工校对——尤其是歌词和复杂节奏。",
    ],
  },
  {
    title: "识别项目（.dolce）与自动保存",
    body: [
      "识别过的谱点 **保存**，存的是**识别项目** `.dolce`：原图（或原 PDF）、识别结果、正在改的谱一起打成一个文件。以后打开它（开始页导入、拖入都行）直接回到原图对照接着校对，**不用重新识别**；输出格式、识别为、对照方式也照存的还原。简谱项目连原图对照的点选位置一起存；五线谱项目第一次进原图对照时会从存着的原图把对照数据补回来（要等一会儿）。",
      "只想要谱本身：用 **另存为** 存成 123 / MusicXML / 文本谱等普通格式（不带原图，重开后就没有原图对照了）。",
      "撤销历史不随文件保存：重开后从存盘那一刻开始可撤销。识别项目里有原图，文件比普通谱大（一张图几百 KB）。",
      "**自动保存**：改过还没存的内容，停手约 3 秒就在本机（浏览器存储，桌面版同样）存一份草稿；识别中的谱连原图一起存。意外关掉、刷新或崩溃后再打开，会问要不要恢复——恢复后还算没存盘，记得保存；选不恢复草稿就丢掉。存盘或打开别的文件后草稿自动作废。只留最近一份；隐私窗口或禁用了网站存储时不自动保存。",
    ],
  },
  {
    title: "导入 ABC / MusicXML",
    body: [
      "**ABC 记谱**（`.abc`）：原生解析、排为简谱，可直接编辑并按原文保存；支持多声部、反复、一二房、和弦、装饰音、歌词等。",
      "**MusicXML**（`.xml` / `.musicxml`）：单声部歌谱打开时可选择转成 123 / JPWABC / ABC / 文本谱来编辑，或保持 MusicXML 看五线谱（可在设置里记住选择）；多声部（如四部合唱）直接进入**混排**。",
    ],
  },
  {
    title: "谱面布局",
    body: [
      "右侧「排版」顶部的四档：**展开**（反复与多段歌词逐段展开、一段一页，投影用）、**原样**（按原谱排一遍，多段歌词叠排）、**五线谱**、**混排**（五线谱上再叠一层简谱）。文本格式的五线谱由源码自动生成。",
      "**分行方式**：选择「原始排版」可保留导入或识别时的行结构；选择「按乐句重排」会根据歌词和音乐乐句重新安排换行。文本谱也支持，重排的是左侧代码本身；再点「原始排版」即可逐字还原（Ctrl+Z 也可整体撤销）。",
      "这些工具只会在当前文件支持时出现。",
    ],
  },
  {
    title: "播放",
    body: [
      "工具栏 **试听** 按钮会随状态显示 播放 / 暂停 / 继续；旁边的 ■ 停止并回到曲首。简谱、五线谱、混排与原图对照都用一条纵贯整行（多声部是整个系统）的播放线标出位置，任一声部起音它都跟着走。",
      "**进度条**可拖动定位，右侧显示已播 / 总长（点一下切换成剩余时间）。播放或暂停中点谱面上的音符，会从那个音接着播；停止时点音符或拖进度条，下次从那里开始。",
      "按谱面标注的速度演奏，速度下拉可再调 ×0.5～×2；播放中改速度，从当前位置按新速度接着播。",
      "**循环**（工具条「循环」）：谱面上选了一段（可视化编辑的选区）就反复播这一段，没选循环整首——练某几小节时用。**节拍**：试听时每拍响一声，小节第一拍高一些；6/8 这类复拍子按附点四分打。",
      "多声部时在顶栏 **声部** 面板里调各声部音量，也可静音某个声部、或只听某一个声部（独奏，练声部用）；播放中改了从当前位置接着播。",
      "**macOS 桌面版**可使用系统原生音色，音质更好。",
    ],
  },
  {
    title: "导出",
    body: [
      "顶栏 **导出**。简谱模式可导出 **PPTX**（矢量，逐页成幻灯片，取展开档）、**MIDI**（含反复/力度/声部音量）和 **MusicXML**。",
      "五线谱 / 混排模式可导出当前页 **PNG**、全部页面 **PDF**、**MIDI** 和 **MusicXML**。导出内容与当前那一档预览（含简谱层的有无）保持一致。换源格式请用 **另存为**。",
    ],
  },
  {
    title: "声部（合唱谱）",
    body: [
      "顶栏 **声部** 打开声部面板，一行一个声部：**名称 / 简称**（改完回车）、**谱号**（高音、男高音用的低八度高音谱号、低音、中音、次中音）、**移调**（单簧管、小号的 B♭ 调，圆号 F 调，中音萨克斯 E♭ 调，八度发声；按记谱写、试听按实际音高，只 MusicXML 可设）、**谱表**（几行谱，钢琴大谱表为 2，只显示）、**可见**（五线谱 / 混排里显示不显示这个声部，只影响显示、不写进文件，试听照样出声）、试听的 **静音 / 独奏 / 音量**、**简谱**（混排的简谱层、MusicXML 的简谱档取哪个声部的旋律）、**歌词**（MusicXML 的简谱展开档改取这个声部的词，按时刻配到旋律上——合唱谱的词常印在女低音下面；都不勾 = 自动，排带词的那个声部）。",
      "右边一排：**↑ ↓** 调顺序、**复制**、**按声线拆**（一行谱里的两条旋律拆成上下两个声部，如 S/A 闭合谱拆成开放谱）、**按和弦拆**（和弦里最低的音拆到下面一个新声部，两部同度的单音两边各一份）、**并入上一个**（反过来合成闭合谱）、**删除**。",
      "底部 **新建声部** 在最后加一个（整小节休止，小节结构照第一声部，谱号先选好）；**歌词从 … 复制到 …** 按同一时刻把歌词抄给另一个声部（目标已有的那一段不覆盖），合唱谱中间一排词供几部共用时用。",
      "每一步立即生效，`Ctrl/⌘+Z` 可撤销。123 / ABC 改名、改谱号只改 `V:` 那一行；增删、排序、拆合要按标准写法整份重出源码（原文里的 `%` 注释会丢，事先会问）。MusicXML 改了声部结构后整首改为自动铺排。",
      "**识别出的五线谱**：面板下方多一张「谱表 ↔ 声部」关联表——每个系统一行、每行谱一个下拉，选它属于第几个声部行、另起新声部，或忽略（比如钢琴伴奏不要）。某个系统少印了一个声部、或识别把行对错了时在这里改，点 **应用** 按新的对应重建（不重新识别；谱面上的改动会丢，事先会问）。",
      "支持程度：MusicXML、123、ABC 全部可用（「并入上一个」只对 MusicXML——123 / ABC 一个声部只写一路旋律；ABC 的谱号不可改）；文本谱、JP-Word 只有试听设置。",
    ],
  },
  {
    title: "简繁转换",
    body: [
      "顶栏 **简繁** 可整篇转换中文——歌词、标题、词曲信息都会转，乐谱代码一字不动；五种格式都能用。",
      "方向可选 自动检测 / 简体 → 繁体 / 繁体 → 简体；自动检测按当前文本的字形判定。歌词里的 `/`、`-` 等记号位置不受影响，词组也不会被它们拆开（`日光/之下` 仍按整词转换）。转换改的是源码本身，`Ctrl/⌘+Z` 可一次撤销。",
    ],
  },
  {
    title: "设置",
    body: [
      "顶栏 **设置** 分三页，只摆当前视图下真正生效的项：**版面**（纸张、方向、边距、谱面比例、每页行数、字号、颜色；五线谱 / 混排还有谱表大小、歌词字号、隐藏小节号）、**页眉与样式**（诗集样式表 `.ss`，标题 / 副标题 / 经文 / 词曲作者的字体字号）、**其他**（界面语言、打开 MusicXML 时的默认做法、改音时发声）。各声部的试听音量在工具栏 **声部** 面板里。",
      "底部「恢复本档默认」只清当前这一档的设置。",
    ],
  },
  {
    title: "界面语言",
    body: [
      "界面支持**中文**与 **English**。首次打开按浏览器 / 系统语言自动选择；在 **设置 → 其他 → 界面语言** 可手动切换，立即生效、无需刷新。",
      "只翻译界面文字；乐谱内容、歌词与记谱代码保持原样。网址加 `?lang=en` 或 `?lang=zh` 也可指定语言。",
    ],
  },
  {
    title: "键盘快捷键",
    body: [],
    extra: shortcutTable,
  },
];

/** 英文表与中文表主题一一对应，结构（徽标、extra）取中文表的。 */
function localized(zh: Topic[], en: { title: string; body: string[] }[]): Topic[] {
  return getLang() === "en" ? zh.map((tp, i) => ({ ...tp, title: en[i]?.title ?? tp.title, body: en[i]?.body ?? tp.body })) : zh;
}

/** 记谱示例同上：示例源码共用，标题与说明按语言取。 */
function localizedExamples(zh: NoteEx[], en: { title: string; body: string[] }[]): NoteEx[] {
  return getLang() === "en" ? zh.map((ex, i) => ({ ...ex, title: en[i]?.title ?? ex.title, body: en[i]?.body ?? ex.body })) : zh;
}

function shortcutTable(): HTMLElement {
  const zhRows: [string, string][] = [
    ["放大 / 缩小", "Ctrl/⌘ +  ·  Ctrl/⌘ -"],
    ["复位缩放 100%", "Ctrl/⌘ 0"],
    ["上一页 / 下一页", "PageUp  ·  PageDown"],
    ["首页 / 末页", "Ctrl/⌘ Home  ·  Ctrl/⌘ End"],
    ["按 Ctrl/⌘ 滚轮", "以指针为中心缩放"],
  ];
  const rows = getLang() === "en" ? SHORTCUTS_EN : zhRows;
  const table = el("table", "help-shortcuts");
  for (const [act, key] of rows) {
    const tr = el("tr");
    tr.append(el("td", undefined, act), el("td", undefined, key));
    table.append(tr);
  }
  return table;
}

function buildFeatureHelp(): HTMLElement {
  const pane = el("div", "help-pane");
  pane.append(para(t("help.featuresIntro"), "help-intro"));
  for (const tp of localized(FEATURE_TOPICS_ZH, FEATURE_TOPICS_EN)) {
    const det = el("details", "help-topic");
    const sum = el("summary");
    sum.append(el("span", "help-topic-title", tp.title));
    for (const b of tp.badges ?? []) sum.append(el("span", "help-badge", badgeText(b)));
    det.append(sum);
    for (const line of tp.body) det.append(para(line));
    if (tp.extra) det.append(tp.extra());
    pane.append(det);
  }
  return pane;
}

// ---- 可视化编辑 -------------------------------------------------------------

/** 可视化编辑的操作说明。快捷键表由 `visual/keys.ts` 的动作表生成，与实际绑定不会脱节；
 *  各阶段新增的操作同步写进这里。 */
const VISUAL_TOPICS_ZH: Topic[] = [
  {
    title: "两种模式、两种光标",
    body: [
      "在谱面上直接改谱：**点一下谱面**让它接管键盘，右上角显示当前模式。改动都落回左侧源码，源码仍是唯一的真身。",
      "**编辑模式**（方块光标）：方块罩住选中的元素，键入的操作只作用于它。在谱面上点一个音符（或挂在它上面的附点、和弦名、装饰）就进入编辑模式；点音符只选中它本身（升降号、唱名、八度点），不带减时线与附点。**附点、减时线、增时线、小节线、圆滑线都能单独点中**——点谁选谁，选中后按 `Delete` 或 `Backspace` 只删这一样（删减时线 = 时值回到四分音符，删小节线 = 前后两小节并成一节，删圆滑线 = 两个括号一起去掉，删增时线 = 短一拍）。",
      "**插入模式**（竖线光标）：竖线落在两个元素之间，操作在光标处插入。点两个音符之间的空白处就进入插入模式。",
      "**文字是单击选中、双击才改**：点歌词、标题、副标题、词曲署名、调号拍号，**单击**只把它整个选中（方块罩住，键盘仍归谱面，可以直接按 `Delete` 删掉这段文字）；**双击**才进插入模式——竖线落在源码里点中的那个字前后，键盘交给源码区，接着打字就是改这段文字。歌词一次只点中一段里的一个字。源码区里光标停在这些字段上时，谱面上对应的文字也跟着亮、竖线画在同一处。",
      "`Insert` 或 `i` 从编辑模式切到插入模式（竖线落在选中元素后面），`Esc` 切回编辑模式（方块罩住光标前面那个元素）。",
      "两种光标**在源码区与谱面同时显示**：谱面有焦点时，源码区里选中的音符 token 带方框、插入位置有一条闪烁的竖线；反过来在源码区移动光标，谱面上的光标跟着走。",
    ],
  },
  {
    title: "选中与移动",
    body: [
      "`←` / `→` 在音符、增时线、小节线、换行符之间逐个移动；`Shift+←` / `Shift+→` 扩大选区；`Home` / `End` 跳到谱面上这一行的头尾。",
      "`Ctrl/⌘+←` / `Ctrl/⌘+→` 按小节跳（跳到小节开头），加 `Shift` 按小节扩选；`Ctrl/⌘+G`（网页版 `Alt+G`，浏览器占着 `Ctrl+G`）输入小节号跳过去，多声部时在当前声部里数。",
      "`Shift` + 点击：从当前选区一直选到点中的音符。",
      "**双击小节里的空白**选中整小节（单击空白仍是落插入光标）；**从空白处按住拖动**拉出一个框，松开时框里的音符连同中间的小节线整段选中（从音符、文字上起拖不会开框）；谱面有焦点时 `Ctrl/⌘+A` 选中全曲。",
      "选中音符时，排版区标题栏左侧显示它的读数：（多声部时先写声部）第几小节第几拍、音名与唱名、时值，数拍、核对音高不用回头看源码。",
    ],
  },
  {
    title: "在五线谱 / 混排上编辑",
    body: [
      "切到 **五线谱** 或 **混排** 档照样能改：点符头（混排里点上方的简谱数字也一样）选中音符，点歌词字、小节线、圆滑线/延音线选中它们，点两个音之间的空白落插入光标，所有快捷键、右键菜单、记号面板与简谱档完全相同。",
      "改的仍是左侧源码——五线谱是由源码即时转出来的，所以简谱档与五线谱档共用**同一份选区与撤销记录**，在哪一档改、切到哪一档看都一样。选中框按符头墨迹画，插入光标画在前后两个音正中、高度取这一行谱表（混排连同简谱层）。",
      "五线谱上没有单独的附点、减时线、增时线图形（它们体现在音符的时值与符杠上），要改它们就选中音符按 `.`、`_`、`=`；和弦名、装饰暂时只能在简谱档点选。小节时值自检同样在五线谱上标红。",
    ],
  },
  {
    title: "小节、反复与跳转",
    body: [
      "右键菜单最下面的 **小节** 展开一组小节操作（记号面板里也有一组）：`Ctrl/⌘+B` 在曲末追加一个空小节，`Ctrl/⌘+Shift+B` 在所在小节前插一个，`Ctrl/⌘+Delete` 删掉选中的小节；新小节填整小节休止。",
      "**调号… / 拍号… / 速度…** 弹出输入框：调号写 `1=G`、`G`、`bB`、`F#` 都行，拍号写 `3/4`、`6/8`，速度写每分钟拍数（`0` 去掉）。在第一小节改的是头部的 `K:` / `M:` / `Q:`，曲中改的是行内 `[K:…]` 这类写法。",
      "**小节线样式**（普通、双线、终止线、反复开始 `|:`、反复结束 `:|`）改所在小节的尾线（反复开始改头线），前后都反复的自动写成 `::`；**第一房 / 第二房**把选中的小节标成房（再点一次去掉）；**𝄋 / ⊕ / D.C. / D.S. / Fine** 标在小节头或尾，再点一次去掉。",
      "123、ABC、MusicXML 都能用；`.jpwabc` 与文本谱的小节操作请在源码里改（菜单里不列）。文本格式的多声部谱只改光标所在的那个声部，MusicXML 所有声部一起改。",
    ],
  },
  {
    title: "和弦与多声部（MusicXML）",
    body: [
      "**加和弦音**：选中一个音按 `Alt+1`–`Alt+7`，在它上面叠一个唱名音（放在最高音之上最近处）。**Alt+点击**和弦里的某个符头单独选中它，按 `Delete` 只删这一个音。",
      "**声部输入**：`Ctrl+Alt+1`–`4` 选新插的音落在第几声部（右上角模式标签会显示「声部2」），插入模式下键入唱名，就在光标所在的时刻往那个声部里写，同一谱表上两条旋律符干各朝一边。",
      "简谱一个声部只印一路旋律，这两项只对 MusicXML 生效；文本格式的多声部在源码里用 `V:` 分开写。",
    ],
  },
  {
    title: "编辑 MusicXML",
    body: [
      "打开的 `.musicxml`（以及五线谱识别的结果）没有源码区，但照样能在谱面上改：简谱、五线谱、混排各档的点选、快捷键、右键菜单、记号面板都与文本格式一样。改的是乐谱本身——音高按调号换算（唱名 `5` 在 `1=F` 里是 C）、时值直接改符号时值，符杠自动重排，多声部小节的对齐由保存时重算。",
      "**文字**：双击歌词或标题就地弹出输入框，改完按 `Enter`；歌词里 `Enter` / `Tab` 会接着跳到同一段的下一个字（`Shift+Tab` 往前），`Esc` 放弃。标题在曲名与页眉里各写一份的，一起改。选中文字按 `Delete` 删掉（歌词连同这个字的位置一起去掉）。",
      "**小节线与换行**：`|` 在光标处把这一小节劈成两节（所有声部一起劈，别的声部在这里有音跨过去就不行），删小节线把前后两小节并成一节；五线谱只能在小节线处换行，`Enter` 要落在小节末尾。",
      "**版式**：只改音高时原谱的版面照旧；增删音符、改时值、拆并小节之后，原谱写死的小节宽与音符位置对不上了，整首改为自动铺排（换行照原谱）。存盘时整份按标准写法重写，原文里读不懂的内容原样保留。",
      "撤销 / 重做（`Ctrl/⌘+Z`、`Ctrl/⌘+Shift+Z`）照常可用；原谱每个四分音符的时值单位太粗、写不出附点八分之类时会自动换细一些的单位，音乐上一个音不变。",
    ],
  },
  {
    title: "改音符",
    body: [
      "选中音符（编辑模式）后：数字 `1`–`7` 改唱名、`0` 改成休止；字母 `A`–`G` 按音名改（按调号换成唱名：`1=G` 里 `G` 是 1、`F` 是升 4，八度取离原来那个音最近的）；`#` `Shift+B` `n` 加升号、降号、还原号（再按一次取消）；`.` 加减附点。",
      "**改音高**：`↑` / `↓` 按调内音阶走一级（`7` 往上成高音 `1`，临时升降号去掉）；`Alt+↑` / `Alt+↓` 升降半音（落在调内音上写本音，否则升号调写升号、降号调写降号，C 调往上写升号、往下写降号）；`'` / `,` 或 `Ctrl/⌘+↑` / `Ctrl/⌘+↓` 升降八度。选中一段时整段一起改。",
      "`_` 时值减半（有增时线先去掉一半拍数，否则加一条减时线），`=` 时值加倍（有减时线先去一条，否则加增时线），`-` 在后面加一条增时线。",
      "**连音**：选中几个音按 `Ctrl/⌘+3`（网页版 `Alt+Shift+3`，浏览器占着 `Ctrl+数字` 切标签）做成连音——选 3 个就是三连音，按选中的个数（二连、四连占 3 个的时间，其余占小于它的最大 2 的幂）；已经是一组再按一次拆回去。123 写 `(3: … )`，ABC 写 `(3`，MusicXML 改时值比例并加括号。",
      "`Shift+F` 加去延长号，`>` 加去重音。123、ABC、`.jpwabc`、文本谱、MusicXML 都能在谱面上改谱；各格式写法不同（如 ABC 写音名、升降号是绝对的，`.jpwabc` 的增时线不能与减时线、附点连写），改出来的原文按各自的规范写。",
    ],
  },
  {
    title: "键位变更（与旧版不同的几处）",
    body: [
      "为了与常见打谱软件（MuseScore、Sibelius、Dorico）一致、并腾出字母键输入音名，下面几个键改了：",
      "`↑` / `↓`：原来是升降八度，**现在是调内音级升降**；八度改用 `'` / `,`（与 123 写法一致）或 `Ctrl/⌘+↑` / `Ctrl/⌘+↓`。",
      "降号：原来是 `b`，**现在是 `Shift+B`**（`b` 让给音名 B）。延长号：原来是 `f`，**现在是 `Shift+F`**（`f` 让给音名 F）。",
      "新增：`A`–`G` 音名、`Alt+↑` / `Alt+↓` 半音。数字唱名 `1`–`7`、`0` 照旧。",
    ],
  },
  {
    title: "插入与删除",
    body: [
      "插入模式下键入数字（或音名 `A`–`G`，八度取离前一个音最近的）就在光标处插入一个音符，时值是右上角显示的「当前时值」，`_` / `=` 调它；插入后接着按 `↑` `↓`、`Alt+↑` `Alt+↓`、`'` `,` 改的是刚插的那个音，光标不动；`-` 插入增时线，`|` 插入小节线。",
      "`Delete` / `Backspace`：编辑模式删掉选中的东西——删音符连同它的增时线、和弦名、装饰一起删；插入模式删光标后面 / 前面那个元素。",
    ],
  },
  {
    title: "歌词录入",
    body: [
      "选中一个音按 `Ctrl/⌘+L`（网页版 `Alt+L`，浏览器占着 `Ctrl+L`），音下面开一个小框，填这个音第 1 段的字（选中的是某段的字就从那一段开始），已有的字先填在框里。",
      "框里的键：`空格` 或 `Tab` 填好跳到下一个音；`-` 连字符（英文一个词拆在几个音上，`hal-le-lu`）；`_` 一字多音（这个字拖到下一个音，下一个音不另配字）；`/` 这个音不填、跳过；`Shift+空格` 回上一个音；`Enter` 换到下一段（同一个音）；`Esc` 结束（框里还没提交的不要）。休止跳过。",
      "一次打几个汉字（如「日光之下」）再按空格，自动一字一音往后分。中文输入法选字时按的空格、回车照常给输入法，不会提前跳走。",
      "123、ABC 写进 `w:` 词行（这一段还没有词行就新起一行，前面没词的音用跳格符补齐）；MusicXML 写进 `<lyric>`（连字符记成 `syllabic`）。文本谱、JP-Word 只能改已经有字的音，没配字的音请在源码的词行里补。",
    ],
  },
  {
    title: "和弦名、文字与力度",
    body: [
      "选中一个音按 `Ctrl/⌘+K`（网页版 `Alt+K`），音上方开一个框填和弦名（`C`、`Am7`、`G/B`、`N.C.`……），已有的先填在框里。`空格` 填好跳到下一个音（休止上也能挂），`Shift+空格` 回上一个，`Enter` 填好结束，`Esc` 放弃；把框清空再提交就是去掉这个和弦名。",
      "123 合规的和弦名不带引号写（`C 1`），不合规的写引号形（`\"N.C.\"1`）；ABC 一律 `\"C\"`；MusicXML 写成 `<harmony>`（按文字解析出根音与和弦类型）。文本谱、JP-Word 的和弦名请在源码里改。",
      "**文字**：`Ctrl/⌘+T`（网页版 `Alt+T`）在选中的音上方加一段文字（渐慢、副歌、反复两遍……），`Enter` 提交。**力度**：`Ctrl/⌘+E`（网页版 `Alt+E`）填 `p` `mp` `mf` `f` `ff` `sfz` `fp` 等，`空格` 填好跳到下一个音。已有的先填在框里，清空提交就是去掉。123、ABC 写成 `\"^渐慢\"`、`!mf!`；MusicXML 写成 `<direction>`（文字在上方、力度在下方）。",
    ],
  },
  {
    title: "复制、粘贴、重复与移调",
    body: [
      "谱面有焦点时 `Ctrl/⌘+C` 复制选中的音（连同增时线、小节线），`Ctrl/⌘+X` 剪切，`Ctrl/⌘+V` 粘贴；代码区有焦点时这几个键照旧管文本。右键菜单与记号面板里也有。",
      "**贴在哪**：插入模式贴在光标处；编辑模式贴在选区**后面**（不覆盖选中的），贴完选中贴进来的那段。",
      "**贴到别的格式**：同一种格式原样贴（和弦名、装饰、注记都在）；贴到别的格式（如 123 复制、ABC 里贴）或贴进 MusicXML，只带音、增时线、小节线，**按唱名走**——贴到别的调里唱名不变（1=C 的 `1 2 3` 贴进 G 调还是 `1 2 3`，即 G A B）。MusicXML 里小节线不贴（小节由拍号管）。",
      "从别处拷来的一段源码文字也能直接贴（当这种格式的原文插进去）。",
      "`R`（编辑模式）：把选中的那段原样再贴一遍在后面并选中新贴的，接着按 `R` 一直往后重复——写反复的音型、同一节奏换音时用；不动剪贴板。",
      "**移调**（右键菜单 / 记号面板「移调…」）：选「全曲」换调——简谱是首调唱名，数字不变、只改调号（曲中转调的各处一起换）；ABC、MusicXML 的音一起移过去。选「选中的音」把它们移几个半音、调号不动（简谱写成升降号）。对话框里标出移过去是几调；和弦记号不跟着移；文本谱、JP-Word 只换开头那处调号。",
    ],
  },
  {
    title: "换行与换页",
    body: [
      "`Enter` 在选中元素后面（插入模式：光标处）换行，`Shift+Enter` 换页；落在小节末时小节线留在前一行。",
      "ABC 的换行就是代码行末：换行时代码行拆成两行、删换行符时两行接成一行，`w:` 同样跟着拆并。文本谱的换行是另起一行 `Q:`：换行时 `Q:`、`C:` 行一起切开，点行末的换行符再按 `Delete` 与下一行合并。`.jpwabc` 的歌词按锚点对齐，增删音符、小节线、换行后会自动重算各段的 `@小节,音符`。",
      "**歌词跟着拆**：123 的 `$` 结束一行曲，紧跟在代码行后的 `w:` 只挂最后一行曲。所以换行时代码行在光标处拆成两行，每条 `w:` 也按对位格数拆成两半，前一半挪到前一行曲下面；删掉换行符则反过来，两边的词逐段接起来（前一行的词不够长用 `/` 补格）。",
      "歌词用了 `+:` 续行的行曲暂不能自动拆分，会提示在源码里改。",
    ],
  },
  {
    title: "挂在音符上的记号",
    body: [
      "**加圆滑线**：选中一段音（`Shift+→` 扩选或 `Shift`+点击），按 `s`（或 `(`）；首尾已有同样一条就去掉。**加延音线**：选中一个音按 `t`，连到后面同音高的那个音，再按一次去掉。123 里两者都写成括号，区别只在连的是不是同音。",
      "和弦名、延长号等装饰、段落注记、圆滑线/延音线都可以单独选中：直接在谱面上点它（和弦名、装饰、注记），或先选中音符再按 `Tab` 在它挂的记号之间轮换，轮完一圈回到音符本身。",
      "选中记号后，源码区同时选中它对应的那段原文（如 `\"G\"`、`!fermata!`、圆滑线的括号），按 `Delete` 删掉；删圆滑线/延音线时两个括号一起删。",
    ],
  },
  {
    title: "格式标记（换行符、换页符）",
    body: [
      "排版区右上角的 **¶** 按钮（或 `Ctrl/⌘+Shift+M`）开关格式标记：谱面每行行末显示换行符 `↵`，换页处显示 `⤓`；源码里对应的 `$`、`$$`、`$(…)`、`[fenye]` 也会淡色标出。",
      "点一下换行符即选中它。文本谱（番茄 / 诗歌本）的换行就是另起一行 `Q:`，原文里没有单独的符号。",
    ],
  },
  {
    title: "右键菜单与记号面板",
    body: [
      "**右键**谱面：先按点击的规则选中（音符、记号、换行符，空白处落插入光标），再弹出对它能做的操作，每项右边写着快捷键。",
      "排版区右上角 **面板** 打开记号面板：唱名、音名、音级与半音、八度、升降号、时值、圆滑线/延音线、延长号、重音、小节线、换行换页、删除都能用鼠标点；当前模式下用不了的按钮是灰的。按钮上画的是谱面上的符号（`1̇` 高音点、`1̲` 减时线、`⌢` 圆滑线……），鼠标停在上面显示名称与快捷键。",
      "面板与菜单调用的是同一张快捷键表里的动作，与键盘完全一致。",
    ],
  },
  {
    title: "改音时发声",
    body: [
      "改唱名、八度、升降号或插入音符后，会用试听同款的钢琴音色短促地响一下（按调号推音高），录入时凭耳朵就能核对。正在试听时不响。",
      "在 **设置** 里取消勾选「改音时发声」即可关掉。",
    ],
  },
  {
    title: "小节时值自检",
    body: [
      "每个小节的时值按拍号逐一核对，拍数对不上的小节在谱面上以淡红底标出（悬停显示「差 1/2 拍」之类的说明），源码里该小节第一个音下画红波浪线；右上角显示共几处，点一下依次跳过去。",
      "放过的合法情形：弱起的第一小节、首尾两小节相加恰好一小节、被反复记号劈开的相邻两个不满小节（两者相加恰好一小节）；混合拍（`M:3/4 4/4`）对上任一拍号即算对；没有拍号的散板不查。",
      "右上角 **拍** 按钮开关这项检查。**图片识谱**完成后也用同一套检查，在原图核对视图上把拍数不对的小节圈出来（多半是增时线、减时线读错）。",
    ],
  },
  {
    title: "撤销与重做",
    body: [
      "谱面上的 `Ctrl/⌘+Z` / `Ctrl/⌘+Shift+Z` 与源码区共用同一份撤销记录，在哪边撤销都一样。",
    ],
  },
  {
    title: "快捷键一览",
    body: ["以下快捷键在**谱面有焦点**时生效（先点一下谱面）。`/` 不绑定，留给歌词对位。"],
    extra: visualShortcutTable,
  },
];

function visualShortcutTable(): HTMLElement {
  const table = el("table", "help-shortcuts");
  // 按分组归拢（动作表里同组的不一定挨着），组的先后按首次出现
  const groups = new Map<typeof VISUAL_ACTIONS[number]["group"], typeof VISUAL_ACTIONS[number][]>();
  for (const a of VISUAL_ACTIONS) groups.set(a.group, [...(groups.get(a.group) ?? []), a]);
  for (const [group, actions] of groups) {
    const head = el("tr");
    const th = el("th", undefined, groupLabel(group));
    th.colSpan = 3;
    head.append(th);
    table.append(head);
    for (const a of actions) {
      const tr = el("tr");
      const mode = a.modes ? t(a.modes[0] === "edit" ? "help.modeEdit" : "help.modeInsert") : "";
      const keys = a.web ? t("help.webKeys", { keys: a.keyText, web: a.web.keyText }) : a.keyText;
      tr.append(el("td", undefined, a.label), el("td", undefined, keys), el("td", undefined, a.help + (mode && t("help.onlyMode", { mode }))));
      table.append(tr);
    }
  }
  return table;
}

function buildVisualHelp(): HTMLElement {
  const pane = el("div", "help-pane");
  pane.append(para(t("help.visualIntro"), "help-intro"));
  for (const tp of localized(VISUAL_TOPICS_ZH, VISUAL_TOPICS_EN)) {
    const det = el("details", "help-topic");
    const sum = el("summary");
    sum.append(el("span", "help-topic-title", tp.title));
    det.append(sum);
    for (const line of tp.body) det.append(para(line));
    if (tp.extra) det.append(tp.extra());
    pane.append(det);
  }
  return pane;
}

// ---- 记谱法 ----------------------------------------------------------------

/** 记谱法示例（字段见 help123.ts；`.jpwabc` 的 `render` 缺省时：code 以 `.` 开头就整体渲染，否则当 `.Voice` 内容包一层）。 */
type NoteEx = NotationExample;

/** 把一段 .Voice 内容包成可渲染的最小完整 jpwabc（空标题，只设调号/拍号，避免抬头干扰）。 */
function wrapVoice(voice: string, key = "1=C", meter = "4/4"): string {
  return `.Title\nKeyAndMeters = {${key},${meter}}\n.Voice\n${voice}\n`;
}

const GLOSSARY: [string, string][] = [
  ["唱名 1–7", "简谱用数字 1234567 表示 do re mi fa so la si 七个音，`0` 是休止（不出声）。"],
  ["八度点", "音符上方或下方的小圆点，往上一个点高八度、往下一个点低八度。"],
  ["减时线", "写在音符**下方**的短横线，一条把时值减半（八分音符），两条再减半（十六分）。"],
  ["增时线", "音符**右侧**的横线 `-`，每条把时值延长一拍。"],
  ["附点", "音符右侧的小圆点 `.`，把时值延长一半（如四分附点 = 四分 + 八分）。"],
  ["小节线 / 拍号", "`|` 分隔小节；`拍号` 如 `4/4` 表示每小节四拍、以四分音符为一拍。"],
  ["调号", "如 `1=C` 表示 do 唱作 C，决定整首曲子的音高基准。"],
  ["连音线 / 延音线", "音符间的弧线：跨不同音高叫圆滑线（连奏），跨相同音高叫延音线（把两音连成一个长音）。"],
];

const NOTATION: NoteEx[] = [
  {
    title: "音符与休止",
    level: "常用",
    body: [
      "简谱用数字 **1–7** 表示七个唱名（do re mi fa so la si），**0** 表示**休止符**（该拍不发声）。",
      "音符之间可以留空格，也可以不留。",
    ],
    code: "1 2 3 4 5 6 7 0",
  },
  {
    title: "高低八度（八度点）",
    level: "常用",
    body: [
      "**八度点**：音符**上方**加一个 `'`（撇号）升高一个八度，**下方**加一个 `,`（逗号）降低一个八度；加两个点就是两个八度。",
      "在源码里写在数字**后面**：`1'` 是高音 do，`1,` 是低音 do。",
    ],
    code: "1, 1 1' 5, 5 5'",
  },
  {
    title: "升号与降号",
    level: "常用",
    body: [
      "在数字**前**加 `#` 升半音、加 `b` 降半音。",
      "例如 `#4` 是升 fa、`b7` 是降 si。",
    ],
    code: "1 #1 2 #2 3 4 #4 5",
  },
  {
    title: "时值：减时线与十六分",
    level: "常用",
    body: [
      "**减时线**（音符下方的下划线 `_`）把时值减半：一条 `_` 是八分音符，两条 `__` 是十六分音符。",
      "相邻的短音符会自动用横梁连起来。",
    ],
    code: "1 2 3_ 3_ 4 5__ 5__ 5__ 5__",
  },
  {
    title: "时值：附点与增时线",
    level: "常用",
    body: [
      "**附点** `.`（音符右侧小圆点）把时值延长一半：`5.` 是附点四分音符。常与减时线搭配成 `5. 5_`（附点节奏）。",
      "**增时线** `-`（音符右侧横线）每条延长一拍：`5-` 是二分音符、`5---` 是全音符。",
    ],
    code: "5. 5_ 5 5 |1- 1 |1--- |",
  },
  {
    title: "小节线、拍号与调号",
    level: "常用",
    body: [
      "`|` 是**小节线**，分隔小节。曲子的**拍号**和**调号**写在 `.Title` 段的 `KeyAndMeters` 里，格式 `{声部号=调,拍号}`，如 `{1=G,3/4}`。",
      "拍号也可以在 `.Voice` 中途改变，直接写 `3/4` 这样的记号即可。",
    ],
    code: ".Title\nKeyAndMeters = {1=G,3/4}\n.Voice\n5 1' 1' |6 1' 1' |5 4 3 |2- 0 |",
  },
  {
    title: "反复记号",
    level: "常用",
    body: [
      "反复记号让一段乐句重复演奏：`|:` 是反复开始、`:|` 是反复结束，中间的小节要唱两遍。",
      "`||` 是双小节线（分句），`|]` 是终止线（曲终）。",
      "`.jpwabc` 照 JP-Word 的观感排：谱面**不画**反复号与小节线样式，但试听与展开档照样按它们反复。",
    ],
    code: "1 2 3 4 |: 5 6 7 1' :| 1--- |]",
    render: false,
  },
  {
    title: "演唱顺序（.Repeat 段）",
    level: "进阶",
    body: [
      "`.Voice` 里的 `|:` `:|` 和一、二房只是**谱面记号**；真正决定「按什么顺序、唱第几段词」的是 `.Repeat` 段。导入 MusicXML / 识图 / ABC 时会自动算好写进去，一般不用手写；要精确控制演唱顺序时再改它。",
      "每行一条，格式 `起始小节-结束小节V段号`（小节号从 1 起）。多条按先后顺序演唱，同一段可以出现多次。下例是「1–4 小节唱两遍，第一遍用第 1 段词、第二遍用第 2 段词，再唱 5–8 小节」。",
      "段号后加 `P` 表示**这一段唱完换页**（主歌、副歌分页时用）：`1-4V1P`。",
      "端点还能精确到音符：起点写 `11.2` 表示从第 11 小节的**第 2 个音符**接入（跨行的长音收尾常用）；终点写 `11.1` 表示只唱到第 11 小节的**第 1 个音符**为止。",
      "条目也可以用逗号写在同一行，`1-4V1,1-4V2` 等同于分两行。",
    ],
    code: ".Repeat\n1-4V1\n1-4V2\n5-8V1",
    render:
      ".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |5 6 7 1' |1' 7 6 5 |4 3 2 1 |$\n" +
      "5 5 5 5 |6 6 6 6 |7 7 7 7 |1'--- |\n.Words\nW1@1,1:\n第一段词/////////////////\nW2@1,1:\n第二段词/////////////////\n" +
      ".Repeat\n1-4V1\n1-4V2\n5-8V1\n",
  },
  {
    title: "连音线与延音线",
    level: "进阶",
    body: [
      "音符之间的弧线：跨**不同**音高是**圆滑线**（连奏、一弓/一口气唱），跨**相同**音高是**延音线**（把两个音连成一个更长的音）。",
      "在源码里用圆括号 `( ... )` 括住要连起来的音符。",
    ],
    code: "(5 6) (1' 1') 3 2 |1--- |",
  },
  {
    title: "延音记号（fermata）",
    level: "进阶",
    body: [
      "在音符**前面**写 `{YanYin}` 加**延音记号**（fermata，音符上方的「◠」），表示这个音可以自由延长。",
    ],
    code: "5 5 5 5 |{YanYin}1 - - - |]",
  },
  {
    title: "歌词",
    level: "常用",
    body: [
      "歌词写在 `.Words` 段。前缀 `W1@1,1:` 表示第 1 段歌词、从第 1 小节第 1 个音符开始对齐。",
      "每个字**默认对一个音符**；用 `/` 表示这个音符**不换字**（一字多音的拖腔）。多段歌词用 `W1` `W2` 分别写。",
    ],
    code: ".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |5 6 5- |\n.Words\nW1@1,1:\n我 们 歌 唱 主/爱",
    render:
      ".Title\nTitle = {示例}\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |5 6 5- |\n.Words\nW1@1,1:\n我 们 歌 唱 主/爱\n",
  },
  {
    title: "标题信息",
    level: "常用",
    body: [
      "`.Title` 段放曲子的抬头信息：`Title` 是标题（居中显示在最上方）、`WordsByAndMusicBy` 是词曲作者（格式 `{词作者,曲作者}`）；`KeyAndMeters` 设置调号与拍号。",
      "`Expression` 记速度与表情：写成 `{♩=76}` 就是每分钟 76 拍，也可以写表情文字如 `热烈欢快地`。试听与导出 MIDI 按 `{♩=…}` 走，不写则按 ♩=90；工具条「试听」旁的下拉可在此基础上调倍速（×0.5～×2）。",
      "JP-Word 自己把这个音符符号存成字母 `J`（靠音乐字体显示成 ♩），读取时两种写法都认，所以从 JP-Word 拿来的谱速度不会丢。",
      "下面这段会渲染出标题页的抬头版式。",
    ],
    code: ".Title\nTitle = {奇异恩典}\nKeyAndMeters = {1=G,3/4}\nWordsByAndMusicBy = {John Newton,美国民谣}\n.Voice\n5 1'. 1'_ 3' |2'- 1'- |",
    titlePage: true,
  },
];

function buildNotationHelp(app: App): HTMLElement {
  return buildExamplePane({
    intro: t("help.notationIntro"),
    glossary: getLang() === "en" ? GLOSSARY_EN : GLOSSARY,
    examples: localizedExamples(NOTATION, NOTATION_TEXT_EN),
    render: (ex) => {
      const text = ex.render ?? (ex.code.trimStart().startsWith(".") ? ex.code : wrapVoice(ex.code));
      return renderExampleSvg(app.meta, text, { titlePage: ex.titlePage });
    },
  });
}

/** 123 的源码是否自带头部（首行是字段，含中文字段名）；不带就补 `K:` `M:`。 */
function has123Header(code: string): boolean {
  return /^(?:[A-Za-z]|[\u4e00-\u9fff]+)[:：]/.test(code.trimStart());
}

function build123Help(app: App): HTMLElement {
  const pane = buildExamplePane({
    intro: getLang() === "en" ? INTRO_123_EN : INTRO_123,
    glossary: getLang() === "en" ? GLOSSARY_123_EN : GLOSSARY_123,
    examples: localizedExamples(EXAMPLES_123, EXAMPLES_123_TEXT_EN),
    render: (ex) => {
      const text = ex.render ?? (has123Header(ex.code) ? ex.code : wrap123(ex.code));
      return render123ExampleSvg(app.meta, text, { titlePage: ex.titlePage });
    },
  });
  const spec = el("button", "about-link", t("help.spec123"));
  spec.onclick = () => {
    if (isTauriRuntime()) void openExternal(SPEC_123_URL);
    else window.open(SPEC_123_URL, "_blank", "noopener");
  };
  pane.querySelector(".help-intro")?.after(spec);
  return pane;
}

/** 记谱法类页面的共同骨架：导语 + 术语速查 + 一张张「说明 / 源码 / 实时渲染」卡片。 */
function buildExamplePane(o: {
  intro: string;
  glossary: [string, string][];
  examples: NoteEx[];
  /** `render: false` 的示例不会调它。 */
  render: (ex: NoteEx & { render?: string }) => SVGSVGElement | null;
}): HTMLElement {
  const pane = el("div", "help-pane");
  pane.append(para(o.intro, "help-intro"));

  // 术语速查
  const gloss = el("details", "help-glossary");
  gloss.append(el("summary", undefined, t("help.glossary")));
  const dl = el("dl", "help-gloss-list");
  for (const [term, desc] of o.glossary) {
    const dt = el("dt");
    dt.append(rich(term));
    dl.append(dt);
    const dd = el("dd");
    dd.append(rich(desc));
    dl.append(dd);
  }
  gloss.append(dl);
  pane.append(gloss);

  for (const ex of o.examples) {
    const sec = el("div", "help-section");
    const head = el("div", "help-sec-head");
    head.append(el("span", "help-sec-title", ex.title));
    const common = ex.level === "常用";
    head.append(el("span", `help-level help-level-${common ? "common" : "adv"}`, t(common ? "help.level.common" : "help.level.adv")));
    sec.append(head);
    for (const line of ex.body) sec.append(para(line));

    const card = el("div", "help-example");
    const pre = el("pre", "help-source");
    pre.textContent = ex.code;
    card.append(pre);

    const svg = ex.render === false ? null : o.render({ ...ex, render: ex.render });
    if (svg) {
      const box = el("div", "help-render");
      svg.classList.add("help-svg");
      box.append(svg);
      card.append(box);
    }
    sec.append(card);
    pane.append(sec);
  }
  return pane;
}

/** 渲染出的示例 svg 默认是整页 viewBox；attach 到 DOM 后裁剪到**墨迹**的紧包围盒，按 1:1 显示、超宽按比例缩。
 *  不能直接用 `svg.getBBox()`：`<text>` 的盒是字体的整行盒，Bravura 的行盒有两个字号高，
 *  一个升降号、三连音数字就把裁出来的一块撑出一大片空白。 */
function cropExamples(root: HTMLElement): void {
  const ctx = document.createElement("canvas").getContext("2d");
  for (const svg of Array.from(root.querySelectorAll<SVGSVGElement>("svg.help-svg"))) {
    const bb = inkBox(svg, ctx);
    if (!bb || bb.w <= 0 || bb.h <= 0) continue;
    const pad = 6;
    const vw = bb.w + pad * 2;
    const vh = bb.h + pad * 2;
    svg.setAttribute("viewBox", `${bb.x - pad} ${bb.y - pad} ${vw} ${vh}`);
    svg.style.width = `${vw}px`;
    svg.style.maxWidth = "100%";
    svg.style.height = "auto";
    svg.style.aspectRatio = `${vw} / ${vh}`;
  }
}

/** 各图元墨迹盒的并集（svg 用户坐标）。文字按 canvas 量出的实际墨迹上下沿，横向仍取字符前进宽度。 */
function inkBox(svg: SVGSVGElement, ctx: CanvasRenderingContext2D | null): { x: number; y: number; w: number; h: number } | null {
  const toSvg = svg.getScreenCTM()?.inverse();
  if (!toSvg) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of Array.from(svg.querySelectorAll<SVGGraphicsElement>("text, path, line, rect, polyline, polygon, circle, ellipse, use, image"))) {
    let b: DOMRect;
    try {
      b = e.getBBox();
    } catch {
      continue;
    }
    let top = b.y, bottom = b.y + b.height;
    if (e instanceof SVGTextElement && ctx && e.textContent) {
      const cs = getComputedStyle(e);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = ctx.measureText(e.textContent);
      // 文字基线在本地 y = 0（layout/render.ts 一律这么画）
      top = -m.actualBoundingBoxAscent;
      bottom = m.actualBoundingBoxDescent;
    }
    if (b.width <= 0 && bottom - top <= 0) continue;
    const ctm = e.getScreenCTM();
    if (!ctm) continue;
    const m = toSvg.multiply(ctm);
    for (const [px, py] of [[b.x, top], [b.x + b.width, top], [b.x, bottom], [b.x + b.width, bottom]]) {
      const q = new DOMPoint(px, py).matrixTransform(m);
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x);
      y1 = Math.max(y1, q.y);
    }
  }
  return x0 < x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// ---- 关于页 ----------------------------------------------------------------
// 版本号 + 主页；检查更新 / 意见反馈 / 自动检查开关三样只在桌面版出现
// （Web 版刷新即最新，也没有邮件客户端可唤起）。

function buildAboutPane(): HTMLElement {
  const pane = el("div", "help-pane");
  pane.append(el("div", "about-name", t("about.name")));
  pane.append(el("div", "about-version", t("about.version", { v: APP_VERSION })));

  const home = el("button", "about-link", HOMEPAGE);
  home.onclick = () => {
    if (isTauriRuntime()) void openExternal(HOMEPAGE);
    else window.open(HOMEPAGE, "_blank", "noopener");
  };
  pane.append(labeledRow(t("about.home"), home));

  if (!isTauriRuntime()) return pane;

  // 状态行：检查更新与反馈都往这里写结果，不额外弹错误框。
  const status = el("div", "about-status");
  status.hidden = true;
  const say = (msg: string) => {
    status.textContent = msg;
    status.hidden = false;
  };

  const checkBtn = el("button", undefined, t("about.check"));
  checkBtn.onclick = () => {
    checkBtn.disabled = true;
    say(t("about.checking"));
    void checkForUpdate()
      .then(async (r) => {
        if (r === null) say(t("about.checkFailed"));
        else if (r === "latest") say(t("about.latest"));
        else {
          say(t("about.found", { v: r.version }));
          await promptUpdate(r);
        }
      })
      .finally(() => {
        checkBtn.disabled = false;
      });
  };

  const mailBtn = el("button", undefined, t("about.feedback"));
  mailBtn.onclick = () => {
    void openFeedbackMail().catch(() => {
      say(t("about.noMail", { email: FEEDBACK_EMAIL }));
    });
  };

  const row = el("div", "about-buttons");
  row.append(checkBtn, mailBtn);
  pane.append(row, status);

  const auto = el("input");
  auto.type = "checkbox";
  auto.checked = isAutoCheckEnabled();
  auto.onchange = () => setAutoCheckEnabled(auto.checked);
  const autoLabel = el("label", "about-auto");
  autoLabel.append(auto, document.createTextNode(t("about.autoCheck")));
  pane.append(autoLabel);

  return pane;
}

function labeledRow(label: string, control: HTMLElement): HTMLElement {
  const row = el("div", "about-row");
  row.append(el("span", "about-label", label), control);
  return row;
}

// ---- 对话框 ----------------------------------------------------------------

export function showHelpDialog(app: App): void {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box help-box");

  const title = el("div", "modal-title", t("help.title"));

  // 标签页：{ 标签, 内容, 首次显示时的补做 }
  const notationPane = buildNotationHelp(app);
  const pane123 = build123Help(app);
  const pages: { label: string; pane: HTMLElement; onFirstShow?: () => void }[] = [
    { label: t("help.tab.features"), pane: buildFeatureHelp() },
    { label: t("help.tab.visual"), pane: buildVisualHelp() },
    { label: t("help.tab.123"), pane: pane123, onFirstShow: () => cropExamples(pane123) },
    {
      label: t("help.tab.notation"),
      pane: notationPane,
      // getBBox only works once the pane is visible; crop on first reveal.
      onFirstShow: () => cropExamples(notationPane),
    },
    { label: t("help.tab.about"), pane: buildAboutPane() },
  ];

  const tabs = el("div", "help-tabs");
  const content = el("div", "help-content");
  const tabBtns = pages.map((pg, i) => {
    const btn = el("button", i === 0 ? "help-tab active" : "help-tab", pg.label);
    pg.pane.style.display = i === 0 ? "" : "none";
    tabs.append(btn);
    content.append(pg.pane);
    return btn;
  });

  const shown = new Set<number>([0]);
  const activate = (idx: number) => {
    pages.forEach((pg, i) => {
      tabBtns[i].classList.toggle("active", i === idx);
      pg.pane.style.display = i === idx ? "" : "none";
    });
    if (!shown.has(idx)) {
      shown.add(idx);
      pages[idx].onFirstShow?.();
    }
    content.scrollTop = 0;
  };
  tabBtns.forEach((btn, i) => (btn.onclick = () => activate(i)));

  const footer = el("div", "modal-footer");
  const closeBtn = el("button", undefined, t("help.close"));
  footer.append(closeBtn);

  box.append(title, tabs, content, footer);
  overlay.append(box);
  document.body.append(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  closeBtn.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  document.addEventListener("keydown", onKey);
}
