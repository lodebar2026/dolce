# Dolce

[中文](README.md) | **English**

> **Dolce** (悦谱) is an open-source editor and typesetter for **jianpu** (Chinese numbered musical notation) and
> staff notation: write, recognize, typeset, play back and export scores — in the browser with nothing to install, or as a Windows / macOS desktop app.

[![Release](https://img.shields.io/github/v/release/lodebar2026/dolce?display_name=tag)](https://github.com/lodebar2026/dolce/releases)
[![Live demo](https://img.shields.io/badge/%F0%9F%8C%90%20Live%20demo-online-2b6cb0)](https://lodebar2026.github.io/dolce/en/)
![Platform](https://img.shields.io/badge/platform-Web%20%7C%20macOS%20%7C%20Windows-555)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**What is jianpu?** Jianpu is the numbered notation widely used in China and across East Asia, especially for
hymnals, choir books and folk songs. The digits `1`–`7` stand for the scale degrees do–ti, with `0` for a rest.
Dots above or below a digit shift it by an octave, underlines halve the duration, and dashes extend it by a beat.
Lyrics sit directly under the notes.

## Quick start

| | Where | Notes |
| :-: | --- | --- |
| 🌐 | **[Live demo](https://lodebar2026.github.io/dolce/en/)** | Runs in the browser, nothing to install |
| 🍎 | **[macOS download](https://github.com/lodebar2026/dolce/releases/latest)** (`.dmg`, Apple Silicon) | If macOS says the app "is damaged", see [below](#install) |
| 🪟 | **[Windows download](https://github.com/lodebar2026/dolce/releases/latest)** (`x64-setup.exe`) | Installer for Windows 10/11 x64 |

The interface is available in **English and Chinese**: it follows your browser language and can be switched any time in **Settings → Other → Language**. English landing page: <https://lodebar2026.github.io/dolce/en/>.

![A recognized staff-notation hymn side by side with its source image](docs/screenshot-en.png)

<sub>A four-part hymn (<i>Holy, Holy, Holy</i>, public-domain score from the Open Hymnal Project) right after staff recognition, in <b>Side by side</b>: the source image on the left, the engraved score on the right; selecting a note boxes it on both.</sub>

## Features

**Editing**
- **Source on the left, live score on the right.** The score is re-typeset as you type. Four text formats are
  supported, each with syntax highlighting and diagnostics:
  - **123**, the project's own jianpu format (see below)
  - **JP-Word `.jpwabc`**
  - **Plain-text jianpu scripts**: the *Fanqie* (番茄简谱) script language and the *Shigeben* (诗歌本) text score,
    which the Shigeben app calls a "dynamic score"
  - **ABC notation**
- **Visual editing.** Select, insert and change notes and marks directly on the score: scale degree or note name, step / semitone / octave, accidentals,
  duration, extension dashes, barlines, slurs and ties, fermatas, accents, and line and page breaks. You can use
  the keyboard, a context menu or a symbol palette, in the jianpu, staff and mixed views alike. Every edit is
  written back to the source text and shares one undo history with the code editor. Key bindings follow common
  notation software (↑↓ diatonic step, Alt+↑↓ semitone, Ctrl/⌘+↑↓ octave).
- **Measure operations.** Insert, append and delete measures, merge or split them, change key, time signature and
  tempo, and set barline styles, endings (voltas) and jump marks.
- Lyric entry syllable by syllable (Space moves to the next note; typed Chinese characters are spread one per
  note), chord symbols, text and dynamics; tuplets; copy and paste (rewritten by scale degree across formats) and
  `R` to repeat a selection; jump by measure or to a measure number; transpose the whole piece or a selection.
- **Selection readout.** Shows the part, measure and beat, pitch name and scale degree, and duration of the
  selected element.
- **Parts panel (choral scores).** Add, remove, reorder and rename parts, set clefs and transposing instruments,
  split a closed score into separate parts (by voice or by chord) or merge them back, copy lyrics between parts,
  hide parts in the staff and mixed views; mute, solo (for part practice) and per-part volume for playback; choose
  which part supplies the jianpu melody and lyrics.
- **Two-way navigation.** Clicking a note or lyric jumps to its place in the source, and the reverse. Measures
  whose beats don't add up to the time signature are outlined in red.
- **Simplified ↔ Traditional Chinese conversion** covers lyrics, titles and credits and leaves the music code
  untouched.
- **English and Chinese interface**, including the in-app Help; switch without reloading.

**Optical music recognition (local, offline)**
- **Jianpu recognition.** Drop in a photo, screenshot or scanned PDF of a jianpu score and it is recognized into
  123. The result includes notes, durations, lyrics aligned syllable by syllable, and the title, credits and key.
  Four-part scores are split into their voices. Everything runs locally in the browser or desktop app, and
  images are never uploaded.
- **Edit while reviewing.** Notes can be edited directly on the source-image overlay; changed, deleted and inserted
  notes are marked in place. Notes and syllables the recognizer is unsure about are **highlighted in yellow**, and
  you can step through them one by one.
- **Side by side.** Back in the typeset view, an optional "source snippet" window shows the original line of the
  selected note, or a **side-by-side** panel shows the whole source page with selection linked both ways; the source
  pane can be hidden so the image and the score split the screen.
- **Source pages.** Before or after recognition, reorder, add, remove, rotate (90°) and crop the source images,
  then recognize the whole piece again. If recognition fails, the start page offers "rotate / crop and retry".
- **Source-image review.** Recognized symbols are overlaid on the binarized source image at their original
  positions, so you can check note by note. Clicking a symbol jumps to its source text, and you can play the
  score back in this view.
- **Staff-notation recognition.** Staff PDFs with an intact text layer, as well as scanned or photographed staff
  images and PDFs, are recognized into MusicXML, which opens in the staff and mixed views and can be edited on the
  score. Dropped images are routed to jianpu or staff recognition automatically (by looking for five-line staves),
  or you can choose explicitly. If staves are assigned to the wrong parts, fix the mapping in the parts panel and
  the score is rebuilt without re-recognizing.
- **Lyrics cross-check.** The command-line recognizer (`omr-cli.mjs image --lyrics lyrics.txt`) can take the
  song's lyric text as a reference. Look-alike characters are corrected from it and dropped characters filled
  back in; anything else that disagrees (edition wording, extra or missing syllables, likely missed slurs, repeat
  order) is listed for review rather than changed.

**Typesetting**
- **Four views:**
  - *Expanded*: repeats and verses are unrolled pass by pass, one verse per slide, for projection.
  - *Original*: laid out as printed, with verses stacked under the notes, for print.
  - *Staff*: Western staff notation.
  - *Mixed*: staff notation with a jianpu layer on top.
- **Phrase-aware re-layout.** Lines are re-broken using lyric punctuation and musical cues (fermatas, final
  barlines, long notes, rests, slurs). The original line breaks can be restored with one click.
- **Paper and styling.** Paper size, orientation, margins and header fonts are all adjustable. `.ss` style sheets
  keep fonts, colors and layout consistent across a whole songbook.

**Playback**
- The score plays at its marked tempo, with a cursor that follows along. You can pause, drag the progress bar,
  click a note to continue from there, set the speed from ×0.5 to ×2, and adjust per-voice volume.
- Loop the selected passage (or the whole piece), and turn on a metronome that clicks every beat.

**Save, Save As and Export**
- **Save** writes back to the original format.
- **Save As** converts between 123, JPWABC, ABC and the plain-text formats. Anything the target format can't hold
  is listed before you confirm.
- A recognized score is saved as a **recognition project** (`.dolce`): the source images, the recognition result
  and the score being edited, all in one file. Reopen it to carry on proofreading against the source image without
  recognizing again.
- **Autosave.** Unsaved changes are kept as a local draft after a few seconds; after an unexpected close or reload
  you are offered to restore it. With unsaved changes, opening another file, loading the sample, recognizing a new image
  or closing the window asks first.
- **Export** depends on the view:
  - Jianpu views: **vector PPTX**, **MIDI** and **MusicXML**.
  - Staff and mixed views: **PNG**, **PDF**, **MIDI** and **MusicXML**.

## The 123 format

123 is the project's **primary jianpu format**: a **jianpu dialect of ABC notation**.

- **Borrowed from ABC:** the header fields (`X:` `T:` `K:` `M:` `w:` …), repeats, endings, multiple voices and
  play order.
- **Replaced:** the note body uses jianpu digits instead of ABC letters.
- **Why it works well:** it is plain UTF-8 text that is easy to write by hand, and it holds scores converted from
  MusicXML, ABC, the plain-text formats and OMR without loss.

```
X:1
T:Amazing Grace
C:Words John Newton
K:1=F
M:3/4
Q:1/4=76
5, | 1 - 3_ 1_ | 3 - 2 | 1 - 6, | 5, - $
w:A-ma-zing_ grace, how sweet the sound
5, | 1 - 3_ 1_ | 3 - 2 | 5 - - | 5 - |]
w:That saved a_ wretch like me!_
```

In the lyrics, CJK characters take one note each and need no spaces. Latin words are split into syllables with `-`
(`A-ma-zing`), and `_` holds a syllable over the next note.

- Full specification (in Chinese): [docs/格式/123格式.md](docs/格式/123格式.md)
- In the app, **Help → 123 format** walks through each construct with live-rendered examples.

## Supported formats

| Format | Extensions | Open | Edit | Save / Save As | Notes |
| --- | --- | :-: | :-: | :-: | --- |
| 123 | `.123` | ✅ | ✅ | ✅ | Primary jianpu format |
| JP-Word | `.jpwabc` | ✅ | ✅ | ✅ | Opens and saves files JP-Word can read |
| Plain-text jianpu | `.pu` `.fq` `.jps` `.txt` | ✅ | ✅ | ✅ | Fanqie and Shigeben dialects, detected automatically |
| ABC | `.abc` | ✅ | ✅ | ✅ | Voices, repeats, endings, chords, ornaments… |
| MusicXML | `.xml` `.musicxml` | ✅ | ✅ (directly on the score) | ✅ | Notes, measures, lyrics and titles can be edited on the score in every view; a single-voice score can also be converted to 123 etc. for text editing |
| Image / PDF | `.png` `.jpg` `.webp` `.pdf` | OMR | — | — | Jianpu images and scanned PDFs; staff PDFs, scanned or photographed staff notation |
| Recognition project | `.dolce` | ✅ | ✅ | ✅ | Source images + recognition result + the score being edited; reopens without recognizing again |

## Install

- **Web** (no install): <https://lodebar2026.github.io/dolce/en/>
- **macOS** (Apple Silicon, `Dolce_<version>_aarch64.dmg`) and **Windows** (x64,
  `Dolce_<version>_x64-setup.exe`): [latest release](https://github.com/lodebar2026/dolce/releases/latest)
- **"Dolce is damaged" on macOS?** The app is not signed with an Apple developer certificate. Move it to
  Applications, then run this once in Terminal:

  ```
  xattr -cr /Applications/Dolce.app
  ```

  More details (in Chinese) are in [docs/macOS-打不开.md](docs/macOS-打不开.md).

## Development

The developer docs are in Chinese:
- Tech stack, build commands, layering and module map: [docs/架构.md](docs/架构.md)
- Requirements and per-module pages: [docs/](docs/)

Regression scripts and test corpora are not part of this repository.

## Acknowledgements

- [open-fanqie](https://github.com/Linho1219/open-fanqie) (MIT): a third-party open-source parser and renderer
  for Fanqie jianpu scripts. The script spec is at <https://fqdoc.linho.cc/>.
- The [ABC notation standard](https://abcnotation.com/wiki/abc:standard:v2.1): the basis for the fields and
  structure of the 123 format.
- [Bravura / SMuFL](https://github.com/steinbergmedia/bravura) (Steinberg, SIL OFL): music font and glyph metadata.
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) (Apache-2.0): recognition models for digits and lyrics
  in OMR, run with [onnxruntime-web](https://github.com/microsoft/onnxruntime).
- Editor, desktop shell and build: [CodeMirror 6](https://codemirror.net/), [Tauri 2](https://tauri.app/),
  [Vite](https://vite.dev/) and [TypeScript](https://www.typescriptlang.org/).
- Libraries:
  - [opencc-js](https://github.com/nk2028/opencc-js): Simplified/Traditional conversion
  - [pdf.js](https://mozilla.github.io/pdf.js/): PDF rasterization
  - [jsPDF](https://github.com/parallax/jsPDF): PDF export
  - [smplr](https://github.com/danigb/smplr): playback samples
  - [fflate](https://github.com/101arrowz/fflate): PPTX packaging
  - [opentype.js](https://opentype.js.org/): glyph outlines

## License

The code is licensed under MIT (see [LICENSE](LICENSE)). The bundled Bravura font is licensed under the SIL OFL
(see `public/redist`). Third-party dependencies are licensed under their own terms.
