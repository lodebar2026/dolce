// 试听播放的编辑器侧控制器：播放器实例、速度倍率与分声部音量、播放/暂停/停止按钮、进度条与速度下拉。
//
// 从 App 里切出来的一块。**谱面高亮不在这里**——按元素 id + 遍次找到画出来的那个音
// （`ScorePainter.highlight`），那属于「谁在画谱面」，由 App 转给排版器。
// 控制器只通过 PlaybackHost 要「当前该播哪份谱」（由 ScoreDoc 拼的 `PlaySource`）与「高亮到这个元素」。
import { anchorSeconds, ScorePlayer, spanSeconds, timelineSeconds, type PlayPoint, type PlayState } from "./player";
import { SPEED_STEPS, TEMPO, type PlayOptions, type PlaySource, type Timeline } from "../score/timeline";
import type { ElementId } from "../model/doc";
import { t } from "../i18n";

/** PlaybackController 向编辑器要的能力。 */
export interface PlaybackHost {
  /** 当前是否处于可试听的预览模式。 */
  readonly canPlay: boolean;
  /** 当前该播的谱（各声部 + 演唱顺序 + 速度）。没有可播内容返回 null。 */
  playable(): PlaySource | null;
  /** 从哪个音开始播（用户在谱面上选中了某个音时）。 */
  startPoint(): PlayPoint | undefined;
  /** 循环段：谱面上选中的第一个与最后一个音；没有选区为 null（整首循环）。 */
  loopPoints(): { first: PlayPoint; last: PlayPoint } | null;
  /** 播到某个元素：把谱面高亮挪过去并保证可见。null = 清高亮。 */
  highlightPlaying(id: ElementId | null, pass: number): void;

  setStatus(text: string): void;
  saveSettings(): void;
}

/** 秒 → `m:ss`。 */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class PlaybackController {
  private player: ScorePlayer | null = null;
  private btnEl: HTMLButtonElement | null = null;
  private stopBtnEl: HTMLButtonElement | null = null;
  private speedSelEl: HTMLSelectElement | null = null;
  private progressEl: HTMLInputElement | null = null;
  private timeEl: HTMLElement | null = null;
  /** 时间显示「剩余」而不是「已播」（点时间切换）。 */
  private showRemaining = false;
  /** 正在拖进度条：播放器的位置回报先不往进度条上写。 */
  private scrubbing = false;
  /** 停止状态下拖进度条 / 点音符定下的起播秒数；开播后清掉。 */
  private cueSec: number | null = null;
  /** 停止状态下算总长、换算起播点用的时间线（按谱与速度缓存）。 */
  private tlCache: { src: PlaySource; speed: number; tl: Timeline; spq: number } | null = null;
  /** 逐声部线性音量 [0,1]，下标 = 声部序号。缺省视为 1（满音量）。 */
  readonly partVolumes: number[] = [];
  /** 播放速度倍率（相对谱面标注速度）。持久化。 */
  speed = 1;
  /** 节拍器（每拍一声）。持久化 */
  metronome = false;
  /** 循环播放：有选区循环选区，没有循环整首。会话内 */
  loop = false;
  private loopBtnEl: HTMLButtonElement | null = null;
  private metroBtnEl: HTMLButtonElement | null = null;

  constructor(private host: PlaybackHost) {}

  get state(): PlayState {
    return this.player?.state ?? "stopped";
  }

  /** 正在试听（或在加载音源）。可视化编辑的按键发声在这时让路。 */
  get busy(): boolean {
    return this.state === "playing" || this.state === "loading";
  }

  /** 有一个播放会话（播放中或暂停中）：点音符、拖进度条直接在会话里定位。 */
  get active(): boolean {
    return this.state === "playing" || this.state === "paused";
  }

  // ---------------- 持久化 ----------------
  loadSettings(s: { playSpeed?: unknown; playMetronome?: unknown }): void {
    if (typeof s.playSpeed === "number" && s.playSpeed > 0) {
      this.speed = clampSpeed(s.playSpeed);
    }
    this.metronome = s.playMetronome === true;
    this.syncToggles();
  }

  /** 循环、节拍器两个开关按钮。 */
  bindToggles(loop: HTMLButtonElement | null, metronome: HTMLButtonElement | null): void {
    this.loopBtnEl = loop;
    this.metroBtnEl = metronome;
    loop?.addEventListener("click", () => this.setLoop(!this.loop));
    metronome?.addEventListener("click", () => this.setMetronome(!this.metronome));
    this.syncToggles();
  }

  private syncToggles(): void {
    for (const [el, on] of [[this.loopBtnEl, this.loop], [this.metroBtnEl, this.metronome]] as const) {
      if (!el) continue;
      el.classList.toggle("active", on);
      el.setAttribute("aria-pressed", String(on));
    }
  }

  /** 循环开关：播放中立即按当前选区（没有选区整首）定循环段。 */
  setLoop(on: boolean): void {
    this.loop = on;
    this.syncToggles();
    if (this.player && this.active) this.player.setLoop(on ? this.loopRange() : null);
  }

  /** 节拍器开关（持久化）：播放中从当前位置接着播。 */
  setMetronome(on: boolean): void {
    this.metronome = on;
    this.syncToggles();
    this.host.saveSettings();
    const p = this.player;
    const src = this.host.playable();
    if (!p || !this.active || !src) return;
    const at = p.position;
    const paused = p.state === "paused";
    void this.run(() => p.play(src, this.options(), at, paused)).then(() => p.setLoop(this.loop ? this.loopRange() : null));
  }

  /** 循环段（秒）：选区那一段，没有选区整首。 */
  private loopRange(): { from: number; to: number } | null {
    const src = this.host.playable();
    const t = src ? this.timeline(src) : null;
    if (!t) return null;
    const pts = this.host.loopPoints();
    return (pts && spanSeconds(t.tl, t.spq, pts.first, pts.last)) ?? { from: 0, to: t.tl.duration * t.spq };
  }

  // ---------------- 工具条绑定 ----------------
  setPlaybackBtn(el: HTMLButtonElement): void {
    this.btnEl = el;
    this.onState("stopped");
  }

  setStopBtn(el: HTMLButtonElement): void {
    this.stopBtnEl = el;
    el.addEventListener("click", () => this.stop());
    this.onState(this.state);
  }

  /** 界面语言变了：按钮、速度下拉与时间提示重写。 */
  relabel(): void {
    if (this.speedSelEl) {
      for (const o of this.speedSelEl.options) if (o.value === "1") o.textContent = t("play.normal");
      this.refreshSpeedUi();
    }
    this.onState(this.state);
  }

  /** 进度条（`<input type=range>`）与时间显示。拖动时只改显示，松手才定位。 */
  bindProgress(range: HTMLInputElement, time: HTMLElement | null): void {
    this.progressEl = range;
    this.timeEl = time;
    range.min = "0";
    range.step = "any";
    range.addEventListener("input", () => {
      this.scrubbing = true;
      this.renderProgress(parseFloat(range.value) || 0);
    });
    range.addEventListener("change", () => {
      this.scrubbing = false;
      void this.seekSec(parseFloat(range.value) || 0);
    });
    time?.addEventListener("click", () => {
      this.showRemaining = !this.showRemaining;
      this.refreshProgress();
    });
    this.refreshProgress();
  }

  bindSpeedSelect(el: HTMLSelectElement): void {
    this.speedSelEl = el;
    el.innerHTML = "";
    for (const v of SPEED_STEPS) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = v === 1 ? t("play.normal") : `×${v}`;
      el.append(o);
    }
    el.addEventListener("change", () => this.setSpeed(parseFloat(el.value) || 1));
    this.refreshSpeedUi();
  }

  /** 工具条速度下拉与谱速提示的同步（换谱、改倍率后调用）。进度条总长随之刷新。 */
  refreshSpeedUi(): void {
    this.refreshProgress();
    const sel = this.speedSelEl;
    if (!sel) return;
    sel.value = String(this.speed);
    const src = this.host.playable();
    const tempo = src?.playData.tempo ?? 0;
    const bpm = Math.round((tempo > 0 ? tempo : TEMPO) * clampSpeed(this.speed)); // 同 `playTempo`
    const marked = tempo > 0 ? t("play.marked", { tempo }) : t("play.unmarked");
    sel.title = t("play.speedTitle", { marked, bpm });
  }

  /** 设置速度倍率并持久化；有播放会话时从当前位置按新速度接着播（暂停中仍停着）。 */
  setSpeed(mul: number): void {
    const v = clampSpeed(mul);
    if (v === this.speed) return;
    const old = this.speed;
    this.speed = v;
    this.host.saveSettings();
    this.refreshSpeedUi();
    const p = this.player;
    if (!p || !this.active) return;
    // 谱面 ♩= 不变，秒数只随倍率反比缩放
    const at = (p.position * old) / v;
    const paused = p.state === "paused";
    const src = this.host.playable();
    if (!src) return;
    // 循环段是秒数：换了速度要按新速度重算
    p.setLoop(this.loop ? this.loopRange() : null);
    void this.run(() => p.play(src, this.options(), at, paused));
  }

  // ---------------- 音量 · 静音 · 独奏（声部面板） ----------------
  /** 各声部静音（会话内，不写文件） */
  readonly partMuted: boolean[] = [];
  /** 独奏的声部（其余静音）；null = 没有独奏。合唱练声部用 */
  solo: number | null = null;

  getPartVolume(i: number): number {
    const v = this.partVolumes[i];
    return v === undefined ? 1 : v;
  }

  setPartVolume(i: number, v: number): void {
    this.partVolumes[i] = Math.max(0, Math.min(1, v));
    this.remix();
  }

  setPartMuted(i: number, on: boolean): void {
    this.partMuted[i] = on;
    this.remix();
  }

  setSolo(i: number | null): void {
    this.solo = i;
    this.remix();
  }

  /** 实际给播放器的各声部音量：独奏 → 其余为 0；静音 → 0；其余照音量。 */
  private effectiveVolumes(): number[] {
    const n = Math.max(this.partVolumes.length, this.partMuted.length, this.solo === null ? 0 : this.solo + 1, 8);
    return Array.from({ length: n }, (_, i) => {
      if (this.solo !== null) return i === this.solo ? this.getPartVolume(i) : 0;
      return this.partMuted[i] ? 0 : this.getPartVolume(i);
    });
  }

  /** 混音变了：正在播就从当前位置按新混音接着播（暂停中仍停着），同改速度。 */
  private remix(): void {
    const p = this.player;
    if (!p || !this.active) return;
    const src = this.host.playable();
    if (!src) return;
    void this.run(() => p.play(src, this.options(), p.position, p.state === "paused"));
  }

  /** 换了一份谱：静音、独奏作废（声部数与次序都可能变了）。 */
  resetMix(): void {
    this.partMuted.length = 0;
    this.partVolumes.length = 0;
    this.solo = null;
  }

  /** 声部增删、排序了：静音、独奏、音量跟着声部走（`map` 旧序号 → 新序号，删掉的为 -1）。 */
  remapParts(map: (i: number) => number): void {
    const vol = [...this.partVolumes];
    const muted = [...this.partMuted];
    this.partVolumes.length = 0;
    this.partMuted.length = 0;
    vol.forEach((v, i) => { const j = map(i); if (j >= 0 && v !== undefined) this.partVolumes[j] = v; });
    muted.forEach((m, i) => { const j = map(i); if (j >= 0 && m) this.partMuted[j] = m; });
    if (this.solo !== null) {
      const j = map(this.solo);
      this.solo = j >= 0 ? j : null;
    }
  }

  /** 试听/导出 MIDI 共用的播放参数。 */
  options(): PlayOptions {
    return { partVolumes: this.effectiveVolumes(), speed: this.speed, ...(this.metronome ? { metronome: true } : {}) };
  }

  // ---------------- 播放 ----------------
  /** 开播：起点依次取拖进度条定的位置、选中的音、曲首。 */
  async play(): Promise<void> {
    if (!this.host.canPlay) return;
    const src = this.host.playable();
    if (!src) {
      this.host.setStatus(t("play.noLines"));
      return;
    }
    let start = this.cueSec;
    const loop = this.loop ? this.loopRange() : null;
    if (loop && (start === null || start < loop.from || start >= loop.to)) start = loop.from;
    if (start === null) {
      const pt = this.host.startPoint();
      const t = pt ? this.timeline(src) : null;
      start = pt && t ? anchorSeconds(t.tl, t.spq, pt) : null;
    }
    this.cueSec = null;
    const p = this.instance();
    p.setLoop(loop);
    await this.run(() => p.play(src, this.options(), start ?? 0));
  }

  /** 播放按钮：停止 → 播放，播放中 → 暂停，暂停中 → 继续，加载中 → 停止。 */
  async toggle(): Promise<void> {
    const p = this.player;
    switch (this.state) {
      case "playing":
        p?.pause();
        return;
      case "paused":
        await this.run(() => p!.resume());
        return;
      case "loading":
        this.stop();
        return;
      default:
        await this.play();
    }
  }

  /** 停止：清高亮、回到曲首（起播点仍按选中的音）。 */
  stop(): void {
    this.cueSec = null;
    this.player?.stop();
    this.refreshProgress();
  }

  /** 点中了某个音：有播放会话就跳过去接着播（暂停中只挪位置），停止中记为下次的起点。 */
  seekTo(point: PlayPoint): void {
    const p = this.player;
    if (p && this.active) {
      const t = p.timeOf(point);
      if (t !== null) void this.run(() => p.seek(t));
      return;
    }
    const src = this.host.playable();
    const t = src ? this.timeline(src) : null;
    this.cueSec = t ? anchorSeconds(t.tl, t.spq, point) : null;
    this.refreshProgress();
  }

  /** 定位到第 `sec` 秒（进度条松手）。 */
  async seekSec(sec: number): Promise<void> {
    const p = this.player;
    if (p && this.active) {
      await this.run(() => p.seek(sec));
      return;
    }
    this.cueSec = Math.max(0, sec);
    this.refreshProgress();
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.error("playback failed", e);
      this.player?.stop();
      this.host.setStatus(t("play.loadFailed", { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  /** 停止状态下的时间线（总长、起播点换算）；按谱与速度缓存。 */
  private timeline(src: PlaySource): { tl: Timeline; spq: number } | null {
    const c = this.tlCache;
    if (c && c.src === src && c.speed === this.speed) return c;
    try {
      const { tl, spq } = timelineSeconds(src, this.options());
      this.tlCache = { src, speed: this.speed, tl, spq };
      return this.tlCache;
    } catch (e) {
      console.error("试听时间线拼不出", e);
      return null;
    }
  }

  private instance(): ScorePlayer {
    if (!this.player) {
      this.player = new ScorePlayer(
        (id, pass) => this.host.highlightPlaying(id, pass),
        (state) => this.onState(state),
        (pos) => {
          if (!this.scrubbing) this.renderProgress(pos);
        },
      );
    }
    return this.player;
  }

  /** 进度条与时间显示按当前状态重画（换谱、停止、切换显示方式后）。 */
  private refreshProgress(): void {
    const p = this.player;
    if (p && this.active) {
      this.renderProgress(p.position);
      return;
    }
    this.renderProgress(this.cueSec ?? 0);
  }

  private durationSec(): number {
    const p = this.player;
    if (p && this.active) return p.duration;
    if (!this.progressEl && !this.timeEl) return 0;
    const src = this.host.canPlay ? this.host.playable() : null;
    const t = src ? this.timeline(src) : null;
    return t ? t.tl.duration * t.spq : 0;
  }

  private renderProgress(pos: number): void {
    const range = this.progressEl;
    const time = this.timeEl;
    if (!range && !time) return;
    const dur = this.durationSec();
    const at = Math.max(0, Math.min(pos, dur));
    if (range) {
      range.max = String(dur || 1);
      range.value = String(at);
      range.disabled = dur <= 0;
      range.style.setProperty("--progress", `${dur > 0 ? (at / dur) * 100 : 0}%`);
    }
    if (time) {
      time.textContent = this.showRemaining ? `-${fmtTime(dur - at)} / ${fmtTime(dur)}` : `${fmtTime(at)} / ${fmtTime(dur)}`;
      time.title = t("play.timeTitle", { at: fmtTime(at), left: fmtTime(dur - at), total: fmtTime(dur) });
    }
  }

  private onState(state: PlayState): void {
    if (this.stopBtnEl) this.stopBtnEl.disabled = state === "stopped";
    if (state === "stopped" || state === "paused") this.refreshProgress();
    if (!this.btnEl) return;
    const label = t(state === "loading" ? "play.loading" : state === "playing" ? "play.pause" : state === "paused" ? "play.resume" : "play.play");
    const icon = this.btnEl.querySelector<HTMLElement>(".playback-icon");
    const labelEl = this.btnEl.querySelector<HTMLElement>(".playback-label");
    this.btnEl.dataset.state = state;
    this.btnEl.disabled = state === "loading";
    this.btnEl.setAttribute("aria-label", label);
    this.btnEl.title =
      t(state === "playing" ? "play.titlePause" : state === "paused" ? "play.titleResume" : state === "loading" ? "play.titleLoading" : "play.titlePlay");
    if (labelEl) labelEl.textContent = label;
    if (icon) {
      icon.classList.toggle("is-loading", state === "loading");
      icon.innerHTML = state === "playing" ? ICON_PAUSE : state === "loading" ? "" : ICON_PLAY;
    }
  }
}

/** 播放键图标：与停止键（index.html）同一 10×10 viewBox，不靠字形——▶ ❚❚ ■ 走系统字体回落，大小基线各不相同。 */
const ICON_PLAY = '<svg viewBox="0 0 10 10"><path d="M2 0.8 L9.2 5 L2 9.2 Z" fill="currentColor"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 10 10"><rect x="1.3" y="0.8" width="2.6" height="8.4" rx="0.6" fill="currentColor"/>' +
  '<rect x="6.1" y="0.8" width="2.6" height="8.4" rx="0.6" fill="currentColor"/></svg>';

const clampSpeed = (v: number): number => Math.max(0.25, Math.min(3, v));
