// @ts-ignore
import { installDomParser } from "../../dev/scripts/xml-dom.mjs";
import { parse123 } from "./abcfamily/parse";
import { loadScoreDoc } from "./model/fromxml";
import { scoreDocToMusicXml } from "./model/toxml";
installDomParser();
const d: any = loadScoreDoc(scoreDocToMusicXml(parse123("K:1=C\nM:4/4\n[13]~ [13] [1~5] [15] | ([135] [135]) [135]~ [135] |]\n")));
console.log(JSON.stringify((d.songs?.[0] ?? d.song).marks.map((m: any) => [m.type, m.start, m.end, m.startNote, m.endNote])));
