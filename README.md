# dote

A single page editor for **humandot** files — think geojson.io, but for
humandot instead of GeoJSON.

A **dot** is a location: longitude, latitude, and a list of tags. A tag can be
anything — a label, a key/value pair, a URL, a line of free text. The model
and the file format come from
[clj-geo](https://github.com/vanjakom/clj-geo).

**Open it at <https://vanjakom.github.io/dote/>** — Options ▸ Open picks a `.dot`
off your disk and ⌘S writes back to the same file. Nothing is uploaded and
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

## Keyboard and mouse

`⌘` on macOS, `Ctrl` elsewhere.

| | |
| --- | --- |
| `⌘O` | open a file |
| `⌘S` | save |
| `⌘⇧F` | format the document (no menu item, shortcut only) |
| `⌘G` | zoom the map to the dot at the cursor (no menu item, shortcut only) |
| `Enter` | in a dot, start the next tag already indented |
| `⇧Enter` | a plain newline, no indent |
| `Tab` | insert the tag indent |
| `Esc` | close a menu |
| click a link | open it in a new tab |
| `⌥`/`Alt` click a link | place the caret in it instead |
| long press the map | add a dot there, cursor waiting on its first tag |
| click a marker | select that dot in the text |
| drag a marker | rewrite its coordinate line |

Moving the cursor into a different dot centres the map on it without changing
the zoom. New dots are always added at the top of the file.

## Url parameters

| | |
| --- | --- |
| `?url=…` | fetch the document from there at start, instead of opening an empty one |
| `?writable=true` | Save posts the document back to that same url |
| `?repository=…` | base url of a repository of dots, adds the Repository menu |
| `#map=zoom/lat/lon` | where to look |

The `#map=` hash is latitude first — the one place in the project where
longitude does not come first. It is the format openstreetmap.org, geojson.io
and umap use, so a view pastes straight between them.

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
