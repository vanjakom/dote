/*
 * editor.js - the text pane.
 *
 * A plain textarea. No syntax layer, no line numbers: the document is shown
 * as the characters it contains and nothing else. What this module adds is
 * line arithmetic - turning character offsets into line indexes and back -
 * because the map needs to address dots by the lines they occupy.
 *
 * Links are the one exception to "nothing but text". A textarea cannot hold
 * an anchor, so the character under the mouse is computed from the font
 * metrics instead: the face is monospaced and nothing wraps, so a point maps
 * to a line and a column by division. A url there turns the mouse pointer
 * into a hand and a click opens it; the text itself is left looking like
 * every other line.
 *
 * All programmatic edits go through replaceRange so the browser's own undo
 * stack keeps working.
 */
(function (global) {
  'use strict';

  var humandot = global.DOTE.humandot;

  // a click with any modifier held is an ordinary click, not a link click
  function hasModifier(event) {
    return event.altKey || event.metaKey || event.ctrlKey || event.shiftKey;
  }

  /*
   * Visual column -> character index. They differ only when the line contains
   * tabs, which advance to the next tab stop rather than by one column.
   */
  function characterAtColumn(line, column, tabSize) {
    var visual = 0;
    for (var i = 0; i < line.length; i++) {
      var width = line.charAt(i) === '\t' ? tabSize - (visual % tabSize) : 1;
      if (column < visual + width) return i;
      visual += width;
    }
    return line.length;
  }

  function Editor(elements) {
    this.textarea = elements.textarea;

    this.onChange = null;   // function(text)
    this.onCursor = null;   // function({line, column, offset})
    this.onLink = null;     // function(url)

    this._lineStarts = null;
    this._cachedLineHeight = null;
    this._cachedCharWidth = null;
    this._cursorStyle = '';
    this._pendingLink = null;

    this._bind();
  }

  Editor.prototype._bind = function () {
    var self = this;

    this.textarea.addEventListener('input', function () {
      self._lineStarts = null;
      if (self.onChange) self.onChange(self.textarea.value);
      self._emitCursor();
    });

    ['keyup', 'click', 'focus', 'select'].forEach(function (name) {
      self.textarea.addEventListener(name, function () { self._emitCursor(); });
    });

    document.addEventListener('selectionchange', function () {
      if (document.activeElement === self.textarea) self._emitCursor();
    });

    this.textarea.addEventListener('keydown', function (event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Tab inserts the tag indent instead of leaving the editor
      if (event.key === 'Tab') {
        event.preventDefault();
        self.insertAtCursor(humandot.TAG_INDENT);
        return;
      }
      // shift+enter stays a plain newline, the way out of the indenting
      if (event.key === 'Enter' && !event.shiftKey) self._handleEnter(event);
    });

    this._bindLinks();
  };

  /*
   * Enter inside a dot opens the next tag already indented, so tags are typed
   * one after another without touching the space bar.
   *
   * It stays out of the way wherever indenting would corrupt the line: with
   * the caret part way along a coordinate (the tail would become a tag) or
   * inside a tag's leading whitespace (the tail would be indented twice).
   * On a line holding nothing but the indent it clears it instead, so the
   * blank line that closes the dot is really blank.
   */
  Editor.prototype._handleEnter = function (event) {
    var textarea = this.textarea;
    if (textarea.selectionStart !== textarea.selectionEnd) return;

    var cursor = this.cursor();
    var text = this.lineText(cursor.line);
    if (text === null) return;

    var kind = humandot.classifyLine(text);

    if (kind === humandot.LINE.BLANK) {
      if (text.length === 0) return;
      event.preventDefault();
      var range = this.lineRange(cursor.line);
      this.replaceRange(range.start, range.end, '\n');
      return;
    }

    if (kind === humandot.LINE.COORDINATE) {
      if (cursor.column < text.length) return;
    } else if (kind === humandot.LINE.TAG) {
      if (cursor.column < text.match(/^[ \t]*/)[0].length) return;
    } else {
      return;
    }

    event.preventDefault();
    this.insertAtCursor('\n' + humandot.TAG_INDENT);
  };

  /* ------------------------------------------------------------------ links */

  Editor.prototype._bindLinks = function () {
    var self = this;

    this.textarea.addEventListener('mousemove', function (event) {
      var over = !hasModifier(event) && self.linkAtPoint(event.clientX, event.clientY);
      self._setCursorStyle(over ? 'pointer' : '');
    });

    this.textarea.addEventListener('mouseleave', function () {
      self._setCursorStyle('');
    });

    /*
     * The caret must not move to where the link is, so the default is
     * prevented on the way down and the link is opened on the way up - and
     * only if the mouse is still on the same url, which lets a drag that
     * started on a link fall through as an ordinary drag.
     */
    this.textarea.addEventListener('mousedown', function (event) {
      self._pendingLink = null;
      if (event.button !== 0 || hasModifier(event)) return;
      var link = self.linkAtPoint(event.clientX, event.clientY);
      if (!link) return;
      event.preventDefault();
      self._pendingLink = link.url;
    });

    this.textarea.addEventListener('mouseup', function (event) {
      var url = self._pendingLink;
      self._pendingLink = null;
      if (!url) return;
      var link = self.linkAtPoint(event.clientX, event.clientY);
      if (link && link.url === url && self.onLink) self.onLink(url);
    });
  };

  Editor.prototype._setCursorStyle = function (style) {
    if (style === this._cursorStyle) return;
    this._cursorStyle = style;
    this.textarea.style.cursor = style;
  };

  // the line and column under a viewport point, null when past the text
  Editor.prototype.positionAt = function (clientX, clientY) {
    var textarea = this.textarea;
    var rect = textarea.getBoundingClientRect();
    var style = global.getComputedStyle(textarea);
    var left = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    var top = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);

    var x = clientX - rect.left - left + textarea.scrollLeft;
    var y = clientY - rect.top - top + textarea.scrollTop;
    if (x < 0 || y < 0) return null;

    var line = Math.floor(y / this._lineHeight());
    var text = this.lineText(line);
    if (text === null) return null;

    var tabSize = parseInt(style.tabSize, 10) || 8;
    var column = characterAtColumn(text, Math.floor(x / this._charWidth()), tabSize);
    return { line: line, column: column, text: text };
  };

  Editor.prototype.linkAtPoint = function (clientX, clientY) {
    var position = this.positionAt(clientX, clientY);
    return position ? humandot.linkAt(position.text, position.column) : null;
  };

  // one character of the monospace face, measured off screen once
  Editor.prototype._charWidth = function () {
    if (!this._cachedCharWidth) {
      var style = global.getComputedStyle(this.textarea);
      try {
        var context = document.createElement('canvas').getContext('2d');
        context.font = style.fontSize + ' ' + style.fontFamily;
        // measure a run so the per character rounding averages out
        this._cachedCharWidth = context.measureText(new Array(101).join('0')).width / 100;
      } catch (error) {
        this._cachedCharWidth = parseFloat(style.fontSize) * 0.6;
      }
    }
    return this._cachedCharWidth;
  };

  /* ---------------------------------------------------------- text access */

  Editor.prototype.getValue = function () {
    return this.textarea.value;
  };

  Editor.prototype.setValue = function (text) {
    this.textarea.value = text;
    this._lineStarts = null;
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
    if (line < 0 || line >= starts.length) return null;
    var text = this.textarea.value;
    return {
      start: starts[line],
      end: line + 1 < starts.length ? starts[line + 1] - 1 : text.length
    };
  };

  // text of a line without its newline, null when the line does not exist
  Editor.prototype.lineText = function (line) {
    var range = this.lineRange(line);
    return range ? this.textarea.value.slice(range.start, range.end) : null;
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
   * execCommand is deprecated but it is still the only way to edit a textarea
   * undoably. The fallback assigns the value directly and dispatches the
   * input event the assignment does not fire.
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
    var end = Math.min(last.end + 1, this.textarea.value.length);
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
  };

  Editor.prototype._lineHeight = function () {
    if (!this._cachedLineHeight) {
      this._cachedLineHeight =
        parseFloat(global.getComputedStyle(this.textarea).lineHeight) || 18;
    }
    return this._cachedLineHeight;
  };

  Editor.prototype._emitCursor = function () {
    if (this.onCursor) this.onCursor(this.cursor());
  };

  global.DOTE.Editor = Editor;
})(this);
