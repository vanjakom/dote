/*
 * humandot.js - parser, writer and formatter for the humandot file format.
 *
 * Pure logic, no DOM. Mirrors clj-geo:
 *   src/cljc/clj_geo/dot/core.clj
 *   src/clj/clj_geo/dot/store/humandot.clj
 *
 * Format recap:
 *   [humandot]            magic first line
 *   [statement]           directive, [tag:xxx] appends xxx to every dot
 *   ; comment             comment line (column 0)
 *   longitude, latitude   starts a dot   <- longitude FIRST
 *       tag               indented line, belongs to the dot above
 *   <blank>               closes the dot
 *
 * Tag conventions: "#x" public label, "@x" personal label, "|key|value"
 * key/value pair, "---" separates extracted from added tags, "===" separates
 * public from private tags.
 */
(function (global) {
  'use strict';

  var MAGIC = '[humandot]';
  var TAG_INDENT = '   ';

  /* ---------------------------------------------------------------- utils */

  function splitLines(text) {
    // normalize CRLF/CR so exact line comparisons (like [humandot]) hold
    return String(text == null ? '' : text).split(/\r\n|\r|\n/);
  }

  function isBlank(line) {
    return line.trim().length === 0;
  }

  function startsWith(s, prefix) {
    return s.lastIndexOf(prefix, 0) === 0;
  }

  // strict number parse: "44abc" is not a coordinate
  function toNumber(s) {
    if (s == null) return null;
    var t = s.trim();
    if (t === '') return null;
    var v = Number(t);
    return isFinite(v) ? v : null;
  }

  // coordinate as text: no exponent notation, no trailing zeros
  function formatNumber(v) {
    if (v == null || !isFinite(v)) return '';
    var s = v.toFixed(7);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  /* --------------------------------------------------------------- parsing */

  var LINE = {
    COMMENT: 'comment',
    MAGIC: 'magic',
    STATEMENT: 'statement',
    BLANK: 'blank',
    TAG: 'tag',
    COORDINATE: 'coordinate',
    UNKNOWN: 'unknown'
  };

  /*
   * Classify a single line. Branch order is significant and matches the
   * Clojure reader: comment, magic, statement, blank, tag, coordinate.
   * An indented ";" is a tag, not a comment; an indented "[x]" is a tag too.
   */
  function classifyLine(line) {
    if (startsWith(line, ';')) return LINE.COMMENT;
    if (line === MAGIC) return LINE.MAGIC;
    if (line.length >= 2 && startsWith(line, '[') && line.charAt(line.length - 1) === ']') {
      return LINE.STATEMENT;
    }
    if (isBlank(line)) return LINE.BLANK;
    if (startsWith(line, ' ') || startsWith(line, '\t')) return LINE.TAG;
    if (line.indexOf(',') >= 0) return LINE.COORDINATE;
    return LINE.UNKNOWN;
  }

  function parseCoordinate(line) {
    var fields = line.split(',');
    return {
      longitude: toNumber(fields[0]),
      latitude: toNumber(fields[1]),
      extra: fields.length > 2
    };
  }

  /*
   * parse(text) -> {
   *   dots: [dot], defaultTags: [string], statements: [{line, statement}],
   *   problems: [{line, severity, message}], lineCount
   * }
   *
   * dot = {
   *   longitude, latitude,     numbers, null when unparsable
   *   tags,                    tags written in the file, in order
   *   allTags,                 tags + defaultTags (what clj-geo hands out)
   *   line,                    0-based index of the coordinate line
   *   endLine,                 0-based index of the dot's last line
   *   tagLines,                0-based index per entry in tags
   *   valid                    coordinates parsed and in range
   * }
   *
   * Divergence from clj-geo (deliberate, see AGENTS.md): a coordinate line
   * that follows another dot without a blank line between them closes the
   * previous dot instead of discarding it. Files that are well formed parse
   * identically; malformed ones keep their data instead of losing it.
   */
  function parse(text) {
    var lines = splitLines(text);
    var dots = [];
    var statements = [];
    var problems = [];
    var defaultTags = [];
    var current = null;

    function problem(line, severity, message) {
      problems.push({ line: line, severity: severity, message: message });
    }

    function closeCurrent(endLine) {
      if (!current) return;
      current.endLine = Math.max(current.line, endLine);
      dots.push(current);
      current = null;
    }

    if (lines.length === 0 || lines[0] !== MAGIC) {
      problem(0, 'warning', 'file should start with ' + MAGIC);
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      switch (classifyLine(line)) {
        case LINE.COMMENT:
        case LINE.MAGIC:
          break;

        case LINE.STATEMENT:
          var statement = line.substring(1, line.length - 1);
          statements.push({ line: i, statement: statement });
          if (startsWith(statement, 'tag:')) {
            defaultTags.push(statement.substring(4));
          }
          break;

        case LINE.BLANK:
          closeCurrent(i - 1);
          break;

        case LINE.TAG:
          if (!current) {
            problem(i, 'error', 'indented tag before any location');
            break;
          }
          current.tags.push(line.trim());
          current.tagLines.push(i);
          break;

        case LINE.COORDINATE:
          closeCurrent(i - 1);
          var coordinate = parseCoordinate(line);
          current = {
            longitude: coordinate.longitude,
            latitude: coordinate.latitude,
            tags: [],
            allTags: [],
            line: i,
            endLine: i,
            tagLines: [],
            valid: false
          };
          if (coordinate.longitude == null || coordinate.latitude == null) {
            problem(i, 'error', 'cannot read "longitude, latitude" from this line');
          } else if (Math.abs(coordinate.longitude) > 180 || Math.abs(coordinate.latitude) > 90) {
            var swapped = Math.abs(coordinate.longitude) <= 90 &&
              Math.abs(coordinate.latitude) > 90 && Math.abs(coordinate.latitude) <= 180;
            problem(i, 'error', swapped
              ? 'coordinates out of range - the order is longitude, latitude'
              : 'coordinates out of range');
          } else {
            current.valid = true;
          }
          if (coordinate.extra) {
            problem(i, 'warning', 'only the first two comma separated fields are read');
          }
          break;

        default:
          problem(i, 'warning', 'line is ignored, it is neither a comment, a tag nor a location');
          break;
      }
    }
    closeCurrent(lines.length - 1);

    // default tags from [tag:x] directives are appended to every dot
    dots.forEach(function (dot) {
      dot.allTags = dot.tags.concat(defaultTags);
    });

    return {
      dots: dots,
      defaultTags: defaultTags,
      statements: statements,
      problems: problems,
      lineCount: lines.length
    };
  }

  /* ----------------------------------------------------------------- tags */

  var TAG = {
    PUBLIC: 'public',       // #label
    PERSONAL: 'personal',   // @label
    PAIR: 'pair',           // |key|value
    LINK: 'link',           // http(s)://...
    SEPARATOR: 'separator', // --- or ===
    NOTE: 'note'            // anything else, free text
  };

  function classifyTag(tag) {
    var t = tag.trim();
    if (t === '---' || t === '===') return TAG.SEPARATOR;
    if (startsWith(t, '#')) return TAG.PUBLIC;
    if (startsWith(t, '@')) return TAG.PERSONAL;
    if (startsWith(t, '|')) return TAG.PAIR;
    if (startsWith(t, 'http://') || startsWith(t, 'https://')) return TAG.LINK;
    return TAG.NOTE;
  }

  /*
   * Links inside a line. A tag is often nothing but a URL, but one can also
   * sit in the middle of a note or a comment, so the whole line is scanned.
   * Trailing sentence punctuation is left out of the match.
   */
  var LINK_PATTERN = /https?:\/\/[^\s]+/g;

  function linkAt(line, column) {
    LINK_PATTERN.lastIndex = 0;
    var match;
    while ((match = LINK_PATTERN.exec(line)) !== null) {
      var url = match[0].replace(/[.,;:!?]+$/, '');
      var start = match.index;
      var end = start + url.length;
      if (column >= start && column < end) {
        return { url: url, start: start, end: end };
      }
    }
    return null;
  }

  // "|key|value" -> {key: "key", value: "value"}, null when not a pair
  function parsePair(tag) {
    var t = tag.trim();
    if (!startsWith(t, '|')) return null;
    var rest = t.substring(1);
    var index = rest.indexOf('|');
    if (index < 0) return null;
    return { key: rest.substring(0, index), value: rest.substring(index + 1) };
  }

  // first note-like tag, used as the display name of a dot
  function label(dot) {
    var tags = dot.allTags && dot.allTags.length ? dot.allTags : dot.tags;
    for (var i = 0; i < tags.length; i++) {
      var kind = classifyTag(tags[i]);
      if (kind === TAG.NOTE) return tags[i];
    }
    for (var j = 0; j < tags.length; j++) {
      var k = classifyTag(tags[j]);
      if (k === TAG.PUBLIC || k === TAG.PERSONAL) return tags[j];
    }
    return null;
  }

  /* --------------------------------------------------------------- writing */

  // canonical text of one dot, matching clj-geo write-to-string
  function dotToString(dot) {
    var text = formatNumber(dot.longitude) + ', ' + formatNumber(dot.latitude) + '\n';
    (dot.tags || []).forEach(function (tag) {
      text += TAG_INDENT + tag + '\n';
    });
    return text;
  }

  // whole file from a list of dots, with optional header comment lines
  function write(dots, headerLines) {
    var text = MAGIC + '\n\n';
    (headerLines || []).forEach(function (line) {
      text += '; ' + line + '\n';
    });
    if (headerLines && headerLines.length) text += '\n';
    (dots || []).forEach(function (dot) {
      text += dotToString(dot) + '\n';
    });
    return text;
  }

  /*
   * format(text) normalizes a document in place: it rewrites coordinate and
   * tag lines to canonical spacing and collapses blank runs, but keeps
   * comments, directives and unknown lines where the author put them.
   * A comment directly above a dot stays attached to it.
   */
  function format(text) {
    var lines = splitLines(text);
    var out = [];
    var dotOpen = false;

    function emitBlank() {
      if (out.length === 0) return;                          // no leading blank
      if (isBlank(out[out.length - 1])) return;              // collapse runs
      out.push('');
    }

    lines.forEach(function (line) {
      var kind = classifyLine(line);
      switch (kind) {
        case LINE.BLANK:
          emitBlank();
          dotOpen = false;
          break;

        case LINE.MAGIC:
          out.push(MAGIC);
          break;

        case LINE.COORDINATE:
          // a dot must be closed by a blank line before the next one starts,
          // otherwise clj-geo drops it
          if (dotOpen) emitBlank();
          var coordinate = parseCoordinate(line);
          out.push(coordinate.longitude == null || coordinate.latitude == null
            ? line.replace(/\s+$/, '')
            : formatNumber(coordinate.longitude) + ', ' + formatNumber(coordinate.latitude));
          dotOpen = true;
          break;

        case LINE.TAG:
          out.push(TAG_INDENT + line.trim());
          break;

        default:
          // comments and directives keep their place, also between dots
          out.push(line.replace(/\s+$/, ''));
          break;
      }
    });

    // guarantee the magic line, then exactly one trailing newline
    if (out.length === 0 || out[0] !== MAGIC) out = [MAGIC, ''].concat(out);
    while (out.length && isBlank(out[out.length - 1])) out.pop();
    return out.join('\n') + '\n';
  }

  /* ------------------------------------------------------------- selection */

  // index of the dot owning a line, -1 when the line belongs to none
  function dotIndexAtLine(dots, line) {
    for (var i = 0; i < dots.length; i++) {
      if (line >= dots[i].line && line <= dots[i].endLine) return i;
    }
    return -1;
  }

  global.DOTE = global.DOTE || {};
  global.DOTE.humandot = {
    MAGIC: MAGIC,
    TAG_INDENT: TAG_INDENT,
    LINE: LINE,
    TAG: TAG,
    splitLines: splitLines,
    classifyLine: classifyLine,
    classifyTag: classifyTag,
    linkAt: linkAt,
    parsePair: parsePair,
    parseCoordinate: parseCoordinate,
    formatNumber: formatNumber,
    label: label,
    parse: parse,
    write: write,
    dotToString: dotToString,
    format: format,
    dotIndexAtLine: dotIndexAtLine
  };
})(this);
