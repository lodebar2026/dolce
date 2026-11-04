// Node 版的页 Worker（worker_threads）：多页并行识别的 Worker 一侧（`rasteromr/pagepool.ts::servePageWorker`）。
// 由 `rasterpool.ts` 起；`npm run build:cli` 打成 out/cli/rasterworker.js。
import { parentPort } from "node:worker_threads";
import { servePageWorker, type ToWorker } from "../rasteromr/pagepool";
import { installNodeKernels } from "./omrkernels.node";

installNodeKernels();

const port = parentPort!;
const handle = servePageWorker((msg) => port.postMessage(msg));
port.on("message", (msg: ToWorker) => handle(msg));
