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

Reader branch order is significant and is reproduced exactly in the humandot
section: comment → `[humandot]` → `[statement]` → blank → indented tag →
line containing a comma. Consequences worth remembering:

- An **indented** `;` or `[x]` is a *tag*, not a comment or a directive.
- Only the first two comma separated fields of a coordinate line are read.
- `[tag:x]` is the only directive with meaning today; other `[statement]`
  lines parse and are ignored.
- Default tags from `[tag:x]` are appended to every dot's tag list *at read
  time*. They are never written into individual dots.

## Setup

No build step, no package manager, no dependencies to install.

**Deployed at <https://vanjakom.github.io/dote/>** (GitHub Pages, from the
repository root on `main` — a push deploys). That is the way to run it: it is
https, so it is a secure context with a real origin, which is what the File
System Access API and `history.replaceState` both need. Everything works
there that does not work from disk.

The normal editing loop needs no server of your own: open the Pages url,
**File ▸ Open**, pick the `.dot`, edit, ⌘S writes back to that same file.

- Opening `index.html` from disk still works for reading, drafting and the
  map, but cannot save in place — see Gotchas. `python3 -m http.server` in
  the project directory is the local equivalent of the Pages deployment.
- Leaflet 1.9.4 and OpenStreetMap tiles load from the network. Everything
  else is local.
- Per global instructions the user runs and verifies the app; correctness is
  reasoned about by reading the code.

## Architecture

**The whole app is `index.html`.** One file, ~2300 lines, no build step, no
`css/` or `js/` directory. Inside it, in order:

```
<style>       all styling, one light theme
markup        menu bar, panes, status bar, help dialog
humandot      the file format: parse, classify, format, write. Pure, no DOM.
editor        the text pane: a plain textarea plus line arithmetic
dotmap        the map pane: a thin layer over Leaflet
app           wiring: menus, shortcuts, file IO, status bar, sync
```

Each of those four is an IIFE hanging off `window.DOTE`, exactly as when they
were separate files — the module boundaries survived the collapse, only the
file boundaries went. Keep it that way: no cross-section reaching into
another's internals.

**The text is the document.** The app section never mutates a parsed dot. Every
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

The editor section renders nothing. Its job is line arithmetic — turning
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

Without `?url=` the document starts as `[humandot]\n\n` and nothing else.
The url is used literally except for one
rewrite: `github.com/<owner>/<repo>/{blob,raw}/<rest>` becomes
`raw.githubusercontent.com/<owner>/<repo>/<rest>`. Those are the two
addresses you actually have in hand when browsing a repo, and neither is
fetchable as it stands:

- `/blob/…` serves html, with no CORS header at all.
- `/raw/…` is a `302` to the raw host carrying an **empty**
  `Access-Control-Allow-Origin`. An empty value matches no origin, so the
  browser rejects the redirect response and never follows it — even though
  the file at the end of it does allow the read. Measured 2026-09-19.

Neither pattern can be a POST target, so the rewrite cannot collide with a
writable endpoint.

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

That service is `~/projects/uberjvm`, namespaces `uberjvm.desktop.server`
and `uberjvm.desktop.fs`. Measured 2026-09-18 with `curl` sending the headers
a browser would:

| request | result |
| --- | --- |
| `GET` with `Origin:` | `200`, but **no `Access-Control-Allow-Origin`** |
| `OPTIONS` preflight | **`500`** — there is no OPTIONS route at all |

So dote cannot read from it, and can only report `Failed to fetch`: the
browser withholds the reason from JavaScript and shows it only in the
devtools console.

**Decided 2026-09-19: leave it that way. Do not add CORS or a write
endpoint to that server.** It was implemented (CORS middleware, a private
network preflight, `POST /fs/view/raw/*`) and then reverted on reading the
risk back, because `/fs/view/raw` serves *every file on the disk* and the
write endpoint would have written to it. Even done carefully the exposure is
uncomfortable:

- `Access-Control-Allow-Origin: *` would let any page open in the browser
  read the whole disk through loopback, so the origin has to be an allow
  list — one more thing that must stay correct forever.
- CORS does not stop a cross origin `POST` from landing; a `text/plain`
  body is a "simple request", so a hostile page could write and simply not
  read the reply. Blocking that needs an explicit `Origin` check on writes,
  separate from the CORS headers.
- `Origin: null` cannot be trusted, because a sandboxed iframe sends it too,
  so `file://` dote could never be allowed anyway.

**Use File ▸ Open instead.** From the Pages deployment it opens any `.dot`
anywhere with a picker and ⌘S writes back in place — same outcome, no server
listening, no allow list to maintain. `?url=` stays useful for read only
links against hosts that are already public, such as
raw.githubusercontent.com.

Two non-problems, so nobody re-investigates them: `http://localhost` is
exempt from mixed content blocking (it is potentially trustworthy) whether
the page is `file://` or https, and the server's `application/octet-stream`
content type is irrelevant to `fetch`/`response.text()` — it would only
matter if dote's own css and js were served through that endpoint, since
Chrome refuses a stylesheet with the wrong MIME type in standards mode.

Reaching that endpoint from the Pages deployment would additionally fall
under Chrome's Private Network Access rules (public origin → loopback),
which force a preflight the server would have to answer with
`Access-Control-Allow-Private-Network: true` — another reason the route was
dropped rather than supported.

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

- Plain ES5-style JavaScript in one inline `<script>`, everything hanging off
  a single `window.DOTE` namespace. `async`/`await` is used only in the file
  IO part of the app section, where promise chains would be worse.
- No ES modules — `import` fails under `file://` (CORS), and opening
  `index.html` straight from disk has to keep working. An inline script is
  never deferred either, which is why Leaflet is loaded *before* the code,
  without `defer`: an external script placed after an inline one runs too
  late.
- No framework, no bundler, no CSS preprocessor, no build step of any kind —
  `index.html` is edited directly, it is not generated from anything. Keep it
  that way unless the user asks otherwise.
- The humandot section stays pure: no DOM, no Leaflet, no globals besides its
  own export. It is the piece that could be lifted out and reused elsewhere.
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
  instead of pushing it. the humandot section deliberately diverges and closes
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
- Consequence for the user: **use the Pages deployment to edit files in
  place** (or `python3 -m http.server` locally; localhost counts as a secure
  context). Opening `index.html` from disk still works for reading, drafting
  and the map, it just cannot write back.
- **Nothing is persisted in the browser.** No `localStorage`, no IndexedDB,
  no cookies. A reload starts from `[humandot]\n\n`, or from `?url=` if the
  link says so. This is deliberate — a hidden second copy of a document that
  is really a file on disk (and in git) is a way to lose work, not to save
  it. The `beforeunload` guard is the only safety net, so keep it working.
  A `dote.session` entry in `localStorage` existed until 2026-09-19 and was
  removed; do not bring it back without being asked.
- A `FileSystemFileHandle` is not kept across reloads either — handles are
  structured-cloneable into IndexedDB and re-authorisable with
  `requestPermission`, but that is not implemented, so the first Save after a
  reload asks for a location again.
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
  more here. the humandot section is isolated enough to be swapped for a cljs
  implementation later if that changes.
- **One file, not a directory.** `css/` and `js/` were collapsed into
  `index.html` on 2026-09-19. The reason is deployment: a multi file page
  needs the server to get content types right, and Chrome refuses a
  stylesheet served as `application/octet-stream` in standards mode, which is
  what a plain file server hands back. One `.html` is the least a server has
  to get right, and it makes dote openable from anywhere it can be dropped.
  The cost is that the humandot section is no longer a file another page can
  load on its own. Collapsing was chosen over a concatenation step because a
  build step is exactly what this project does not have.
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
