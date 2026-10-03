// 帮助对话框的英文内容，与 help.ts 里的中文表一一对应（主题顺序相同；记谱法只译说明，示例谱码共用）。
// 改中文帮助时同步改这里。

/** 功能帮助主题（不含 extra：快捷键表由 help.ts 按顺序挂上）。 */
export const FEATURE_TOPICS_EN: { title: string; body: string[] }[] = [
  {
    title: "Open, save and save as",
    body: [
      "Use **Open score** on the start page, or drag a file onto the window: 123 (`.123`, the main jianpu format — see the 123 format tab), `.jpwabc` (JP-Word), jianpu-ly (`.jly`, Silas S. Brown's upstream jianpu-ly text scores — typesettable as LilyPond), text jianpu (Fanqie / Shigeben, `.pu` `.fq` `.jps` `.txt`), MusicXML (`.xml` / `.musicxml`), ABC (`.abc`), and recognition projects `.dolce` (see Recognition projects).",
      "**Save** (top right) writes back in the original format (`.jpwabc` stays JP-Word compatible). **Save As** converts to 123, JPWABC, ABC, Fanqie or Shigeben text jianpu — before converting it lists anything the target format can't hold and asks you to confirm. **Export** produces PPTX, MIDI, MusicXML and jianpu-ly (`.jly`, ready to hand to upstream `jianpu-ly` for LilyPond), plus PNG and PDF in the Staff / Mixed views.",
      "The format drop-down in the source pane header switches a recognition result or a freshly opened file to another format for editing; switch back to “original” to restore it.",
      "**Desktop**: native open/save dialogs write straight to disk, and the last file reopens on startup. **Browser**: files are opened with the web file picker and saved as downloads.",
    ],
  },
  {
    title: "Editing with live layout",
    body: [
      "The left pane is a syntax-highlighted source editor that **re-lays out as you type** — the score on the right updates after a ~0.2 s pause.",
      "**Click to locate**: clicking a note or lyric on the score jumps to it in the source. You can also edit right on the score — see the Visual editing tab.",
      "MusicXML has no source pane; in the Mixed view and while proofing a recognition the source is read-only or hidden (see the related topics).",
    ],
  },
  {
    title: "Pages and zoom",
    body: [
      "**Pages**: the previous / next buttons in the status bar at the bottom, or `PageUp` / `PageDown`; `Ctrl/⌘+Home` goes to the first page and `Ctrl/⌘+End` to the last.",
      "**Zoom**: the `−` / `100%` / `＋` buttons in the status bar, `Ctrl/⌘ +` / `-` / `0`, or scroll while holding `Ctrl/⌘`.",
      "The **macOS desktop app** also supports trackpad pinch-to-zoom.",
    ],
  },
  {
    title: "Recognize an image",
    body: [
      "Drag a jianpu **image or PDF** (PNG/JPG/WEBP/PDF) onto the window, or click **Recognize image** on the start page, and it is recognized into an editable 123 score, with four-part jianpu split into separate voices. Recognition runs **entirely on your device** — images are never uploaded — in both the browser and desktop versions.",
      "**Staff notation** can be recognized too: staff PDFs with a complete text layer are read from their text and vectors; scanned or photographed staff images or PDFs (solo songs, choral scores, scores with both staff and jianpu) go through raster recognition. Results open in the Staff / Mixed views and can be edited on the score (see Visual editing → Editing MusicXML). Solo songs are fairly reliable (about 97% of notes); scanned choral scores need more proofreading.",
      "**Which path**: by default it's decided by whether the pages contain staves (the first three pages are checked; cover and contents pages don't count). **Recognize as** on the start page and toolbar can force Jianpu or Staff; changing the toolbar one recognizes the same images again. Several images dropped or picked at once (pages of a staff score) are ordered by file name into one piece; jianpu recognizes one image at a time. Staff recognition shows page progress; press `Esc` to cancel.",
      "Afterwards you land in a proofing view that overlays the result semi-transparently on the binarized image, shown as a nearby popup, in place, or original only (the **Proof** drop-down in the status bar). The **Proof** drop-down holds every way of proofing against the source — Off (score only), Side by side, Source snippet, and the three overlays; the first three stay in the editable score, the overlays open the proofing view. The **Source** checkbox in the status bar hides the code pane in any view — so picking between the two groups switches between the editable score and proofing.",
      "**Edit right in the proofing view**: click a box to select that note (or lyric character); the keyboard, context menu and palette work exactly as on the score. The overlay is redrawn at the source position right away — changed notes turn cyan, deleted ones are struck out in grey, inserted notes are placed between their neighbours with a dashed cyan box, and changed lyrics are written over the original. The red boxes for measures with the wrong beat count update as you go. (Recognition results in 123 and text jianpu can be edited this way; with JPWABC / ABC output the proofing view is read-only.)",
      "**Proofing staff recognition** (scanned / photographed staff notation, and staff PDFs with a text layer): **Proof** (pick one of the overlays) shows the source pages with a box per recognized note, labelled with its current pitch; click a box to edit it — changed notes turn cyan, deleted ones are struck out.",
      "**Doubtful items** (jianpu recognition): notes and lyric characters the recognizer was unsure of get a **dashed yellow box** — a “note” sitting noticeably higher than its line (usually a small annotation), a note that seems to have an unrecognized high dot above it, octave dots that don't look like dots, and uncertain lyric characters. Click **N doubtful** in the status bar at the bottom to jump to the next one and select it; the left side of the status bar says why. Items you change are no longer marked. Yellow doesn't mean wrong (on the test songs roughly one or two in ten are real errors), but most real errors get marked, so check these first.",
      "**Source pages** (toolbar, after a recognition): lists the images used; reorder, remove or add more, rotate images 90° clockwise (sideways photos) and crop them (drag out the area to keep, cutting page margins or a neighbouring page). Rows can be dragged to reorder. Click **Recognize these pages** to rerun the whole piece (edits on the score are lost; you're asked first). PDFs can only be reordered and removed. Check **Adjust images before recognizing** on the start page to open this panel right after picking or dropping images, then click Start. Rerunning a single page isn't supported, since each page carries the key and time from the previous one.",
      "**Side by side** (the **Proof** drop-down in the status bar, after a recognition): back in the engraved score, the full source page sits on the left and the score on the right. The note selected in the score is boxed on the source and scrolled into view; clicking a note on the source selects it in the score (ready to edit). Works for jianpu and scanned staff notation; click again to close. Untick **Source** in the status bar to hide the code pane so the page and the score each take half the width.",
      "**Source snippet** (the **Proof** drop-down in the status bar, after a recognition): back in the engraved score, a small window at the bottom right shows the source line of the selected note with the note boxed, so you can compare as you go.",
      "Please proofread the result — especially lyrics and tricky rhythms.",
    ],
  },
  {
    title: "Recognition projects (.dolce) and autosave",
    body: [
      "**Save** on a recognized score stores a **recognition project** `.dolce`: the source images (or PDF), the recognition result and the score being edited in one file. Opening it later (Open score or drag-and-drop) returns to the proofing view **without recognizing again**; the output format, Recognize as and comparison mode are restored too. Jianpu projects also keep the click positions of the proofing view; staff projects rebuild the comparison data from the stored images the first time you open Compare (takes a moment).",
      "If you only want the score itself, use **Save As** to save 123 / MusicXML / text jianpu and so on (no source images, so no Compare after reopening).",
      "Undo history isn't saved with the file: after reopening you can undo from the moment it was saved. Projects contain the source images, so they are larger than plain scores (a few hundred KB per image).",
      "**Autosave**: unsaved changes are stored as a draft on this device (browser storage, also in the desktop app) about 3 seconds after you stop typing; a recognition in progress is stored with its images. After an accidental close, reload or crash you're asked whether to restore it — a restored draft still counts as unsaved, so remember to save; declining discards the draft. Saving or opening another file discards it. Only the latest draft is kept; nothing is autosaved in private windows or when site storage is disabled.",
    ],
  },
  {
    title: "Importing ABC / MusicXML",
    body: [
      "**ABC notation** (`.abc`) is parsed natively and laid out as jianpu; you can edit it and save the original text. Multiple voices, repeats, first/second endings, chords, ornaments and lyrics are supported.",
      "**MusicXML** (`.xml` / `.musicxml`): when you open a single-part song you can convert it to 123 / JPWABC / ABC / text jianpu for editing, or keep MusicXML and view it as staff notation (Settings can remember the choice). Multi-part scores (e.g. SATB) open in the **Mixed** view.",
    ],
  },
  {
    title: "Score views",
    body: [
      "Four views sit above the score: **Expanded** (repeats and verses unrolled, one verse per page — for projection), **As printed** (laid out once like the original, verses stacked), **Staff**, and **Mixed** (staff notation with a jianpu layer). For text formats the staff notation is generated from the source.",
      "**Line breaking**: “Original” keeps the line structure from import or recognition; “By phrase” re-breaks lines by lyric and musical phrases. Text jianpu is supported too — the source itself is re-broken; click “Original” to restore it exactly (or undo with Ctrl+Z).",
      "These tools only appear when the current file supports them.",
    ],
  },
  {
    title: "Playback",
    body: [
      "The **Playback** button shows Play / Pause / Resume; ■ stops and returns to the beginning. Jianpu, Staff, Mixed and the Compare view all show a vertical playhead across the line (the whole system for multiple parts) that follows every part's note onsets.",
      "Drag the **progress bar** to seek; the time shows elapsed / total (click to show remaining). While playing or paused, clicking a note continues from it; when stopped, clicking a note or dragging the bar sets where the next play starts.",
      "Playback follows the tempo marked in the score, and the speed drop-down scales it from ×0.5 to ×2; changing speed while playing continues from the current position.",
      "**Loop** (toolbar): with a range selected on the score (the visual-editing selection) that range repeats; with nothing selected the whole piece loops — handy for practising a few measures. **Click**: a metronome ticks every beat during playback, higher on the downbeat; compound meters like 6/8 tick in dotted quarters.",
      "For multi-part scores, the **Parts** panel in the header sets each part's volume and can mute a part or play only one (solo, for part practice); changes during playback continue from the current position.",
      "The **macOS desktop app** can use the system's native instruments for better sound.",
    ],
  },
  {
    title: "Export",
    body: [
      "**Export** in the header. In jianpu views you can export **PPTX** (vector, one slide per page, from the Expanded view), **MIDI** (with repeats, dynamics and part volumes) and **MusicXML**.",
      "In Staff / Mixed views you can export the current page as **PNG**, all pages as **PDF**, plus **MIDI** and **MusicXML**. Exports match the current preview (with or without the jianpu layer). To change the source format, use **Save As**.",
    ],
  },
  {
    title: "Parts (choral scores)",
    body: [
      "**Parts** in the header opens the parts panel, one row per part: **name / short name** (press Enter after editing), **clef** (treble, tenor's octave-down treble, bass, alto, tenor), **transposition** (B♭ for clarinet and trumpet, F for horn, E♭ for alto sax, octave transpositions; written pitch is shown and playback uses concert pitch; MusicXML only), **staves** (number of staves, 2 for a piano grand staff; display only), **visible** (whether the part shows in Staff / Mixed; display only, not saved, and it still plays), playback **mute / solo / volume**, **jianpu** (which part supplies the melody for the Mixed jianpu layer and MusicXML jianpu views), and **lyrics** (which part's lyrics the MusicXML Expanded jianpu view uses, matched to the melody by time — choral scores often print the words under the alto; none checked = automatic, the part that has words).",
      "Buttons on the right: **↑ ↓** reorder, **duplicate**, **split by voice** (two lines on one staff become two parts, e.g. an S/A shared staff into open score), **split by chord** (the lowest chord note moves to a new part below; unisons go to both), **merge into previous** (back into a shared staff), **delete**.",
      "**New part** at the bottom appends one (whole-measure rests, measures copied from the first part; choose the clef first). **Copy lyrics from … to …** copies lyrics to another part by time (an existing verse in the target isn't overwritten) — for choral scores with one lyric line shared by several parts.",
      "Every step takes effect immediately and `Ctrl/⌘+Z` undoes it. In 123 / ABC renaming and changing the clef only edit the `V:` line; adding, removing, reordering, splitting and merging rewrite the whole source in the standard form (`%` comments are lost; you're asked first). In MusicXML, changing the part structure switches the piece to automatic layout.",
      "**Recognized staff notation**: below the panel there's a staff ↔ part table — one row per system, one drop-down per staff to choose which part row it belongs to, a new part, or ignore (e.g. drop the piano accompaniment). Fix it here when a system omits a part or recognition paired staves wrongly, then click **Apply** to rebuild with the new mapping (no new recognition; edits on the score are lost, you're asked first).",
      "Support: MusicXML, 123 and ABC have everything (“merge into previous” is MusicXML only — 123 / ABC write one melody per part; ABC clefs can't be changed); text jianpu and JP-Word only have the playback settings.",
    ],
  },
  {
    title: "Simplified / Traditional Chinese",
    body: [
      "**简/繁** in the header converts all Chinese text — lyrics, titles and credits — while leaving the music code untouched; it works for all five formats.",
      "Choose Auto-detect, Simplified → Traditional or Traditional → Simplified. Lyric marks such as `/` and `-` stay in place and don't split words (`日光/之下` is still converted as one word). The source itself is changed, so `Ctrl/⌘+Z` undoes it in one step.",
    ],
  },
  {
    title: "Settings",
    body: [
      "**Settings** (in the header) has three tabs and only shows options that take effect in the current view: **Layout** (paper, orientation, margins, aspect ratio, lines per page, font size, colors; staff size, lyric size and hidden measure numbers in Staff / Mixed), **Header & style** (songbook style sheet `.ss`; fonts and sizes for title, subtitle, scripture and credits), and **Other** (interface language, what to do when opening MusicXML, sound when editing notes). Per-part playback volume is in the **Parts** panel on the toolbar.",
      "“Reset this view” at the bottom only clears the settings of the current view.",
    ],
  },
  {
    title: "Interface language",
    body: [
      "The interface is available in **中文** and **English**. On first launch it follows your browser / system language; change it any time in **Settings → Other → Language** — it switches instantly, no reload needed.",
      "Only the interface is translated; scores, lyrics and notation code stay as they are. You can also add `?lang=en` or `?lang=zh` to the URL.",
    ],
  },
  {
    title: "Keyboard shortcuts",
    body: [],
  },
];

/** 主快捷键表的行（与 help.ts 的中文行一一对应）。 */
export const SHORTCUTS_EN: [string, string][] = [
  ["Zoom in / out", "Ctrl/⌘ +  ·  Ctrl/⌘ -"],
  ["Reset zoom to 100%", "Ctrl/⌘ 0"],
  ["Previous / next page", "PageUp  ·  PageDown"],
  ["First / last page", "Ctrl/⌘ Home  ·  Ctrl/⌘ End"],
  ["Ctrl/⌘ + scroll wheel", "Zoom around the pointer"],
];

/** 可视化编辑主题（不含 extra）。 */
export const VISUAL_TOPICS_EN: { title: string; body: string[] }[] = [
  {
    title: "Two modes, two cursors",
    body: [
      "Edit right on the score: **click the score** so it takes the keyboard; the current mode is shown at the top right. Every change is written back to the source on the left, which stays the single source of truth.",
      "**Edit mode** (block cursor): the block covers the selected element and keys act on it. Clicking a note (or a dot, chord name or ornament on it) enters Edit mode; clicking a note selects only the note itself (accidental, degree, octave dots), not its underlines or dot. **Dots, underlines, extension dashes, barlines and slurs can each be clicked on their own** — whatever you click is selected, and `Delete` or `Backspace` removes just that (deleting an underline returns the note to a quarter, deleting a barline merges two measures, deleting a slur removes both brackets, deleting a dash shortens the note by a beat).",
      "**Insert mode** (bar cursor): the bar sits between two elements and actions insert at it. Clicking the gap between two notes enters Insert mode.",
      "**Text is selected with a single click and edited with a double click**: a single click on lyrics, title, subtitle, credits or key/time signature selects the whole item (the score keeps the keyboard, so `Delete` removes it); a double click enters Insert mode with the bar at the clicked character in the source and hands the keyboard to the source pane, so typing edits that text. Lyrics select one syllable at a time. When the source cursor is on these fields, the matching text on the score lights up too.",
      "`Insert` or `i` switches from Edit to Insert mode (the bar goes after the selection); `Esc` switches back to Edit mode (the block covers the element before the cursor).",
      "Both cursors are **shown in the source and on the score at the same time**: with the score focused, the selected note token is boxed in the source and the insert position blinks; moving the cursor in the source moves the score cursor too.",
    ],
  },
  {
    title: "Selecting and moving",
    body: [
      "`←` / `→` step through notes, dashes, barlines and line breaks; `Shift+←` / `Shift+→` extend the selection; `Home` / `End` jump to the start and end of the line on the score.",
      "`Ctrl/⌘+←` / `Ctrl/⌘+→` jump by measure (to the measure start); add `Shift` to extend by measure. `Ctrl/⌘+G` (web: `Alt+G`, since the browser uses `Ctrl+G`) asks for a measure number and jumps there, counted in the current part.",
      "`Shift` + click selects from the current selection to the clicked note.",
      "**Double-click empty space in a measure** to select the whole measure (a single click still places the insert cursor). **Drag from empty space** to draw a box; on release the notes inside, with the barlines between them, are selected (dragging from a note or text doesn't start a box). With the score focused, `Ctrl/⌘+A` selects the whole piece.",
      "With a note selected, the left of the score pane header shows its readout: (the part, for multi-part scores) measure and beat, note name and degree, duration — no need to look back at the source to count beats or check pitch.",
    ],
  },
  {
    title: "Editing in Staff / Mixed views",
    body: [
      "The **Staff** and **Mixed** views are editable too: click a notehead (or the jianpu digit above it in Mixed) to select the note; click a lyric character, barline or slur/tie to select it; click between two notes to place the insert cursor. All shortcuts, the context menu and the palette are the same as in the jianpu views.",
      "You're still editing the source on the left — the staff notation is generated from it on the fly — so the jianpu and staff views share **one selection and undo history**; edit in one, look in the other. The selection box follows the notehead ink, and the insert cursor sits midway between two notes, as tall as the staff row (including the jianpu layer in Mixed).",
      "Staff notation has no separate dots, underlines or dashes (they show as note values and beams); to change them select the note and press `.`, `_`, `=`. Chord names and ornaments can only be clicked in the jianpu views for now. The beat check marks measures red on the staff as well.",
    ],
  },
  {
    title: "Measures, repeats and jumps",
    body: [
      "**Measure** at the bottom of the context menu expands the measure actions (the palette has them too): `Ctrl/⌘+B` appends an empty measure at the end, `Ctrl/⌘+Shift+B` inserts one before the current measure, `Ctrl/⌘+Delete` deletes the selected measures; new measures get a whole-measure rest.",
      "**Key… / Time… / Tempo…** ask for a value: a key as `1=G`, `G`, `bB` or `F#`; a time like `3/4` or `6/8`; a tempo in beats per minute (`0` removes it). In the first measure this edits the header `K:` / `M:` / `Q:`; mid-piece it writes inline forms like `[K:…]`.",
      "**Barline styles** (normal, double, final, start repeat `|:`, end repeat `:|`) change the measure's closing barline (start repeat changes the opening one); repeats on both sides become `::`. **First / second ending** marks the selected measures as an ending (click again to remove). **𝄋 / ⊕ / D.C. / D.S. / Fine** go at the start or end of the measure; click again to remove.",
      "Available for 123, ABC and MusicXML; for `.jpwabc` and text jianpu edit measures in the source (not listed in the menu). In multi-part text formats only the part with the cursor changes; MusicXML changes all parts together.",
    ],
  },
  {
    title: "Chords and voices (MusicXML)",
    body: [
      "**Add a chord note**: select a note and press `Alt+1`–`Alt+7` to stack a degree on it (nearest above the top note). **Alt+click** a notehead in a chord to select it alone; `Delete` removes just that note.",
      "**Voice input**: `Ctrl+Alt+1`–`4` chooses which voice newly inserted notes go into (the mode label at the top right shows “voice 2”); in Insert mode, typed notes are written into that voice at the cursor's time, with the two lines on one staff stemmed in opposite directions.",
      "Jianpu prints one melody per part, so these only work for MusicXML; in text formats write separate voices with `V:` in the source.",
    ],
  },
  {
    title: "Editing MusicXML",
    body: [
      "An opened `.musicxml` (and the result of staff recognition) has no source pane, but it can still be edited on the score: selection, shortcuts, context menu and palette are the same as for text formats in the jianpu, staff and mixed views. You edit the score itself — pitches are converted through the key (degree `5` in `1=F` is C), durations change the note value directly, beams are regrouped automatically, and voice alignment within measures is recomputed on save.",
      "**Text**: double-click a lyric or the title for an in-place box, press `Enter` when done; in lyrics `Enter` / `Tab` move on to the next syllable of the same verse (`Shift+Tab` back), `Esc` cancels. A title written both as the work title and in the header changes in both. Select text and press `Delete` to remove it (a lyric syllable goes together with its slot).",
      "**Barlines and line breaks**: `|` splits the measure at the cursor into two (all parts together; not possible if another part has a note across that point), and deleting a barline merges two measures. Staff notation can only break lines at barlines, so `Enter` must be at the end of a measure.",
      "**Layout**: changing only pitches keeps the original layout; after adding or removing notes, changing durations or splitting/merging measures the fixed measure widths and note positions no longer fit, so the piece switches to automatic layout (line breaks kept). On save the whole file is rewritten in the standard form; content that isn't understood is kept as is.",
      "Undo / redo (`Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z`) work as usual. When the file's time unit per quarter is too coarse for, say, a dotted eighth, a finer unit is chosen automatically; the music doesn't change.",
    ],
  },
  {
    title: "Changing notes",
    body: [
      "With a note selected (Edit mode): `1`–`7` change the degree and `0` makes it a rest; letters `A`–`G` set the note name (converted to a degree by the key: in `1=G`, `G` is 1 and `F` is the sharp 4; octave nearest the old note); `#` `Shift+B` `n` add a sharp, flat or natural (press again to remove); `.` toggles a dot.",
      "**Pitch**: `↑` / `↓` move one scale step in the key (`7` up becomes high `1`; accidentals are dropped); `Alt+↑` / `Alt+↓` move a semitone (a note in the key is written plainly, otherwise sharp keys use sharps and flat keys flats; C uses sharps going up and flats going down); `'` / `,` or `Ctrl/⌘+↑` / `Ctrl/⌘+↓` shift the octave. With a range selected, it all moves together.",
      "`_` halves the duration (removing half the dashes if any, otherwise adding an underline), `=` doubles it (removing an underline if any, otherwise adding dashes), and `-` adds a dash after the note.",
      "**Tuplets**: select some notes and press `Ctrl/⌘+3` (web: `Alt+Shift+3`, since the browser uses `Ctrl+digit` for tabs) to make a tuplet — 3 notes make a triplet, the count follows the selection (duplets and quadruplets take the time of 3, others the largest power of 2 below them); press again on a group to split it back. 123 writes `(3: … )`, ABC writes `(3`, MusicXML changes the time ratio and adds a bracket.",
      "`Shift+F` toggles a fermata and `>` an accent. 123, ABC, `.jpwabc`, text jianpu and MusicXML can all be edited on the score; each format writes things its own way (e.g. ABC uses note names with absolute accidentals; `.jpwabc` can't combine dashes with underlines or dots), and edits follow each format's rules.",
    ],
  },
  {
    title: "Key changes (what's different from before)",
    body: [
      "To match common notation software (MuseScore, Sibelius, Dorico) and free the letter keys for note names, these keys changed:",
      "`↑` / `↓`: used to shift the octave, **now move by scale step**; for octaves use `'` / `,` (as written in 123) or `Ctrl/⌘+↑` / `Ctrl/⌘+↓`.",
      "Flat: used to be `b`, **now `Shift+B`** (`b` is note name B). Fermata: used to be `f`, **now `Shift+F`** (`f` is note name F).",
      "New: `A`–`G` note names and `Alt+↑` / `Alt+↓` semitones. Digits `1`–`7` and `0` are unchanged.",
    ],
  },
  {
    title: "Inserting and deleting",
    body: [
      "In Insert mode, typing a digit (or a note name `A`–`G`, octave nearest the previous note) inserts a note at the cursor using the “current duration” shown at the top right, which `_` / `=` adjust; right after inserting, `↑` `↓`, `Alt+↑` `Alt+↓`, `'` `,` change the note just inserted without moving the cursor; `-` inserts a dash and `|` a barline.",
      "`Delete` / `Backspace`: in Edit mode they delete the selection — a note goes together with its dashes, chord name and ornaments; in Insert mode they delete the element after / before the cursor.",
    ],
  },
  {
    title: "Lyric entry",
    body: [
      "Select a note and press `Ctrl/⌘+L` (web: `Alt+L`, since the browser uses `Ctrl+L`): a small box opens under the note for verse 1 (if a syllable of another verse is selected, that verse); existing text is prefilled.",
      "Keys in the box: `Space` or `Tab` confirm and go to the next note; `-` hyphen (one English word across several notes, `hal-le-lu`); `_` melisma (the syllable extends to the next note, which gets no syllable of its own); `/` leave this note empty; `Shift+Space` back to the previous note; `Enter` next verse (same note); `Esc` finish (anything not yet committed is dropped). Rests are skipped.",
      "Type several Chinese characters at once (e.g. 日光之下) and press Space to spread them one per note. Space and Enter used by a Chinese input method to pick characters go to the input method as usual.",
      "123 and ABC write a `w:` line (a new one if this verse has none yet, padding earlier notes with skips); MusicXML writes `<lyric>` (hyphens as `syllabic`). Text jianpu and JP-Word can only change notes that already have a syllable; add missing ones in the source lyric line.",
    ],
  },
  {
    title: "Chord names, text and dynamics",
    body: [
      "Select a note and press `Ctrl/⌘+K` (web: `Alt+K`): a box opens above it for a chord name (`C`, `Am7`, `G/B`, `N.C.`…), prefilled with the existing one. `Space` confirms and moves to the next note (rests can carry chords too), `Shift+Space` goes back, `Enter` confirms and closes, `Esc` cancels; submitting an empty box removes the chord name.",
      "123 writes valid chord names without quotes (`C 1`) and others in quoted form (`\"N.C.\"1`); ABC always `\"C\"`; MusicXML writes `<harmony>` (root and kind parsed from the text). For text jianpu and JP-Word edit chord names in the source.",
      "**Text**: `Ctrl/⌘+T` (web: `Alt+T`) adds text above the selected note (rit., refrain, repeat twice…), `Enter` to submit. **Dynamics**: `Ctrl/⌘+E` (web: `Alt+E`) takes `p` `mp` `mf` `f` `ff` `sfz` `fp` and so on, `Space` moves to the next note. Existing values are prefilled; submitting empty removes them. 123 and ABC write `\"^rit.\"` and `!mf!`; MusicXML writes `<direction>` (text above, dynamics below).",
    ],
  },
  {
    title: "Copy, paste, repeat and transpose",
    body: [
      "With the score focused, `Ctrl/⌘+C` copies the selected notes (with their dashes and barlines), `Ctrl/⌘+X` cuts and `Ctrl/⌘+V` pastes; with the source pane focused these keys handle text as usual. They're also in the context menu and palette.",
      "**Where it goes**: Insert mode pastes at the cursor; Edit mode pastes **after** the selection (nothing is overwritten) and then selects what was pasted.",
      "**Across formats**: the same format pastes verbatim (chord names, ornaments and annotations included); another format (e.g. copy from 123, paste into ABC) or MusicXML brings only notes, dashes and barlines, **by degree** — pasted into another key the degrees stay (`1 2 3` from 1=C pasted into G is still `1 2 3`, i.e. G A B). Barlines aren't pasted into MusicXML (measures follow the time signature).",
      "Source text copied from elsewhere can be pasted directly too (inserted as source of this format).",
      "`R` (Edit mode) pastes the selection again right after it and selects the copy; keep pressing `R` to repeat further — for repeated figures or the same rhythm with new notes. The clipboard is untouched.",
      "**Transpose** (context menu / palette “Transpose…”): “whole piece” changes the key — jianpu uses movable do, so digits stay and only the key changes (key changes mid-piece move too); ABC and MusicXML notes move along. “Selected notes” moves them by semitones without changing the key (jianpu writes accidentals). The dialog shows the resulting key; chord symbols don't move; text jianpu and JP-Word only change the opening key.",
    ],
  },
  {
    title: "Line and page breaks",
    body: [
      "`Enter` breaks the line after the selection (Insert mode: at the cursor) and `Shift+Enter` breaks the page; at the end of a measure the barline stays on the earlier line.",
      "In ABC a line break is the end of a code line: breaking splits the code line in two and deleting the break joins them, with `w:` lines following along. In text jianpu a line break starts a new `Q:` line: breaking cuts the `Q:` and `C:` lines together, and selecting the break at the line end and pressing `Delete` joins it with the next line. `.jpwabc` lyrics are anchored, so their `@measure,note` anchors are recomputed after adding or removing notes, barlines or breaks.",
      "**Lyrics split too**: in 123 a `$` ends a music line and the `w:` lines right after a code line belong to its last music line. So breaking splits the code line at the cursor and splits every `w:` line at the matching syllable, moving the first half under the earlier line; deleting the break does the reverse, joining verses back together (padding with `/` if the earlier part is short).",
      "Lines whose lyrics use `+:` continuation can't be split automatically yet; you'll be asked to edit the source.",
    ],
  },
  {
    title: "Marks attached to notes",
    body: [
      "**Add a slur**: select a range (`Shift+→` or `Shift`+click) and press `s` (or `(`); an identical slur is removed. **Add a tie**: select a note and press `t` to tie it to the next note of the same pitch; press again to remove. In 123 both are written as brackets — the difference is only whether the notes have the same pitch.",
      "Chord names, fermatas and other ornaments, section annotations and slurs/ties can be selected on their own: click them on the score (chord names, ornaments, annotations), or select a note and press `Tab` to cycle through its marks, returning to the note after a full round.",
      "With a mark selected, its source text is selected too (e.g. `\"G\"`, `!fermata!`, a slur's brackets); press `Delete` to remove it — deleting a slur/tie removes both brackets.",
    ],
  },
  {
    title: "Formatting marks (line and page breaks)",
    body: [
      "The **¶** button at the top right of the score pane (or `Ctrl/⌘+Shift+M`) toggles formatting marks: a line break `↵` at the end of each line and `⤓` at page breaks; the matching `$`, `$$`, `$(…)` and `[fenye]` in the source are dimmed.",
      "Click a line break to select it. In text jianpu (Fanqie / Shigeben) a line break simply starts a new `Q:` line, so there's no separate symbol in the source.",
    ],
  },
  {
    title: "Context menu and symbol palette",
    body: [
      "**Right-click** the score: it first selects by the click rules (note, mark, line break; empty space places the insert cursor), then shows the actions available for it, each with its shortcut.",
      "**Palette** at the top right of the score pane opens the symbol palette: degrees, note names, steps and semitones, octaves, accidentals, durations, slurs/ties, fermata, accent, barlines, line/page breaks and delete are all clickable; buttons unavailable in the current mode are greyed out. Buttons show the score symbol (`1̇` high dot, `1̲` underline, `⌢` slur…), and hovering shows the name and shortcut.",
      "The palette and menu run the same actions as the keyboard shortcut table.",
    ],
  },
  {
    title: "Sound when editing notes",
    body: [
      "After changing a degree, octave or accidental, or inserting a note, a short piano note sounds (pitch follows the key signature) so you can check by ear while entering. It stays silent during playback.",
      "Turn it off by unchecking “Sound when editing notes” in **Settings**.",
    ],
  },
  {
    title: "Beat check",
    body: [
      "Every measure's length is checked against the time signature; measures that don't add up get a light red background on the score (hover for a note like “1/2 beat short”) and a red squiggle under their first note in the source. The count is shown at the top right — click it to jump through them.",
      "Accepted cases: a pickup first measure; first and last measures that add up to one full measure; two adjacent partial measures split by a repeat sign that add up to one; mixed meters (`M:3/4 4/4`) match either signature; free-time music without a time signature isn't checked.",
      "The **Beats** button at the top right toggles the check. **Image recognition** uses the same check and circles mismatched measures in the proofing view (usually a misread dash or underline).",
    ],
  },
  {
    title: "Undo and redo",
    body: [
      "`Ctrl/⌘+Z` / `Ctrl/⌘+Shift+Z` on the score share one undo history with the source pane — undoing on either side is the same.",
    ],
  },
  {
    title: "Shortcut reference",
    body: ["These shortcuts work when **the score has focus** (click the score first). `/` is not bound; it's reserved for lyric alignment."],
  },
];

export const GLOSSARY_EN: [string, string][] = [
  ["Degrees 1–7", "Jianpu writes the seven notes do re mi fa so la ti as the digits 1234567; `0` is a rest (silence)."],
  ["Octave dots", "Small dots above or below a note: each dot above raises it an octave, each dot below lowers it an octave."],
  ["Underlines", "Short lines **under** a note: one halves its duration (an eighth note), two halve it again (a sixteenth)."],
  ["Extension dashes", "Dashes `-` **to the right** of a note, each adding one beat."],
  ["Dot", "A small dot `.` to the right of a note adds half its value (a dotted quarter = quarter + eighth)."],
  ["Barline / time signature", "`|` separates measures; a time signature such as `4/4` means four beats per measure with a quarter note as the beat."],
  ["Key", "E.g. `1=C` means do is sung as C, setting the pitch reference for the whole piece."],
  ["Slur / tie", "Arcs between notes: across different pitches it's a slur (legato); across the same pitch it's a tie (joining two notes into one long note)."],
];

/** 记谱法各节的标题与说明，与 help.ts 的 NOTATION 顺序一一对应（示例谱码共用）。 */
export const NOTATION_TEXT_EN: { title: string; body: string[] }[] = [
  {
    title: "Notes and rests",
    body: [
      "Jianpu writes the seven degrees (do re mi fa so la ti) as **1–7**, and **0** is a **rest** (no sound on that beat).",
      "Spaces between notes are optional.",
    ],
  },
  {
    title: "Octaves (octave dots)",
    body: [
      "**Octave dots**: a `'` (apostrophe) puts a dot **above** the note, raising it an octave; a `,` (comma) puts a dot **below**, lowering it an octave. Two marks mean two octaves.",
      "In the source they go **after** the digit: `1'` is high do and `1,` is low do.",
    ],
  },
  {
    title: "Sharps and flats",
    body: [
      "Put `#` **before** a digit to raise it a semitone and `b` to lower it.",
      "For example `#4` is fa sharp and `b7` is ti flat.",
    ],
  },
  {
    title: "Duration: underlines and sixteenths",
    body: [
      "**Underlines** (`_` under the note) halve the duration: one `_` is an eighth note, two `__` a sixteenth.",
      "Adjacent short notes are beamed together automatically.",
    ],
  },
  {
    title: "Duration: dots and extension dashes",
    body: [
      "A **dot** `.` (to the right of the note) adds half its value: `5.` is a dotted quarter, often paired with an underline as `5. 5_` (dotted rhythm).",
      "Each **extension dash** `-` adds one beat: `5-` is a half note and `5---` a whole note.",
    ],
  },
  {
    title: "Barlines, time signature and key",
    body: [
      "`|` is a **barline** separating measures. The **time signature** and **key** go in `KeyAndMeters` in the `.Title` section, written `{part=key,meter}`, e.g. `{1=G,3/4}`.",
      "The time signature can also change mid-`.Voice` by simply writing a mark like `3/4`.",
    ],
  },
  {
    title: "Repeat signs",
    body: [
      "Repeat signs make a passage play twice: `|:` starts the repeat and `:|` ends it.",
      "`||` is a double barline (section end) and `|]` is the final barline.",
      "`.jpwabc` follows JP-Word's look: repeat signs and barline styles **aren't drawn** on the score, but playback and the Expanded view still repeat by them.",
    ],
  },
  {
    title: "Singing order (.Repeat section)",
    body: [
      "`|:` `:|` and first/second endings in `.Voice` are only **printed marks**; the actual order — and which verse is sung each time — comes from the `.Repeat` section. Importing MusicXML, recognizing an image or opening ABC fills it in automatically, so you rarely write it by hand; edit it when you need precise control.",
      "One entry per line, `startMeasure-endMeasureVverse` (measures count from 1). Entries are sung in order and a range may appear more than once. The example sings measures 1–4 twice — verse 1 then verse 2 — and then measures 5–8.",
      "Add `P` after the verse number to **turn the page after this pass** (for separating verses and chorus): `1-4V1P`.",
      "Endpoints can point at notes: a start of `11.2` enters at the **2nd note** of measure 11 (handy for long notes ending across lines); an end of `11.1` stops after the **1st note** of measure 11.",
      "Entries can also be comma-separated on one line: `1-4V1,1-4V2` is the same as two lines.",
    ],
  },
  {
    title: "Slurs and ties",
    body: [
      "Arcs between notes: across **different** pitches it's a **slur** (legato, one breath); across the **same** pitch it's a **tie** (joining two notes into one longer note).",
      "In the source, wrap the notes in parentheses `( ... )`.",
    ],
  },
  {
    title: "Fermata",
    body: [
      "Write `{YanYin}` **before** a note to add a **fermata** (the “◠” above it), meaning the note may be held freely.",
    ],
  },
  {
    title: "Lyrics",
    body: [
      "Lyrics go in the `.Words` section. The prefix `W1@1,1:` means verse 1, aligned from the 1st note of measure 1.",
      "Each character **maps to one note by default**; `/` means **no new character** on that note (a melisma). Write further verses as `W2`, `W3`…",
    ],
  },
  {
    title: "Title information",
    body: [
      "The `.Title` section holds the header: `Title` is the title (centered at the top), `WordsByAndMusicBy` the credits (`{lyricist,composer}`), and `KeyAndMeters` the key and time signature.",
      "`Expression` holds tempo and expression: `{♩=76}` means 76 beats per minute, or write an expression text. Playback and MIDI export follow `{♩=…}` (♩=90 if absent); the speed drop-down next to Playback scales it (×0.5–×2).",
      "JP-Word itself stores the note symbol as the letter `J` (displayed as ♩ by the music font); both spellings are read, so tempos from JP-Word files are kept.",
      "The example below renders the header layout of a title page.",
    ],
  },
];
