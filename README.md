# dote

A single page editor for **humandot** files — think geojson.io, but for
humandot instead of GeoJSON.

A **dot** is a location: longitude, latitude, and a list of tags. A tag can be
anything — a label, a key/value pair, a URL, a line of free text. The model
and the file format come from
[clj-geo](https://github.com/vanjakom/clj-geo).

**Open it at <https://vanjakom.github.io/dote/>** — Options ▸ Open picks a `.dot`
off your disk and Options ▸ Save writes back to the same file. Nothing is uploaded and
nothing is stored in the browser.

The whole app is one `index.html`. No build step, no dependencies to install;
Leaflet and map tiles are the only things fetched from the network.

## The format

```
[humandot]

; tags used
;    #camp - a place to sleep

[tag:#trip2026]

20.4612, 44.8125
   Beograd
   #capital
   |population|1370000
   https://www.openstreetmap.org/relation/1677007

19.8335, 45.2671
   Novi Sad
   @visited
```

### Lines

| | |
| --- | --- |
| `[humandot]` | first line of every file |
| `[tag:#x]` | directive, appends `#x` to every dot in the file |
| `; text` | comment, ignored by readers |
| `20.4612, 44.8125` | starts a dot — **longitude comes first** |
| `   tag` | indented line, belongs to the dot above |
| *(blank line)* | closes the dot |

### Tags

| | |
| --- | --- |
| `#label` | public label |
| `@label` | personal label |
| `\|key\|value` | key and value pair |
| `https://…` | reference, OpenStreetMap links preferred |
| `---` | separates extracted tags from added ones |
| `===` | separates public tags from private ones |
| anything else | free text, the first one names the dot |

## Mouse

| | |
| --- | --- |
| long press the map | add a dot there, cursor waiting on its first tag |
| click a marker | select that dot in the text |
| drag a marker | rewrite its coordinate line |
| click a link | open it in a new tab |
| `⌥`/`Alt` click a link | place the caret in it instead |
| `Esc` | close an open menu |

Inside the text pane, `Enter` within a dot starts the next tag already
indented, `⇧Enter` gives a plain newline, and `Tab` inserts the tag indent.

There are no command shortcuts — everything else is in the Options menu.

**Options ▸ Copy dot** puts the dot at the cursor on the clipboard: its
coordinate line, its own tags, and the file's `[tag:…]` defaults appended
last. The defaults are included on purpose — they live in the file header, so
a dot pasted into a file that lacks those directives would otherwise arrive
without them.

Moving the cursor into a different dot centres the map on it without changing
the zoom. New dots are always added at the top of the file.

## Url parameters

| | |
| --- | --- |
| `?url=…` | fetch the document from there at start, instead of opening an empty one |
| `?writable=true` | Save posts the document back to that same url |
| `?repository=…` | base url of a repository of dots, adds the Repository menu |
| `?tileurl=…` | base url of an extra tile layer, drawn over OpenStreetMap |
| `?tilecatalog=…` | url of a TileJSON catalog, adds the Tile menu |
| `#map=zoom/lat/lon` | where to look |
| `#dotstore=namespace.id` | which dot of the repository to open |
| `#tile=namespace/layer` | which catalog tile layer is active |

`?tileurl=` names the base of an XYZ tile source and dote appends
`/{z}/{x}/{y}.png`:

```
?tileurl=http://localhost:6070/tile/trek-mate/ravni-map
   -> http://localhost:6070/tile/trek-mate/ravni-map/{z}/{x}/{y}.png
```

A value that already contains `{z}` is used as a complete template instead,
for a server that orders or names its parts differently. The layer is drawn
straight over OpenStreetMap with no layers control — passing the parameter is
the switch — and markers stay above both. While a tile layer is present the
map zooms to 22 rather than 19, with OSM upscaling past the zoom it has tiles
for instead of going blank.

Tiles load through `<img>`, which is not subject to CORS, so a tile server on
another port needs no headers for this to work.

`?tilecatalog=` points at a TileJSON 3.0.0 array and fills a **Tile** menu
from it, between Options and Repository, so layers can be switched while
editing:

```
?tilecatalog=http://localhost:7078/handmap/repository
```

The menu lists `None` first, then the layers grouped by namespace, with the
one showing marked. There is one overlay slot: `?tileurl=` fills it at startup
and the menu replaces what is in it.

The choice is kept in the hash as `#tile=`, so switching layers updates the
address bar and a reload comes back on the same one.

**`?tileurl=` takes precedence at load.** With both parameters you get the
`?tileurl=` layer, and a `#tile=` carried along in the link is dropped from
the url rather than left describing something that is not showing. Selecting
from the Tile menu then replaces that layer and writes `#tile=` as usual — so
copying the url and opening it afresh shows the `?tileurl=` layer again. The
precedence applies only at load; once the menu has been used, `#tile=` is the
truth.

While a `?tileurl=` layer is showing the Tile menu marks nothing as current —
not even `None` — because that layer has no entry in it. It names a layer from
the catalog — `#tile=trek-mate/ravni-map` — distinct from `?tileurl=`,
whose value is a tile url rather than a layer name. Query parameters
configure; hash parameters record where you are.

Each layer brings its own limits. `minzoom` keeps it undrawn below the zoom
it exists at, `maxzoom` makes it upscale past its deepest real tile rather
than vanish, and `bounds` stops Leaflet asking for tiles outside it. Picking
a layer that cannot be seen from where you are says so — `is not in view`, or
`starts at zoom 18` — rather than appearing to do nothing.

Hash parameters are `&` separated, the way openstreetmap.org and umap do it,
and either may appear without the other:

```
#map=12/44.81241/20.46118&dotstore=ravni.stablo
```

`#map=` is latitude first — the one place in the project where longitude does
not come first. It is the format openstreetmap.org, geojson.io and umap use,
so a view pastes straight between them.

`#dotstore=` needs `?repository=` to resolve, and spells the dot
`namespace.id` rather than the `namespace:id` used elsewhere. dote keeps it up
to date: open a different dot from the Repository menu and the address bar
follows, so the url is always worth copying or reloading. Pasting a changed
`dotstore` into the address bar opens that dot.

```
https://vanjakom.github.io/dote/?url=https://raw.githubusercontent.com/you/dots/main/camps.dot#map=12/44.81/20.46
```

### What the other end has to do

**Reading** — answer the `GET` with the file and an
`Access-Control-Allow-Origin` header. `raw.githubusercontent.com` already
does. A `github.com/…/blob/…` or `/raw/…` address is rewritten to its raw form
for you, because neither is fetchable as it stands: the blob page serves html
with no CORS header, and the `/raw/` redirect carries an *empty*
`Access-Control-Allow-Origin`, which matches no origin, so the browser refuses
to follow it.

**Writing** — accept a `POST` whose body is the whole file as `text/plain`,
and allow the origin on the response. Sending it as `text/plain` keeps it a
CORS simple request, so there is no preflight to answer.

Without `?writable=true` the document is read only and Save falls back to
writing a local copy.

## Repositories

A repository is a base url holding a listing and the dots themselves:

```
<base>repository.json           {"namespace": {"id": {"path": …, "type": "humandot"}}}
<base>data/<namespace>/<id>.dot  GET reads it, POST writes it
```

Dots are addressed as `namespace:id`, never by path, so only what the listing
names can be reached — that indirection is what makes the write route safe to
expose. Opening a dot from the Repository menu makes it writable: Save posts
it back to the same url.

Both names end in a file extension on purpose. They are file names rather than
route names, so a repository can equally well be a directory of files on a
static host.

## Saving

Dots opened from the **Repository** menu save themselves: two seconds after
you stop typing, and immediately when the text pane loses focus, the tab is
hidden, or the page closes. Everything else — a file opened with the picker,
or `?writable=` pointing at some other endpoint — saves only when you ask,
through Options ▸ Save.

The status bar says which state the document is in:

| | |
| --- | --- |
| *(blank)* | nothing to save |
| `unsaved` | edited, waiting for the pause |
| `saving` | a write is in the air |
| `saved 14:32` | written at that time |
| `2 errors, not saved` | held back, see below |
| `not saved: …` | the write failed, or the dot changed underneath |

**Autosave is held back while the document has parse errors.** A half-typed
coordinate like `20.` is an error, and without this a pause mid-edit would
write a broken file over a good one. It clears itself: the fix is a
keystroke, and that schedules the next attempt.

If the dot changed on the far end since you opened it — a second tab, or an
edit on disk — the save is refused rather than clobbering it, and autosave
stops until you reopen the dot from the menu. This needs the endpoint to send
an `ETag` on read and honour `If-Match` on write; one that doesn't simply
gets unconditional writes, as before.


Saving over the file you opened needs the File System Access API, which is
available only on a page served over https (or `localhost`) in a Chromium
browser. Where it is missing, Save degrades to a download and says so — the
Options menu reads "Save (downloads)".

Opening `index.html` straight from disk works for reading, drafting and the
map, but a `file://` page has an opaque origin, so it cannot save in place.
Use the deployed copy, or serve the directory:

```
python3 -m http.server
```

Nothing is persisted in the browser — no `localStorage`, no cookies. A reload
starts from an empty document, or from `?url=` if the link says so. Unsaved
changes are guarded by the usual "leave site?" prompt, and that is the only
safety net.
