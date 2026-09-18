# AGENTS.md — dote

Ground truth and session memory for this project. This file exists so that
work done here doesn't have to be rediscovered every session.

## Instructions for Claude

- Read this file first, before doing anything else, at the start of every
  session in this project.
- When something here conflicts with general defaults or assumptions, prefer
  what's written here — it reflects what was actually learned/decided in
  this project.
- Global instructions from `~/.claude/CLAUDE.md` (e.g. "do not compile,
  build, run, or test anything") still apply and are not overridden by this
  file unless the user explicitly says otherwise.
- As you work, write down anything worth remembering next time: setup
  steps, architecture, conventions, gotchas, decisions and their reasons,
  terminology. Do this as you go, not just at the end.
- Keep entries factual and current. If something here turns out to be wrong
  or stale, correct or remove it rather than leaving it stale.
- Prefer editing the relevant section below over appending a changelog-style
  entry — this file should read as the current state of knowledge, not a
  log.
- All file writes (create/edit) anywhere under this project directory are
  pre-approved — do not ask for confirmation and do not show diffs before
  writing. The user tracks changes externally via git and diffs there
  themselves.

## Project Overview

**dote** is a single page web editor for `.dot` files in the **humandot**
format — think geojson.io, but for humandot instead of GeoJSON.

A **dot** is a location: longitude, latitude and a vector of tags. A tag can
be anything — a label, a key/value pair, a URL, a line of free text. The
model comes from [clj-geo](https://github.com/vanjakom/clj-geo):

- `src/cljc/clj_geo/dot/core.clj` — the dot itself
- `src/clj/clj_geo/dot/store/humandot.clj` — the file format, its reader and
  writer. This file's header comment is the format specification.

The app is the reference implementation of that format in the browser. The
Clojure code stays authoritative: when the two disagree, clj-geo wins unless
a divergence is listed under Gotchas below.

### Layout

```
+-------------------------------------------------------+
| menu bar   File  Edit  View  Help                      |
+-----------------------------------+-------------------+
|                                   |                   |
|  map (Leaflet, OSM tiles)         |  text, 80 columns |
|  takes all remaining width        |  monospaced       |
|                                   |                   |
+-----------------------------------+-------------------+
| status bar  file · dots · problems · cursor · lon,lat  |
+-------------------------------------------------------+
```

## The humandot format

```
[humandot]                 magic first line
[tag:#trip]                directive — appends #trip to every dot in the file
; comment                  comment, column 0 only
20.4612, 44.8125           starts a dot — LONGITUDE FIRST, then latitude
   Beograd                 indented line -> a tag of the dot above
   #capital                # public label
   @visited                @ personal label
   |population|1370000     |key|value pair
   https://www.openstreetmap.org/relation/1677007
   ---                     separates extracted tags from added ones
   ===                     separates public tags from private ones
<blank line>               closes the dot
```

Reader branch order is significant and is reproduced exactly in
`js/humandot.js`: comment → `[humandot]` → `[statement]` → blank → indented
tag → line containing a comma. Consequences worth remembering:

- An **indented** `;` or `[x]` is a *tag*, not a comment or a directive.
- Only the first two comma separated fields of a coordinate line are read.
- `[tag:x]` is the only directive with meaning today; other `[statement]`
  lines parse and are ignored.
- Default tags from `[tag:x]` are appended to every dot's tag list *at read
  time*. They are never written into individual dots.

## Setup

No build step, no package manager, no dependencies to install.

- Open `index.html` directly in a browser (`file://` works), or serve the
  directory with any static server if you prefer (`python3 -m http.server`).
- Leaflet 1.9.4 and OpenStreetMap tiles load from the network. Everything
  else is local.
- Per global instructions the user runs and verifies the app; correctness is
  reasoned about by reading the code.

## Architecture

```
index.html          structure only: menu bar, panes, status bar, help dialog
css/dote.css        all styling, light and dark via prefers-color-scheme
js/humandot.js      format: parse, classify, format, write. Pure, no DOM.
js/editor.js        the text pane: textarea + highlight layer + gutter
js/dotmap.js        the map pane: a thin layer over Leaflet
js/app.js           wiring: menus, shortcuts, file IO, status bar, sync
samples/            example .dot files
```

**The text is the document.** `js/app.js` never mutates a parsed dot. Every
interaction that changes data — dragging a marker, adding a dot, formatting
— is turned into an edit of the textarea; the text re-parses and the map
re-renders from the result. The map is a view, never a second source of
truth.

Data flow per keystroke:

```
textarea input -> Editor.render (highlight + gutter)
               -> debounce 120ms -> humandot.parse
                                 -> DotMap.setDots
                                 -> Editor.setProblems
                                 -> status bar
```

Selection is synced in both directions: the cursor line determines the
selected dot (`humandot.dotIndexAtLine`), and clicking a marker selects that
dot's lines in the textarea.

Moving the text cursor into a *different* dot pans the map to center on it
and never changes the zoom (`DotMap.panToDot` without a zoom argument). Only
a change of selected dot triggers it — typing inside the same dot does not.
Edits that originate on the map — clicking a marker, dragging one, adding a
dot — run inside `withoutPan()` so the view does not jump away from the
pointer. `View > Zoom to dot at cursor` is the one command that does change
zoom, on purpose.

Each parsed dot carries `line`, `endLine` and `tagLines` (0-based line
indexes into the document). That is what makes map ↔ text linkage possible;
keep those fields accurate in any parser change.

### Map view in the url

The map view is mirrored into the location hash as `#map=zoom/lat/lon` and
restored on reload. A view in the hash wins over fitting the map to the dots,
which is what the `keepView` argument of `setDocument` is for. `hashchange`
is listened to as well, so pasting a hash moves the map.

That hash is **latitude first** — the one place in the project where
longitude does not come first. It is the format openstreetmap.org,
geojson.io and umap use, so a view pastes straight between them. Everything
else stays longitude first.

## Conventions

- Plain ES5-style JavaScript in classic `<script defer>` tags, everything
  hanging off a single `window.DOTE` namespace. `async`/`await` is used only
  in the file IO section of `app.js`, where promise chains would be worse.
- No ES modules — `import` fails under `file://` (CORS), and opening
  `index.html` straight from disk has to keep working.
- No framework, no bundler, no CSS preprocessor. Keep it that way unless the
  user asks otherwise.
- `js/humandot.js` stays pure: no DOM, no Leaflet, no globals besides its
  own export. It is the piece that could be reused elsewhere.
- Comments explain *why*, not *what*. The format quirks are worth commenting;
  obvious DOM code is not.
- **All text is black.** No glyph in the interface carries meaning through
  its colour. The syntax layer separates line and tag kinds with weight,
  slant and underline only (comments italic, labels and directives bold,
  links and malformed text underlined); states use background tints. Do not
  reintroduce coloured text — if something needs to stand out, reach for
  weight, a rule, or a tint behind it.
- Because black text needs a light ground there is **one light theme and no
  dark variant**. There is no `prefers-color-scheme` block to keep in sync.
- Map markers are not text and keep their colours (blue plain, green public,
  amber personal, red invalid).
- CSS uses custom properties for the few remaining values (`--text`, the
  backgrounds, `--tint`, `--tint-strong`, the marker colours).

## Gotchas / Known Issues

- **Longitude comes first.** In the file format, in `create`, in
  `write-to-string`, everywhere. Leaflet is the opposite (`[lat, lng]`), so
  every conversion in `dotmap.js` is a deliberate swap. The parser emits a
  specific error when coordinates look swapped.
- **clj-geo drops a dot when two coordinate lines are not separated by a
  blank line** — the reader overwrites the location under construction
  instead of pushing it. `js/humandot.js` deliberately diverges and closes
  the previous dot instead, so the editor never silently loses data.
  Well-formed files parse identically in both. `humandot.format` always
  inserts the blank line, so anything the editor writes is safe to read with
  clj-geo.
- **clj-geo `write` emits two blank lines between dots** (`write-line` on a
  string that already ends in `\n`, then `write-new-line`). Our formatter
  emits one. Both parse the same; don't "fix" one to match the other.
- **The editor does not wrap.** The highlight layer and the gutter only stay
  aligned with the textarea while every logical line occupies exactly one
  visual row. Long lines scroll horizontally. Changing this means rewriting
  the gutter to measure wrapped rows.
- The 80 column width is `calc(80 * 1ch + padding)` and depends on the pane
  actually using the monospace font — `ch` is measured from the element's own
  font. Don't move the font declaration off `.editor`.
- Programmatic edits go through `Editor.replaceRange`, which uses
  `document.execCommand('insertText')`. It is deprecated but it is the only
  way to edit a textarea while keeping the browser's native undo stack. There
  is a direct-assignment fallback that dispatches a synthetic `input` event.
- `marker._icon` is touched directly in `dotmap.js` to toggle the selected
  class. Private Leaflet API, stable in practice, but it is why markers must
  be added to the map before selection is painted.
- Saving in place uses the File System Access API (`showSaveFilePicker`),
  which is Chromium only. Other browsers fall back to a download.
- Session text is mirrored into `localStorage` under `dote.session` so a
  reload doesn't lose work. It is a convenience only — the file on disk is
  what counts.
- **`history.replaceState` throws under `file://`** (origin `null`), which is
  exactly how this app is meant to be opened. `writeHash` catches it once,
  sets `canReplaceState = false` and falls back to assigning
  `location.hash` — correct, but it costs a history entry per view change, so
  the back button walks the map history when running from disk. Served over
  http it uses `replaceState` and leaves no entries. The `hashIsOurs` guard
  belongs only to the fallback path: `replaceState` does not fire
  `hashchange`, assignment does.

## Decisions Log

- **Vanilla JS over ClojureScript.** The format is defined in Clojure and the
  user is a Clojure developer, so cljs was the obvious alternative. Rejected
  because it needs shadow-cljs and a build step, and the user does not build
  or run in this workflow — a file that opens straight from disk is worth
  more here. `js/humandot.js` is isolated enough to be swapped for a cljs
  implementation later if that changes.
- **Leaflet over MapLibre/OpenLayers.** Smallest dependency that does markers
  and drag well, and OSM raster tiles match how the format already refers to
  OSM.
- **Custom editor over CodeMirror.** A textarea with a highlight layer is
  ~250 lines, has no dependency, and gives exact control over the 80 column
  width. Revisit if the editor needs folding, multi-cursor or wrapping.
- **Map on the left, text on the right**, like geojson.io.
- **Formatter preserves comments and directives in place** rather than
  regenerating the file from the parsed model, which would throw them away.
  `humandot.write` (full regeneration) exists for programmatic use.
