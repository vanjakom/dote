/*
 * editor.js - the text pane: a textarea with a syntax highlight layer behind
 * it and a line number gutter beside it.
 *
 * The textarea keeps its own text transparent and its caret visible; the <pre>
 * underneath paints the same text with colour. Both use the same font metrics
 * and `white-space: pre`, so they stay aligned as long as nothing wraps. That
 * is why the editor never wraps and scrolls horizontally instead - a wrapped
 * line would take two rows in the textarea but one number in the gutter.
 */
(function (global) {
  'use strict';

  var humandot = global.DOTE.humandot;
  var LINE = humandot.LINE;
  var TAG = humandot.TAG;

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function span(className, text) {
    return '<span class="' + className + '">' + escapeHtml(text) + '</span>';
  }

  /* ------------------------------------------------------------ highlight */

  function highlightCoordinate(line) {
    var comma = line.indexOf(',');
    var longitude = line.substring(0, comma);
    var rest = line.substring(comma + 1);
    var secondComma = rest.indexOf(',');
    var latitude = secondComma < 0 ? rest : rest.substring(0, secondComma);
    var trailing = secondComma < 0 ? '' : rest.substring(secondComma);

    var coordinate = humandot.parseCoordinate(line);
    var longitudeClass = coordinate.longitude == null ? 't-error' : 't-number';
    var latitudeClass = coordinate.latitude == null ? 't-error' : 't-number';

    return span(longitudeClass, longitude) +
      span('t-punctuation', ',') +
      span(latitudeClass, latitude) +
      (trailing ? span('t-error', trailing) : '');
  }

  function highlightTag(line) {
    var indent = line.match(/^[ \t]*/)[0];
    var tag = line.substring(indent.length).replace(/\s+$/, '');
    var trailing = line.substring(indent.length + tag.length);
    var body;

    switch (humandot.classifyTag(tag)) {
      case TAG.SEPARATOR:
        body = span('t-separator', tag);
        break;
      case TAG.PUBLIC:
        body = span('t-public', tag);
        break;
      case TAG.PERSONAL:
        body = span('t-personal', tag);
        break;
      case TAG.LINK:
        body = span('t-link', tag);
        break;
      case TAG.PAIR:
        var pair = humandot.parsePair(tag);
        body = pair
          ? span('t-punctuation', '|') + span('t-key', pair.key) +
            span('t-punctuation', '|') + span('t-value', pair.value)
          : span('t-error', tag);
        break;
      default:
        body = span('t-note', tag);
        break;
    }
    return escapeHtml(indent) + body + escapeHtml(trailing);
  }

  function highlightLine(line) {
    switch (humandot.classifyLine(line)) {
      case LINE.COMMENT: return span('t-comment', line);
      case LINE.MAGIC: return span('t-magic', line);
      case LINE.STATEMENT: return span('t-directive', line);
      case LINE.BLANK: return escapeHtml(line);
      case LINE.TAG: return highlightTag(line);
      case LINE.COORDINATE: return highlightCoordinate(line);
      default: return span('t-unknown', line);
    }
  }

  /* --------------------------------------------------------------- editor */

  function Editor(elements) {
    this.textarea = elements.textarea;
    this.highlight = elements.highlight;
    this.gutter = elements.gutter;
    this.gutterInner = elements.gutter.querySelector('.gutter-inner');

    this.onChange = null;   // function(text)
    this.onCursor = null;   // function({line, column})

    this._lineStarts = null;
    this._gutterSignature = null;
    this._problemLines = {};
    this._activeLine = -1;

    this._bind();
  }

  Editor.prototype._bind = function () {
    var self = this;

    this.textarea.addEventListener('input', function () {
      self._lineStarts = null;
      self.render();
      if (self.onChange) self.onChange(self.textarea.value);
      self._emitCursor();
    });

    this.textarea.addEventListener('scroll', function () {
      self._syncScroll();
    });

    ['keyup', 'click', 'focus', 'select'].forEach(function (name) {
      self.textarea.addEventListener(name, function () { self._emitCursor(); });
    });

    document.addEventListener('selectionchange', function () {
      if (document.activeElement === self.textarea) self._emitCursor();
    });

    // clicking a line number selects that whole line
    this.gutter.addEventListener('click', function (event) {
      var target = event.target.closest('.ln');
      if (!target) return;
      var line = Number(target.getAttribute('data-line'));
      self.selectLines(line, line);
      self.textarea.focus();
    });

    // Tab inserts the canonical tag indent instead of leaving the editor
    this.textarea.addEventListener('keydown', function (event) {
      if (event.key !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      self.insertAtCursor(humandot.TAG_INDENT);
    });
  };

  /* ---------------------------------------------------------- text access */

  Editor.prototype.getValue = function () {
    return this.textarea.value;
  };

  Editor.prototype.setValue = function (text) {
    this.textarea.value = text;
    this._lineStarts = null;
    this.render();
    if (this.onChange) this.onChange(text);
    this._emitCursor();
  };

  Editor.prototype.lineStarts = function () {
    if (this._lineStarts) return this._lineStarts;
    var starts = [0];
    var text = this.textarea.value;
    for (var i = 0; i < text.length; i++) {
      if (text.charAt(i) === '\n') starts.push(i + 1);
    }
    this._lineStarts = starts;
    return starts;
  };

  Editor.prototype.lineCount = function () {
    return this.lineStarts().length;
  };

  // character range of a line, newline excluded
  Editor.prototype.lineRange = function (line) {
    var starts = this.lineStarts();
    var text = this.textarea.value;
    if (line < 0 || line >= starts.length) return null;
    var start = starts[line];
    var end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
    return { start: start, end: end };
  };

  Editor.prototype.lineAtOffset = function (offset) {
    var starts = this.lineStarts();
    var low = 0;
    var high = starts.length - 1;
    while (low < high) {
      var middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= offset) low = middle; else high = middle - 1;
    }
    return low;
  };

  Editor.prototype.cursor = function () {
    var offset = this.textarea.selectionStart;
    var line = this.lineAtOffset(offset);
    return { line: line, column: offset - this.lineStarts()[line], offset: offset };
  };

  /* -------------------------------------------------------------- editing */

  /*
   * All programmatic edits go through here so that the browser's native undo
   * stack keeps working - execCommand is deprecated but it is still the only
   * way to edit a textarea undoably.
   */
  Editor.prototype.replaceRange = function (start, end, text) {
    var textarea = this.textarea;
    textarea.focus();
    textarea.setSelectionRange(start, end);

    var inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch (error) {
      inserted = false;
    }
    if (!inserted) {
      var value = textarea.value;
      textarea.value = value.slice(0, start) + text + value.slice(end);
      textarea.setSelectionRange(start + text.length, start + text.length);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  Editor.prototype.insertAtCursor = function (text) {
    this.replaceRange(this.textarea.selectionStart, this.textarea.selectionEnd, text);
  };

  Editor.prototype.replaceLine = function (line, text) {
    var range = this.lineRange(line);
    if (!range) return;
    this.replaceRange(range.start, range.end, text);
  };

  // removes the lines and the newline that follows them
  Editor.prototype.removeLines = function (from, to) {
    var first = this.lineRange(from);
    var last = this.lineRange(to);
    if (!first || !last) return;
    var text = this.textarea.value;
    var end = Math.min(last.end + 1, text.length);
    this.replaceRange(first.start, end, '');
  };

  Editor.prototype.appendBlock = function (text) {
    var value = this.textarea.value;
    var prefix = '';
    if (value.length > 0 && !/\n\s*\n$/.test(value)) {
      prefix = /\n$/.test(value) ? '\n' : '\n\n';
    }
    this.replaceRange(value.length, value.length, prefix + text);
  };

  /* ------------------------------------------------------------ selection */

  Editor.prototype.selectLines = function (from, to) {
    var first = this.lineRange(from);
    var last = this.lineRange(to);
    if (!first || !last) return;
    this.textarea.setSelectionRange(first.start, last.end);
    this.scrollLineIntoView(from);
    this._emitCursor();
  };

  Editor.prototype.moveCursorTo = function (line, column) {
    var range = this.lineRange(line);
    if (!range) return;
    var offset = Math.min(range.start + (column || 0), range.end);
    this.textarea.setSelectionRange(offset, offset);
    this.scrollLineIntoView(line);
    this._emitCursor();
  };

  Editor.prototype.scrollLineIntoView = function (line) {
    var lineHeight = this._lineHeight();
    var top = line * lineHeight;
    var viewTop = this.textarea.scrollTop;
    var viewHeight = this.textarea.clientHeight;
    if (top < viewTop + lineHeight) {
      this.textarea.scrollTop = Math.max(0, top - lineHeight * 2);
    } else if (top > viewTop + viewHeight - lineHeight * 2) {
      this.textarea.scrollTop = top - viewHeight + lineHeight * 3;
    }
    this._syncScroll();
  };

  Editor.prototype._lineHeight = function () {
    if (!this._cachedLineHeight) {
      var computed = global.getComputedStyle(this.textarea).lineHeight;
      this._cachedLineHeight = parseFloat(computed) || 18;
    }
    return this._cachedLineHeight;
  };

  Editor.prototype._emitCursor = function () {
    if (this.onCursor) this.onCursor(this.cursor());
  };

  /* ------------------------------------------------------------ rendering */

  Editor.prototype.setProblems = function (problems) {
    var byLine = {};
    (problems || []).forEach(function (problem) {
      // an error on a line wins over a warning
      if (byLine[problem.line] !== 'error') byLine[problem.line] = problem.severity;
    });
    this._problemLines = byLine;
    this._renderGutter();
  };

  Editor.prototype.setActiveLine = function (line) {
    if (line === this._activeLine) return;
    this._activeLine = line;
    this._renderGutter();
  };

  Editor.prototype.render = function () {
    var lines = humandot.splitLines(this.textarea.value);
    this.highlight.innerHTML = lines.map(highlightLine).join('\n') + '\n';
    this._renderGutter();
    this._syncScroll();
  };

  Editor.prototype._renderGutter = function () {
    var count = this.lineCount();
    var signature = count + '|' + this._activeLine + '|' + JSON.stringify(this._problemLines);
    if (signature === this._gutterSignature) return;
    this._gutterSignature = signature;

    var html = '';
    for (var i = 0; i < count; i++) {
      var className = 'ln';
      if (this._problemLines[i]) className += ' ln--' + this._problemLines[i];
      if (i === this._activeLine) className += ' ln--active';
      html += '<div class="' + className + '" data-line="' + i + '">' + (i + 1) + '</div>';
    }
    this.gutterInner.innerHTML = html;
    this.gutter.style.width = (String(count).length + 2) + 'ch';
    this._syncScroll();
  };

  Editor.prototype._syncScroll = function () {
    this.highlight.style.transform =
      'translate(' + -this.textarea.scrollLeft + 'px,' + -this.textarea.scrollTop + 'px)';
    this.gutterInner.style.transform = 'translateY(' + -this.textarea.scrollTop + 'px)';
  };

  global.DOTE.Editor = Editor;
})(this);
