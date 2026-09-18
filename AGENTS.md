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
css/dote.css        all styling, one light theme
js/humandot.js      format: parse, classify, format, write. Pure, no DOM.
js/editor.js        the text pane: a plain textarea plus line arithmetic
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
textarea input -> debounce 120ms -> humandot.parse
                                 -> DotMap.setDots
                                 -> status bar
```

`js/editor.js` renders nothing. Its job is line arithmetic — turning
character offsets into line indexes and back (`lineRange`, `lineAtOffset`,
`cursor`) — so the map can address dots by the lines they occupy, plus edit
operations that keep the native undo stack intact.

Selection is synced in both directions: the cursor line determines the
selected dot (`humandot.dotIndexAtLine`), and clicking a marker selects that
dot's lines in the textarea.

**New dots go on top.** `addDot` inserts above the first existing dot, never
at the end, so the newest is always the first thing in the file
(`newDotLine`). Comments written directly above that first dot belong to it
and are stepped over. An empty file is the one exception — with no dots to
go above, the block lands at the end, after the header.

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

### Loading and saving over http

```
?url=<url>        fetch the document from there at boot
?writable=true    Save posts the document back to that same url
```

`?url=` wins over the restored `localStorage` session — an explicit link
should never show stale local text. The url is used literally except for one
rewrite: a `github.com/<owner>/<repo>/blob/<rest>` address becomes
`raw.githubusercontent.com/<owner>/<repo>/<rest>`, because the blob address
is the one you have in hand when browsing a repo but it serves html and no
CORS header. That pattern can never be a POST target, so the rewrite cannot
collide with a writable endpoint.

The POST body is the whole file as `text/plain`, chosen so the request stays
a CORS *simple request* — no preflight for the endpoint to answer, it only
has to allow the origin on the response. `state.sourceUrl` holds the url a
document came from and is cleared by `setDocument`, so opening a local file
or starting a new one silently stops the POST behaviour.

Verified CORS positions (checked with `curl -I`):

| endpoint | `Access-Control-Allow-Origin` | use |
| --- | --- | --- |
| `raw.githubusercontent.com` | `*` | reading works |
| `github.com/.../blob/...` | absent, and serves html | rewritten to raw |
| `api.github.com` | `*` | would be needed to write to GitHub |

Writing back to GitHub itself is **not** implemented: it needs the contents
API, the file's blob SHA and an authenticated `PUT`, which means storing a
token. `?writable=true` is for your own endpoint, not for GitHub.

#### The local file server on port 7078

Vanja runs a Jetty service that serves any path on disk:

```
http://localhost:7078/fs/view/raw/Users/vanja/projects/dote/samples/belgrade.dot
```

so a dote link against it looks like

```
file:///Users/vanja/projects/dote/index.html?url=http://localhost:7078/fs/view/raw/<path>
```

As of 2026-09-18 that endpoint answers 200 with the file but sends **no
`Access-Control-Allow-Origin`**, so the fetch fails — a `file://` page has
origin `null` and the read is cross origin. Adding
`Access-Control-Allow-Origin: *` to that service is the whole fix; for
`?writable=true` it must also accept `POST` on the same path and set the
header on that response. No preflight is involved, the body goes as
`text/plain`.

Two non-problems, so nobody re-investigates them: `http://localhost` is
exempt from mixed content blocking even though Chrome treats `file://` as a
secure context, and the server's `application/octet-stream` content type is
irrelevant to `fetch`/`response.text()` — it would only matter if dote's own
css and js were served through that endpoint, since Chrome refuses a
stylesheet with the wrong MIME type in standards mode.

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
- **Text is plain.** One colour (black), one weight, no slant, no underline,
  no syntax highlighting, no line numbers. Nothing in the interface carries
  meaning through the look of a glyph; states use background tints instead.
  If something needs to stand out, reach for a tint or a rule, never for
  colour, weight or decoration. This applies to the chrome too — the menu,
  the status bar and the help sheet are all one weight.
- Because the text pane is undecorated there is **no highlight layer and no
  gutter**. Both existed and were deleted; do not reintroduce them without
  being asked. Diagnostics live in the status bar, which names the line of
  the first problem since the pane no longer can.
- Links are the only interactive text, and they look like everything else —
  a url is announced by the mouse pointer turning into a hand, never by
  colour or an underline.
- **Enter inside a dot opens the next tag already indented** with the
  canonical three spaces (`Editor._handleEnter`), so a dot is typed without
  touching the space bar. It always inserts `humandot.TAG_INDENT`, never a
  copy of the current line's whitespace, which is how a file written with
  tabs gets pulled back to the canonical indent as it is edited. It stays out
  of the way where indenting would corrupt the line: the caret part way along
  a coordinate line (the tail would become a tag) or inside a tag's leading
  whitespace (the tail would be indented twice). On a line holding nothing
  but the indent it clears the line instead, so the blank line that closes
  the dot is really blank. Shift+Enter is the plain newline.
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
- **The editor does not wrap** (`white-space: pre`); long lines scroll
  horizontally. This used to be forced by the highlight layer and gutter
  needing one visual row per logical line. Both are gone, so wrapping is now
  merely a choice — it would not break anything except `scrollLineIntoView`,
  which assumes `line * lineHeight`.
- **Clickable links are hit-tested by arithmetic, not by the DOM.** A
  textarea cannot contain an anchor, so `Editor.positionAt` divides the mouse
  offset by the line height and by one character's width (measured once with
  a canvas) to find the line and column under the pointer. This is only
  correct because the face is monospaced and nothing wraps — it is the second
  thing, after `scrollLineIntoView`, that a switch to wrapping would break.
  Tabs are accounted for (`characterAtColumn`); double width glyphs are not.
  A plain click opens the url and the caret is deliberately not moved
  (`preventDefault` on mousedown); any modifier makes it an ordinary click so
  a url can still be edited.
- The 80 column width is `calc(80 * 1ch + padding)` on `#text` itself, and
  `ch` is measured from the element's own font — so the monospace font
  declaration has to stay on `#text`, not on an ancestor.
- Programmatic edits go through `Editor.replaceRange`, which uses
  `document.execCommand('insertText')`. It is deprecated but it is the only
  way to edit a textarea while keeping the browser's native undo stack. There
  is a direct-assignment fallback that dispatches a synthetic `input` event.
- `marker._icon` is touched directly in `dotmap.js` to toggle the selected
  class. Private Leaflet API, stable in practice, but it is why markers must
  be added to the map before selection is painted.
- **Saving in place needs the page to be served.** It uses the File System
  Access API, and the pickers are gated on a secure context with a real
  origin. A `file://` page has an opaque origin (`null`), so Chrome does not
  expose `showSaveFilePicker` there at all and Save degrades to a download —
  the same root cause as the `replaceState` failure above. Firefox and Safari
  do not implement the pickers anywhere. `canSaveInPlace` records which case
  applies; when it is false the File menu items are relabelled
  "Save (downloads)" at boot and the flash says why, because a silent
  fallback just drops surprise copies in the downloads folder.
- Consequence for the user: **open dote over http to edit files in place**
  (`python3 -m http.server` in the project directory; localhost counts as a
  secure context). Opening `index.html` from disk still works for reading,
  drafting and the map, it just cannot write back.
- A `FileSystemFileHandle` is not kept across reloads. It could be — handles
  are structured-cloneable into IndexedDB and re-authorised with
  `requestPermission` — but that is not implemented; after a reload the
  session text comes back from `localStorage` while the handle does not, so
  the first Save asks for a location again.
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
- **A bare textarea over CodeMirror.** The text pane started as a textarea
  with a highlight layer and a line number gutter; both were removed on
  request in favour of plain text. What is left is a textarea plus line
  arithmetic — no dependency, exact control over the 80 column width.
- **Map on the left, text on the right**, like geojson.io.
- **Formatter preserves comments and directives in place** rather than
  regenerating the file from the parsed model, which would throw them away.
  `humandot.write` (full regeneration) exists for programmatic use.
