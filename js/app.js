/*
 * app.js - wiring. The text is the document; everything else is a view of it.
 *
 * Every interaction that changes data - dragging a marker, adding a dot,
 * formatting - is turned into an edit of the textarea, which re-parses and
 * re-renders the map. Nothing mutates a parsed dot in place.
 */
(function (global) {
  'use strict';

  var humandot = global.DOTE.humandot;

  var TEMPLATE = [
    '[humandot]',
    '',
    '; tags used',
    ';    #tag1 - generic tag',
    ''
  ].join('\n');

  var STORAGE_KEY = 'dote.session';
  var PARSE_DELAY = 120;
  var STORE_DELAY = 600;
  var HASH_DELAY = 300;
  var NEW_DOT_PRECISION = 6;
  var HASH_PRECISION = 5;

  var isApple = /Mac|iPhone|iPad/.test(global.navigator.platform || '');

  var state = {
    parsed: { dots: [], problems: [], defaultTags: [] },
    fileName: 'untitled.dot',
    fileHandle: null,
    savedText: '',
    selected: -1,
    suppressPan: false,
    sourceUrl: null,   // set when the document came from ?url=
    writable: false    // ?writable=true, the source url takes it back on POST
  };

  var editor;
  var dotMap;
  var elements = {};
  var timers = {};
  var messageTimer = null;

  /* ---------------------------------------------------------------- utils */

  function byId(id) { return document.getElementById(id); }

  function debounce(name, delay, fn) {
    global.clearTimeout(timers[name]);
    timers[name] = global.setTimeout(fn, delay);
  }

  function round(value, decimals) {
    var factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  function coordinateText(longitude, latitude) {
    return humandot.formatNumber(round(longitude, NEW_DOT_PRECISION)) + ', ' +
      humandot.formatNumber(round(latitude, NEW_DOT_PRECISION));
  }

  function flash(message) {
    elements.message.textContent = message || '';
    global.clearTimeout(messageTimer);
    if (message) {
      messageTimer = global.setTimeout(function () {
        elements.message.textContent = '';
      }, 4000);
    }
  }

  /* -------------------------------------------------------------- document */

  // keepView leaves the map where it is, used when the url hash already says
  // where to look
  function setDocument(text, fileName, fileHandle, keepView) {
    state.fileName = fileName || 'untitled.dot';
    state.fileHandle = fileHandle || null;
    state.savedText = text;
    state.selected = -1;
    state.sourceUrl = null;   // whatever loads from a url sets this afterwards
    withoutPan(function () {
      editor.setValue(text);
      reparse();
    });
    if (!keepView && !dotMap.fitToDots()) flash('no dots yet - use Edit > Add dot');
    updateStatus();
  }

  function isModified() {
    return editor.getValue() !== state.savedText;
  }

  function markSaved() {
    state.savedText = editor.getValue();
    updateStatus();
  }

  function reparse() {
    state.parsed = humandot.parse(editor.getValue());
    dotMap.setDots(state.parsed.dots);
    syncSelectionFromCursor();
    updateStatus();
  }

  /* ------------------------------------------------------------- selection */

  /*
   * Moving the text cursor into a different dot centers the map on it, at the
   * current zoom. Edits that come from the map itself run inside withoutPan so
   * that clicking or dragging a marker does not yank the view out from under
   * the pointer.
   */
  function syncSelectionFromCursor() {
    var cursor = editor.cursor();
    var index = humandot.dotIndexAtLine(state.parsed.dots, cursor.line);
    var moved = index !== state.selected;

    state.selected = index;
    dotMap.setSelected(index);
    if (moved && index >= 0 && !state.suppressPan) dotMap.panToDot(index);
    updateStatus(cursor);
  }

  function withoutPan(change) {
    state.suppressPan = true;
    try {
      change();
    } finally {
      state.suppressPan = false;
    }
  }

  function selectDot(index) {
    var dot = state.parsed.dots[index];
    if (!dot) return;
    withoutPan(function () {
      editor.selectLines(dot.line, dot.endLine);
      editor.textarea.focus();
    });
  }

  function dotAtCursor() {
    var index = humandot.dotIndexAtLine(state.parsed.dots, editor.cursor().line);
    return index < 0 ? null : state.parsed.dots[index];
  }

  /* ----------------------------------------------------------- dot editing */

  /*
   * Where a new dot goes: immediately above the first existing one, so the
   * newest is always at the top of the file. Comments written directly above
   * that first dot belong to it and are stepped over. Returns -1 when the
   * file holds no dots yet and the block should simply go at the end, after
   * the header.
   */
  function newDotLine() {
    var lines = humandot.splitLines(editor.getValue());
    var first = -1;
    for (var i = 0; i < lines.length && first < 0; i++) {
      if (humandot.classifyLine(lines[i]) === humandot.LINE.COORDINATE) first = i;
    }
    if (first < 0) return -1;
    while (first > 0 && humandot.classifyLine(lines[first - 1]) === humandot.LINE.COMMENT) {
      first -= 1;
    }
    return first;
  }

  function addDot(longitude, latitude) {
    var block = coordinateText(longitude, latitude) + '\n' + humandot.TAG_INDENT;
    var line = newDotLine();

    withoutPan(function () {
      if (line < 0) {
        editor.appendBlock(block);
      } else {
        var start = editor.lineRange(line).start;
        // the blank line after the indent keeps this dot separate from the
        // one that used to be first
        editor.replaceRange(start, start, block + '\n\n');
        editor.moveCursorTo(line + 1, humandot.TAG_INDENT.length);
      }
      reparse();
    });

    dotMap.revealDot(0);
    flash('dot added - type a name');
  }

  function moveDot(index, longitude, latitude) {
    var dot = state.parsed.dots[index];
    if (!dot) return;
    withoutPan(function () {
      editor.replaceLine(dot.line, coordinateText(longitude, latitude));
      reparse();
    });
    flash('moved to ' + coordinateText(longitude, latitude));
  }

  function deleteDotAtCursor() {
    var dot = dotAtCursor();
    if (!dot) {
      flash('put the cursor inside a dot first');
      return;
    }
    var lines = humandot.splitLines(editor.getValue());
    var last = dot.endLine;
    if (last + 1 < lines.length && lines[last + 1].trim() === '') last += 1;
    editor.removeLines(dot.line, last);
    reparse();
    flash('dot deleted');
  }

  function formatDocument() {
    // the whole document is replaced, so the cursor passes through the end of
    // the text on the way back - not a reason to move the map
    withoutPan(function () {
      var cursor = editor.cursor();
      editor.replaceRange(0, editor.getValue().length, humandot.format(editor.getValue()));
      reparse();
      editor.moveCursorTo(Math.min(cursor.line, editor.lineCount() - 1), 0);
    });
    flash('document formatted');
  }

  /* ----------------------------------------------------------- parameters */

  /*
   *   ?url=<url>          fetch the document from there on start
   *   ?writable=true      Save posts the document back to that same url
   *
   * The url is taken literally, with one rewrite: a github.com blob address
   * is the one you have in hand when browsing a repository, but it serves
   * html and sends no CORS header, so it is turned into its raw form. That
   * pattern can never be a POST target, so the rewrite cannot collide with a
   * writable endpoint.
   */
  var GITHUB_BLOB = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/;

  function fetchableUrl(url) {
    var match = GITHUB_BLOB.exec(url);
    return match
      ? 'https://raw.githubusercontent.com/' + match[1] + '/' + match[2] + '/' + match[3]
      : url;
  }

  function fileNameFor(url) {
    try {
      var path = new URL(url, global.location.href).pathname;
      return path.substring(path.lastIndexOf('/') + 1) || 'untitled.dot';
    } catch (error) {
      return 'untitled.dot';
    }
  }

  function readParameters() {
    var parameters = new URLSearchParams(global.location.search);
    var url = parameters.get('url');
    var writable = parameters.get('writable');
    return {
      url: url ? fetchableUrl(url.trim()) : null,
      writable: writable === 'true' || writable === '1'
    };
  }

  async function loadFromUrl(url, keepView) {
    flash('loading ' + url);
    try {
      var response = await fetch(url, { headers: { Accept: 'text/plain' } });
      if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
      var text = await response.text();
      setDocument(text, fileNameFor(url), null, keepView);
      state.sourceUrl = url;   // setDocument cleared it, this is where it came from
      updateStatus();
      flash('loaded ' + url);
    } catch (error) {
      // a failure here is almost always the endpoint not allowing the origin
      flash('could not load ' + url + ': ' + error.message);
    }
  }

  /* ---------------------------------------------------------------- files */

  var FILE_TYPES = [{
    description: 'humandot file',
    accept: { 'text/plain': ['.dot'] }
  }];

  /*
   * Saving over the file you opened needs the File System Access API. It is
   * missing in two situations and the difference matters to whoever is
   * looking at the status bar:
   *
   *   - the page was opened from disk. A file:// page has an opaque origin
   *     ("null"), and the pickers are gated on a secure context with a real
   *     one, so Chrome does not expose them. Serving the directory fixes it,
   *     localhost counts as secure.
   *   - the browser has not implemented them (Firefox, Safari). Nothing to
   *     be done there, every save is a download.
   *
   * Either way Save degrades to a download, which is fine as long as it says
   * so instead of quietly dropping a second copy in ~/Downloads.
   */
  var canSaveInPlace = typeof global.showSaveFilePicker === 'function';
  var servedFromDisk = global.location.protocol === 'file:';

  function noPickerReason() {
    return servedFromDisk
      ? 'saving in place needs the page served, not opened from disk'
      : 'this browser cannot save in place';
  }

  async function openFile() {
    if (global.showOpenFilePicker) {
      try {
        var handles = await global.showOpenFilePicker({ types: FILE_TYPES });
        var handle = handles[0];
        var file = await handle.getFile();
        setDocument(await file.text(), file.name, handle);
        flash('opened ' + file.name);
      } catch (error) {
        if (error && error.name !== 'AbortError') flash('could not open: ' + error.message);
      }
      return;
    }
    elements.fileInput.click();
  }

  /*
   * writable=true is a promise by whoever wrote the link that the url which
   * served the document also takes it back. The body goes as text/plain,
   * which keeps this a CORS simple request - there is no preflight for the
   * endpoint to answer, it only has to allow the origin on the response.
   */
  async function postToSource() {
    try {
      var response = await fetch(state.sourceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: editor.getValue()
      });
      if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
      markSaved();
      flash('saved to ' + state.sourceUrl);
    } catch (error) {
      flash('could not save to ' + state.sourceUrl + ': ' + error.message);
    }
  }

  async function saveFile() {
    if (state.writable && state.sourceUrl) {
      await postToSource();
      return;
    }
    if (!state.fileHandle) {
      await saveFileAs();
      return;
    }
    try {
      var writable = await state.fileHandle.createWritable();
      await writable.write(editor.getValue());
      await writable.close();
      markSaved();
      flash('saved ' + state.fileName);
    } catch (error) {
      flash('could not save: ' + error.message);
    }
  }

  async function saveFileAs() {
    if (canSaveInPlace) {
      try {
        var handle = await global.showSaveFilePicker({
          suggestedName: state.fileName,
          types: FILE_TYPES
        });
        state.fileHandle = handle;
        state.fileName = handle.name;
        await saveFile();
      } catch (error) {
        if (error && error.name !== 'AbortError') flash('could not save: ' + error.message);
      }
      return;
    }
    downloadFile();
  }

  function downloadFile() {
    var blob = new Blob([editor.getValue()], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = state.fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    global.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    markSaved();
    flash(canSaveInPlace
      ? 'downloaded ' + state.fileName
      : 'downloaded ' + state.fileName + ' - ' + noPickerReason());
  }

  /* -------------------------------------------------------------- session */

  function storeSession() {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        text: editor.getValue(),
        fileName: state.fileName
      }));
    } catch (error) {
      /* private mode or a full quota, the file on disk is what matters */
    }
  }

  function restoreSession() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var session = JSON.parse(raw);
      return session && typeof session.text === 'string' ? session : null;
    } catch (error) {
      return null;
    }
  }

  /* ------------------------------------------------------------ url hash */

  /*
   * The map view lives in the location hash as #map=zoom/latitude/longitude.
   *
   * That is latitude first, the one place in this project where longitude does
   * not come first - it is the hash format openstreetmap.org, geojson.io and
   * umap all use, so a view can be pasted straight from one to the other. The
   * rest of the app stays longitude first.
   */
  var HASH_PATTERN = /^#map=(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/;
  var hashIsOurs = false;      // the hash change we are about to hear is our own
  var canReplaceState = true;  // file:// forbids replaceState in some browsers

  function readHash() {
    var match = HASH_PATTERN.exec(global.location.hash);
    if (!match) return null;
    var view = {
      zoom: Number(match[1]),
      latitude: Number(match[2]),
      longitude: Number(match[3])
    };
    if (view.zoom < 0 || view.zoom > 22) return null;
    if (Math.abs(view.latitude) > 90 || Math.abs(view.longitude) > 180) return null;
    return view;
  }

  function hashFor(view) {
    return '#map=' + round(view.zoom, 2) + '/' +
      round(view.latitude, HASH_PRECISION).toFixed(HASH_PRECISION) + '/' +
      round(view.longitude, HASH_PRECISION).toFixed(HASH_PRECISION);
  }

  function writeHash() {
    var hash = hashFor(dotMap.center());
    if (hash === global.location.hash) return;
    if (canReplaceState) {
      try {
        // replaceState does not fire hashchange, so nothing to guard against
        global.history.replaceState(null, '',
          global.location.pathname + global.location.search + hash);
        return;
      } catch (error) {
        // opened from disk: fall back to assigning the hash, which costs a
        // history entry but is all the browser allows there
        canReplaceState = false;
      }
    }
    hashIsOurs = true;
    global.location.hash = hash;
  }

  function applyHash() {
    if (hashIsOurs) {
      hashIsOurs = false;
      return;
    }
    var view = readHash();
    if (view) dotMap.setView(view);
  }

  /* ----------------------------------------------------------- status bar */

  function updateStatus(cursor) {
    cursor = cursor || editor.cursor();

    elements.file.textContent = state.fileName;
    elements.file.classList.toggle('is-modified', isModified());
    elements.file.title = state.sourceUrl
      ? state.sourceUrl + (state.writable ? ' (Save posts back here)' : ' (read only)')
      : state.fileName;

    var dots = state.parsed.dots;
    var defaults = state.parsed.defaultTags.length;
    elements.dots.textContent = dots.length + (dots.length === 1 ? ' dot' : ' dots') +
      (defaults ? ' (+' + defaults + ' default tag' + (defaults === 1 ? '' : 's') + ')' : '');

    // without line numbers in the pane, the status bar is where a problem gets
    // located - report the count and spell out the first one of that severity
    var all = state.parsed.problems;
    var errors = all.filter(function (p) { return p.severity === 'error'; });
    var worst = errors.length ? errors : all;
    var noun = errors.length ? 'error' : 'warning';
    elements.problems.textContent = worst.length
      ? worst.length + ' ' + noun + (worst.length === 1 ? '' : 's') +
        ', line ' + (worst[0].line + 1) + ': ' + worst[0].message
      : '';

    elements.cursor.textContent = 'Ln ' + (cursor.line + 1) + ', Col ' + (cursor.column + 1);

    if (state.selected >= 0) {
      var dot = dots[state.selected];
      var label = humandot.label(dot);
      elements.dot.textContent = 'dot ' + (state.selected + 1) + '/' + dots.length +
        (label ? ' - ' + label : '');
    } else {
      elements.dot.textContent = '';
    }
  }

  function showCoordinate(pointer) {
    var view = pointer || dotMap.center();
    elements.coordinate.textContent = coordinateText(view.longitude, view.latitude) +
      (pointer ? '' : '  z' + dotMap.center().zoom);
  }

  /* ----------------------------------------------------------------- menu */

  function closeMenus() {
    document.querySelectorAll('.menu.is-open').forEach(function (menu) {
      menu.classList.remove('is-open');
    });
  }

  function setUpMenus() {
    var menus = Array.prototype.slice.call(document.querySelectorAll('[data-menu]'));

    menus.forEach(function (menu) {
      var title = menu.querySelector('.menu__title');
      title.addEventListener('click', function (event) {
        event.stopPropagation();
        var open = menu.classList.contains('is-open');
        closeMenus();
        if (!open) menu.classList.add('is-open');
      });
      // once a menu is open, hovering the neighbours switches between them
      title.addEventListener('mouseenter', function () {
        if (document.querySelector('.menu.is-open')) {
          closeMenus();
          menu.classList.add('is-open');
        }
      });
    });

    document.addEventListener('click', function (event) {
      var button = event.target.closest('[data-action]');
      if (button) {
        closeMenus();
        runAction(button.getAttribute('data-action'));
        return;
      }
      if (!event.target.closest('[data-menu]')) closeMenus();
    });

    // render shortcut hints for this platform
    document.querySelectorAll('[data-shortcut]').forEach(function (hint) {
      var key = hint.getAttribute('data-shortcut');
      hint.textContent = isApple ? '⌘' + key : 'Ctrl+' + key;
    });
  }

  /* -------------------------------------------------------------- actions */

  function runAction(action) {
    switch (action) {
      case 'file-new':
        if (isModified() && !global.confirm('Discard unsaved changes?')) return;
        setDocument(TEMPLATE, 'untitled.dot', null);
        break;
      case 'file-open': openFile(); break;
      case 'file-save': saveFile(); break;
      case 'file-save-as': saveFileAs(); break;

      case 'edit-format': formatDocument(); break;
      case 'edit-add-here':
        var center = dotMap.center();
        addDot(center.longitude, center.latitude);
        break;
      case 'edit-add-click':
        dotMap.setArmed(true);
        flash('click the map to place a dot, Esc cancels');
        break;
      case 'edit-delete': deleteDotAtCursor(); break;

      case 'view-fit':
        if (!dotMap.fitToDots()) flash('no dots with valid coordinates');
        break;
      case 'view-zoom':
        if (state.selected < 0) flash('put the cursor inside a dot first');
        else dotMap.panToDot(state.selected, 15);
        break;
      case 'view-toggle-editor': toggleEditorPane(); break;

      case 'help-format': showSheet('The humandot format', FORMAT_HELP); break;
      case 'help-keys': showSheet('Keyboard shortcuts', keyboardHelp()); break;
      case 'help-url': showSheet('Opening from a url', URL_HELP); break;

      case 'sheet-close': elements.sheet.close(); break;
    }
  }

  function toggleEditorPane() {
    var hidden = elements.editorPane.classList.toggle('is-hidden');
    var toggle = document.querySelector('[data-action="view-toggle-editor"]');
    if (toggle) toggle.textContent = hidden ? 'Show the text pane' : 'Hide the text pane';
    dotMap.invalidateSize();
  }

  /* ----------------------------------------------------------------- help */

  var FORMAT_HELP = [
    '<h3>Shape of a file</h3>',
    '<pre>[humandot]\n',
    '; tags used\n;    #camp - a place to sleep\n\n',
    '[tag:#trip2026]\n\n',
    '20.4612, 44.8125\n   Beograd\n   #capital\n   |population|1370000\n',
    '   https://www.openstreetmap.org/relation/1677007\n\n',
    '19.8335, 45.2671\n   Novi Sad\n   @visited\n</pre>',
    '<h3>Lines</h3>',
    '<table>',
    '<tr><td>[humandot]</td><td>first line of every file</td></tr>',
    '<tr><td>[tag:#x]</td><td>directive, appends #x to every dot in the file</td></tr>',
    '<tr><td>; text</td><td>comment, ignored by readers</td></tr>',
    '<tr><td>longitude, latitude</td><td>starts a dot - longitude comes first</td></tr>',
    '<tr><td>&nbsp;&nbsp;&nbsp;tag</td><td>indented line, belongs to the dot above</td></tr>',
    '<tr><td>(blank line)</td><td>closes the dot</td></tr>',
    '</table>',
    '<h3>Tags</h3>',
    '<table>',
    '<tr><td>#label</td><td>public label</td></tr>',
    '<tr><td>@label</td><td>personal label</td></tr>',
    '<tr><td>|key|value</td><td>key and value pair</td></tr>',
    '<tr><td>https://&hellip;</td><td>reference, OpenStreetMap links preferred</td></tr>',
    '<tr><td>---</td><td>separates extracted tags from added ones</td></tr>',
    '<tr><td>===</td><td>separates public tags from private ones</td></tr>',
    '<tr><td>anything else</td><td>free text, the first one names the dot</td></tr>',
    '</table>'
  ].join('');

  var URL_HELP = [
    '<h3>Parameters</h3>',
    '<table>',
    '<tr><td>?url=&hellip;</td><td>fetch the document from there when dote starts, ',
    'instead of restoring the last session</td></tr>',
    '<tr><td>?writable=true</td><td>Save posts the document back to that same url</td></tr>',
    '</table>',
    '<h3>Example</h3>',
    '<pre>index.html?url=https://raw.githubusercontent.com/you/dots/master/camps.dot</pre>',
    '<h3>What the other end has to do</h3>',
    '<table>',
    '<tr><td>reading</td><td>answer the GET with the file and an ',
    '<code>Access-Control-Allow-Origin</code> header. raw.githubusercontent.com ',
    'already does; a github.com &hellip;/blob/&hellip; address is rewritten to its raw ',
    'form for you</td></tr>',
    '<tr><td>writing</td><td>accept a POST whose body is the whole file as ',
    '<code>text/plain</code>, and allow the origin on the response. Sending it as ',
    'text/plain keeps it a simple request, so there is no preflight to answer</td></tr>',
    '</table>',
    '<h3>Notes</h3>',
    '<table>',
    '<tr><td>the map view</td><td>the <code>#map=</code> hash still applies, so one link ',
    'can carry both the file and where to look</td></tr>',
    '<tr><td>without writable</td><td>the document is read only; Save falls back to ',
    'writing a local copy</td></tr>',
    '</table>'
  ].join('');

  function keyboardHelp() {
    var modifier = isApple ? '⌘' : 'Ctrl+';
    var rows = [
      [modifier + 'O', 'open a file'],
      [modifier + 'S', 'save'],
      [modifier + '⇧F', 'format the document'],
      [modifier + 'G', 'zoom the map to the dot at the cursor'],
      ['Enter', 'in a dot, start the next tag already indented'],
      ['⇧Enter', 'a plain newline, no indent'],
      ['Tab', 'insert the tag indent'],
      ['click a link', 'open it in a new tab'],
      [(isApple ? '⌥' : 'Alt') + ' click a link', 'place the caret in it instead'],
      ['Esc', 'close a menu, cancel adding a dot'],
      ['click a marker', 'select that dot in the text'],
      ['drag a marker', 'rewrite its coordinate line']
    ];
    return '<table>' + rows.map(function (row) {
      return '<tr><td>' + row[0] + '</td><td>' + row[1] + '</td></tr>';
    }).join('') + '</table>';
  }

  function showSheet(title, html) {
    elements.sheetTitle.textContent = title;
    elements.sheetBody.innerHTML = html;
    elements.sheet.showModal();
  }

  /* ------------------------------------------------------------ shortcuts */

  function setUpShortcuts() {
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closeMenus();
        dotMap.setArmed(false);
        return;
      }
      var modifier = isApple ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey) return;

      var key = event.key.toLowerCase();
      if (key === 's') { event.preventDefault(); saveFile(); }
      else if (key === 'o') { event.preventDefault(); openFile(); }
      else if (key === 'g') { event.preventDefault(); runAction('view-zoom'); }
      else if (key === 'f' && event.shiftKey) { event.preventDefault(); formatDocument(); }
    });

    global.addEventListener('beforeunload', function (event) {
      if (!isModified()) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    elements = {
      file: byId('status-file'),
      dots: byId('status-dots'),
      problems: byId('status-problems'),
      message: byId('status-message'),
      dot: byId('status-dot'),
      cursor: byId('status-cursor'),
      coordinate: byId('status-coordinate'),
      editorPane: byId('editor-pane'),
      fileInput: byId('file-input'),
      sheet: byId('sheet'),
      sheetTitle: byId('sheet-title'),
      sheetBody: byId('sheet-body')
    };

    editor = new global.DOTE.Editor({ textarea: byId('text') });

    dotMap = new global.DOTE.DotMap(byId('map'));

    editor.onChange = function () {
      debounce('parse', PARSE_DELAY, reparse);
      debounce('store', STORE_DELAY, storeSession);
      updateStatus();
    };

    editor.onCursor = function () {
      syncSelectionFromCursor();
    };

    // the pattern only ever matches http and https, so there is no scheme to
    // vet before handing the url to the browser
    editor.onLink = function (url) {
      global.open(url, '_blank', 'noopener,noreferrer');
      flash('opened ' + url);
    };

    dotMap.onSelect = function (index) { selectDot(index); };
    dotMap.onMove = function (index, longitude, latitude) { moveDot(index, longitude, latitude); };
    dotMap.onAdd = function (longitude, latitude) { addDot(longitude, latitude); };
    dotMap.onPointer = function (pointer) { showCoordinate(pointer); };
    dotMap.onView = function () {
      showCoordinate(null);
      debounce('hash', HASH_DELAY, writeHash);
    };

    global.addEventListener('hashchange', applyHash);

    elements.fileInput.addEventListener('change', function () {
      var file = elements.fileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        setDocument(String(reader.result), file.name, null);
        flash('opened ' + file.name);
      };
      reader.readAsText(file);
      elements.fileInput.value = '';
    });

    elements.coordinate.addEventListener('click', function () {
      var text = elements.coordinate.textContent.split('  ')[0];
      if (!text || !global.navigator.clipboard) return;
      global.navigator.clipboard.writeText(text).then(function () {
        flash('copied ' + text);
      });
    });

    // dropping a .dot file anywhere opens it
    document.addEventListener('dragover', function (event) { event.preventDefault(); });
    document.addEventListener('drop', function (event) {
      event.preventDefault();
      var file = event.dataTransfer && event.dataTransfer.files[0];
      if (!file) return;
      file.text().then(function (text) {
        setDocument(text, file.name, null);
        flash('opened ' + file.name);
      });
    });

    setUpMenus();
    setUpShortcuts();

    var parameters = readParameters();
    state.writable = parameters.writable;

    // say up front that Save cannot write back, rather than letting it look
    // like it worked and leaving a copy in the downloads folder
    if (!canSaveInPlace && !state.writable) {
      document.querySelectorAll('[data-action="file-save"], [data-action="file-save-as"]')
        .forEach(function (button) {
          button.firstChild.nodeValue = button.firstChild.nodeValue.trim() + ' (downloads)';
        });
    }

    // a view in the url wins over fitting the map to the dots
    var view = readHash();

    if (parameters.url) {
      // an explicit url wins over whatever localStorage was holding
      setDocument('', fileNameFor(parameters.url), null, true);
      loadFromUrl(parameters.url, !!view);
    } else {
      var session = restoreSession();
      if (session) {
        setDocument(session.text, session.fileName, null, !!view);
        flash('restored your last session');
      } else {
        setDocument(TEMPLATE, 'untitled.dot', null, !!view);
      }
    }

    if (view) dotMap.setView(view);
    else writeHash();
    showCoordinate(null);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(this);
