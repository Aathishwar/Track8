/**
 * Track8 - Excel writer
 *
 * Produces a real .xlsx file with no libraries. An xlsx is a ZIP containing a
 * handful of XML parts, so this module is two small pieces: a store-only ZIP
 * builder (with the CRC32 the format requires) and a minimal SpreadsheetML
 * generator.
 *
 * Entries are stored uncompressed. The whole workbook is a few tens of
 * kilobytes, every reader accepts stored entries, and it keeps the code short
 * enough to audit - which matters more here than file size.
 *
 * Dates and durations are written as real Excel numbers with number formats
 * applied, not as text, so the columns can be summed, sorted and pivoted in
 * Excel, Google Sheets or LibreOffice without any cleanup.
 */
(function (global) {
  'use strict';

  /* --------------------------------------------------------------- CRC32 */

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* ----------------------------------------------------------------- ZIP */

  function dosDateTime(date) {
    // ZIP stores modification time in the 1980-epoch MS-DOS packed format.
    var year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2)),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  /**
   * Build a ZIP archive from [{ name, data: Uint8Array }].
   * Store method only: local headers, then a central directory, then the EOCD.
   */
  function zip(entries, when) {
    var encoder = new TextEncoder();
    var stamp = dosDateTime(when || new Date());
    var chunks = [];
    var central = [];
    var offset = 0;

    entries.forEach(function (entry) {
      var nameBytes = encoder.encode(entry.name);
      var crc = crc32(entry.data);
      var size = entry.data.length;

      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true);   // local file header signature
      lv.setUint16(4, 20, true);           // version needed
      lv.setUint16(6, 0x0800, true);       // UTF-8 filenames
      lv.setUint16(8, 0, true);            // method: stored
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);        // compressed size
      lv.setUint32(22, size, true);        // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);           // extra field length
      local.set(nameBytes, 30);

      chunks.push(local, entry.data);

      var dir = new Uint8Array(46 + nameBytes.length);
      var dv = new DataView(dir.buffer);
      dv.setUint32(0, 0x02014B50, true);   // central directory signature
      dv.setUint16(4, 20, true);           // version made by
      dv.setUint16(6, 20, true);           // version needed
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, stamp.time, true);
      dv.setUint16(14, stamp.date, true);
      dv.setUint32(16, crc, true);
      dv.setUint32(20, size, true);
      dv.setUint32(24, size, true);
      dv.setUint16(28, nameBytes.length, true);
      dv.setUint32(42, offset, true);      // offset of the local header
      dir.set(nameBytes, 46);
      central.push(dir);

      offset += local.length + size;
    });

    var centralSize = central.reduce(function (sum, d) { return sum + d.length; }, 0);

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054B50, true);     // end of central directory
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob(chunks.concat(central, [eocd]), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  /* ------------------------------------------------------ SpreadsheetML */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // Control characters are illegal in XML 1.0 and would corrupt the file.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  /** 0 -> A, 25 -> Z, 26 -> AA */
  function columnLetter(index) {
    var letters = '';
    var n = index;
    do {
      letters = String.fromCharCode(65 + (n % 26)) + letters;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return letters;
  }

  // Excel counts days from 1899-12-30. Building the serial from the local
  // calendar fields (not the epoch value) keeps the date the user's own date
  // regardless of their timezone offset.
  function dateSerial(value) {
    var d = (value instanceof Date) ? value : new Date(value);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000 + 25569;
  }

  /** Time of day as a fraction of 24h, which is how Excel stores clock times. */
  function timeFraction(value) {
    var d = (value instanceof Date) ? value : new Date(value);
    return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
  }

  var STYLE = { general: 0, header: 1, date: 2, time: 3, number: 4, bold: 5, integer: 6 };

  function cellXml(ref, value, type) {
    if (value == null || value === '') return '<c r="' + ref + '"/>';

    switch (type) {
      case 'number':
        if (!isFinite(value)) return '<c r="' + ref + '"/>';
        return '<c r="' + ref + '" s="' + STYLE.number + '"><v>' + Number(value) + '</v></c>';
      case 'int':
        if (!isFinite(value)) return '<c r="' + ref + '"/>';
        return '<c r="' + ref + '" s="' + STYLE.integer + '"><v>' + Math.round(value) + '</v></c>';
      case 'date':
        return '<c r="' + ref + '" s="' + STYLE.date + '"><v>' + dateSerial(value) + '</v></c>';
      case 'time':
        return '<c r="' + ref + '" s="' + STYLE.time + '"><v>' + timeFraction(value) + '</v></c>';
      case 'header':
        return '<c r="' + ref + '" s="' + STYLE.header + '" t="inlineStr"><is><t>' + esc(value) + '</t></is></c>';
      case 'bold':
        return '<c r="' + ref + '" s="' + STYLE.bold + '" t="inlineStr"><is><t>' + esc(value) + '</t></is></c>';
      default:
        return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(value) + '</t></is></c>';
    }
  }

  /**
   * Render one worksheet.
   * sheet: { name, columns: [{ header, width, type }], rows: [[value, ...]] }
   */
  function sheetXml(sheet) {
    var columns = sheet.columns;
    var lastColumn = columnLetter(columns.length - 1);
    var lastRow = sheet.rows.length + 1;

    var cols = columns.map(function (col, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' +
        (col.width || 14) + '" customWidth="1"/>';
    }).join('');

    var header = '<row r="1">' + columns.map(function (col, i) {
      return cellXml(columnLetter(i) + '1', col.header, 'header');
    }).join('') + '</row>';

    var body = sheet.rows.map(function (row, r) {
      var rowNumber = r + 2;
      var cells = row.map(function (value, i) {
        // A per-cell override wins over the column default, which is how a
        // totals row can go bold inside an otherwise numeric column.
        var type = (value && typeof value === 'object' && 'v' in value)
          ? value.t
          : columns[i].type;
        var raw = (value && typeof value === 'object' && 'v' in value) ? value.v : value;
        return cellXml(columnLetter(i) + rowNumber, raw, type);
      }).join('');
      return '<row r="' + rowNumber + '">' + cells + '</row>';
    }).join('');

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1:' + lastColumn + Math.max(1, lastRow) + '"/>' +
      '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' + cols + '</cols>' +
      '<sheetData>' + header + body + '</sheetData>' +
      (sheet.rows.length ? '<autoFilter ref="A1:' + lastColumn + lastRow + '"/>' : '') +
      '</worksheet>';
  }

  function stylesXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="3">' +
      '<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>' +
      '<numFmt numFmtId="165" formatCode="hh:mm"/>' +
      '<numFmt numFmtId="166" formatCode="0.00"/>' +
      '</numFmts>' +
      '<fonts count="3">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
      '</fonts>' +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF0F9D6E"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="7">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  }

  function contentTypesXml(sheetCount) {
    var overrides = '';
    for (var i = 1; i <= sheetCount; i++) {
      overrides += '<Override PartName="/xl/worksheets/sheet' + i + '.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      overrides +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';
  }

  function workbookXml(sheets) {
    var entries = sheets.map(function (sheet, i) {
      return '<sheet name="' + esc(sheet.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    }).join('');

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + entries + '</sheets></workbook>';
  }

  function workbookRelsXml(sheetCount) {
    var rels = '';
    for (var i = 1; i <= sheetCount; i++) {
      rels += '<Relationship Id="rId' + i + '" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        'Target="worksheets/sheet' + i + '.xml"/>';
    }
    rels += '<Relationship Id="rId' + (sheetCount + 1) + '" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ' +
      'Target="styles.xml"/>';

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels + '</Relationships>';
  }

  function rootRelsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
      'Target="xl/workbook.xml"/></Relationships>';
  }

  /**
   * Build an .xlsx Blob.
   * sheets: [{ name, columns: [{ header, width, type }], rows: [[...]] }]
   * Column types: 'text' (default), 'number', 'date', 'time'.
   * A cell may override its column with { v: value, t: type }.
   */
  function build(sheets, when) {
    var encoder = new TextEncoder();
    var files = [
      { name: '[Content_Types].xml', text: contentTypesXml(sheets.length) },
      { name: '_rels/.rels', text: rootRelsXml() },
      { name: 'xl/workbook.xml', text: workbookXml(sheets) },
      { name: 'xl/_rels/workbook.xml.rels', text: workbookRelsXml(sheets.length) },
      { name: 'xl/styles.xml', text: stylesXml() }
    ];

    sheets.forEach(function (sheet, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', text: sheetXml(sheet) });
    });

    return zip(files.map(function (file) {
      return { name: file.name, data: encoder.encode(file.text) };
    }), when);
  }

  global.T8Xlsx = {
    build: build,
    columnLetter: columnLetter,
    dateSerial: dateSerial,
    timeFraction: timeFraction,
    crc32: crc32
  };
})(typeof window !== 'undefined' ? window : globalThis);
