// 网页版识别引擎（wasm Worker）：12g 接上。现在没有，调用会报错。
import type { OmrEngine } from "./engine";

export function webEngine(): OmrEngine {
  return {
    open() {
      return Promise.reject(new Error("网页版的 Rust 识别还没接上"));
    },
  };
}
