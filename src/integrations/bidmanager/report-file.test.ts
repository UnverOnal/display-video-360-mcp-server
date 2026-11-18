import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import {
  parseReportFile, readReportFile, ReportFileError,
  type ReportPage, type ReportPageRequest, type ReportFileErrorKind,
  type ReportFileMalformedReason,
} from './report-file.js';

type Cell = string | number | null;
type Sheet = Cell[][];
const LINK = 'https://storage.googleapis.com/synthetic/report?X-Goog-Signature=synthetic-secret';
const MISSING = 'Some rows may be missing from your report because the following dimensions give information about entities your account may not have permission to access:';
const BILLING = 'Reporting numbers from the previous month are finalized (for billing purposes) on the first of each month, unless communicated otherwise. Some numbers in reports may fluctuate for up to seven days before matching billing numbers.';
const SHORTENED = 'Some footer lines were shortened.';
const HEADER = ['Advertiser ID', 'Advertiser Currency', 'Impressions', 'Clicks', 'Click Rate (CTR)', 'Revenue (Adv Currency)'];
const DATA: Sheet = [
  ['1000001', 'USD', 100, 2, 0.02, 12.345678],
  ['1000002', '', 200, 6, 0.03, 23.456789],
  ['1000003', 'USD', 300, 4, 0.013333333333, 34.567891],
];
const TOTALS: Cell[] = ['', '', 600, 12, 0.02, 70.370358];
const FOOTER: Sheet = [
  [MISSING, 'Advertiser ID', 'Advertiser Currency'],
  ['Report Time:', '2026/11/05 10:09 GMT'],
  ['Date Range:', '2026/10/01 to 2026/10/31'],
  ['Group By:', 'Advertiser ID'], ['Group By:', 'Advertiser Currency'],
  ['MRC Accredited Metrics', 'Impressions', 'Clicks'], [BILLING],
  ['Filter by Partner ID:', '9000001 (Partner A)'],
  ['Filter by Advertiser ID:', '1000001 (Advertiser A), 1000002 (Advertiser B)'],
];
const STANDARD: Sheet = [HEADER, ...DATA, TOTALS, [], ...FOOTER];
const strings = (rows: Sheet): string[][] => rows.map(row => row.map(cell => cell == null ? '' : String(cell)));
const csvCell = (value: string): string => /[,"\r\n]|^ | $/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const line = (row: readonly string[]): string => row.map(csvCell).join(',');
function googleCsv(rows: Sheet): Uint8Array {
  // A terminal empty row needs its own terminator; a single final newline only ends the preceding row.
  return new TextEncoder().encode(strings(rows).map(line).join('\r\n')
    + (rows.at(-1)?.length === 0 ? '\r\n' : ''));
}
function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
function column(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}
function googleXlsx(rows: Sheet, options: { mergeBilling?: boolean } = {}): Uint8Array {
  // Spreadsheet readers trim trailing empty rows. A value-free footer label preserves
  // the separator while producing no metadata, warnings or notes.
  if (rows.at(-1)?.length === 0) rows = [...rows, ['Group By:']];
  const width = Math.max(...rows.map(row => row.length));
  const sheetRows = rows.map((row, i) => `<row r="${i + 1}">${Array.from({ length: width }, (_, j) => {
    const cell = row[j] ?? '';
    const attributes = `r="${column(j)}${i + 1}" s="0"`;
    return typeof cell === 'number'
      ? `<c ${attributes} t="n"><v>${cell}</v></c>`
      : `<c ${attributes} t="inlineStr"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const billingIndex = rows.findIndex(row => row[0] === BILLING);
  const merge = options.mergeBilling !== false && billingIndex >= 0
    ? `<mergeCells count="1"><mergeCell ref="A${billingIndex + 1}:${column(width - 1)}${billingIndex + 1}"/></mergeCells>` : '';
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files: Record<string, string> = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/data.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relns}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="${relns}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relns}/worksheet" Target="worksheets/data.xml"/><Relationship Id="rId2" Type="${relns}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<styleSheet xmlns="${ns}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
    'xl/worksheets/data.xml': `<worksheet xmlns="${ns}"><dimension ref="A1:${column(width - 1)}${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${sheetRows}</sheetData>${merge}</worksheet>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, content]) => [path, strToU8(content)])));
}
function invariant(page: ReportPage, maxChars = 16_000): ReportPage {
  assert.ok(page.text.length + (page.totalsText === undefined ? 0 : 1 + page.totalsText.length) <= maxChars);
  assert.equal(page.returnedRows, page.rows.length);
  assert.equal(page.truncated, page.nextOffset !== undefined);
  return page;
}
function expected(bytes: Uint8Array, request: ReportPageRequest, header: string[][][number], rows: string[][],
  overrides: Partial<ReportPage> = {}): ReportPage {
  return {
    format: request.format, header, rows, text: [header, ...rows].map(line).join('\n'),
    totalRows: rows.length, offset: request.offset ?? 0, returnedRows: rows.length,
    truncated: false, cellsShortened: false, metadata: { groupBy: [], filters: [] },
    warnings: [], notes: [], fileBytes: bytes.length, ...overrides,
  };
}
async function check(rows: Sheet, request: Partial<ReportPageRequest> = {}, overrides: Partial<ReportPage> = {},
  outputRows = strings(rows.slice(1).filter(row => row.length > 0))): Promise<ReportPage> {
  const req: ReportPageRequest = { format: 'CSV', dimensionCount: 1, ...request };
  const bytes = req.format === 'CSV' ? googleCsv(rows) : googleXlsx(rows);
  const page = invariant(await parseReportFile(bytes, req), req.maxChars);
  assert.deepEqual(page, expected(bytes, req, strings([rows[0]])[0], outputRows, overrides));
  return page;
}
function safeError(kind: ReportFileErrorKind, properties: Partial<ReportFileError> = {}, forbidden = LINK) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ReportFileError);
    assert.equal(error.kind, kind);
    assert.equal(error.retryable, kind === 'timeout' || kind === 'network'
      || (kind === 'download_failed' && (error.httpStatus === 429 || (error.httpStatus! >= 500 && error.httpStatus! <= 599))));
    for (const [key, value] of Object.entries(properties)) assert.deepEqual(error[key as keyof ReportFileError], value);
    for (const representation of [error.message, String(error), JSON.stringify(error)]) {
      for (const secret of [forbidden, new URL(LINK).search, 'synthetic-secret', 'private-response-cell']) {
        assert.ok(!representation.includes(secret), 'error must redact synthetic sensitive values');
      }
    }
    assert.equal('cause' in error, false);
    return true;
  };
}
function malformed(reason: ReportFileMalformedReason) {
  return safeError('malformed', { reason, message: `Google's report file has an unexpected layout (${reason}).` });
}
const standardOverrides: Partial<ReportPage> = {
  totals: strings([TOTALS])[0], totalsText: line(strings([TOTALS])[0]),
  metadata: {
    reportTime: '2026/11/05 10:09 GMT', dateRange: '2026/10/01 to 2026/10/31',
    groupBy: ['Advertiser ID', 'Advertiser Currency'],
    filters: [{ label: 'Partner ID', value: '9000001 (Partner A)' },
      { label: 'Advertiser ID', value: '1000001 (Advertiser A), 1000002 (Advertiser B)' }],
  },
  warnings: [`${MISSING} Advertiser ID, Advertiser Currency`, BILLING],
  notes: ['MRC Accredited Metrics: Impressions; Clicks'],
};
for (const format of ['XLSX', 'CSV'] as const) {
  test(`${format} standard fixture returns the entire exact page`, async () => {
    await check(STANDARD, { format, dimensionCount: 2 }, standardOverrides, strings(DATA));
  });
}
test('totals preserve empty metric cells', async () => {
  const totals = ['', '', '600', '12', '0.02', ''];
  await check([HEADER, ...DATA, totals, []], { dimensionCount: 2 }, { totals, totalsText: line(totals) }, strings(DATA));
});
test('one row with filled dimensions has no totals', async () => {
  await check([HEADER, DATA[0], []], { dimensionCount: 2 });
});
test('one row with empty dimensions stays data without a footer', async () => {
  await check([HEADER, TOTALS], { dimensionCount: 2 }, { notes: ['The report file has no footer.'] });
});
test('zero data rows keep the header and parse metadata', async () => {
  await check([HEADER, [], ['Report Time:', 'synthetic time']], {}, {
    metadata: { groupBy: [], filters: [], reportTime: 'synthetic time' },
  }, []);
});
test('dimensionCount zero never removes a totals-shaped row', async () => {
  await check([HEADER, ...DATA, TOTALS, []], { dimensionCount: 0 });
});
test('a middle row with all dimensions empty stays data', async () => {
  await check([HEADER, DATA[0], TOTALS, DATA[2], []], { dimensionCount: 2 });
});
test('dimension count beyond header width is malformed', async () => {
  await assert.rejects(parseReportFile(googleCsv([HEADER]), { format: 'CSV', dimensionCount: 7 }), malformed('dimension_count'));
});
test('without a separator all following rows are data and last-row totals still apply', async () => {
  await check([HEADER, ...DATA, TOTALS], { dimensionCount: 2 }, {
    totals: strings([TOTALS])[0], totalsText: line(strings([TOTALS])[0]), notes: ['The report file has no footer.'],
  }, strings(DATA));
});
for (const withTotals of [false, true]) {
  for (const excess of [0, 1]) {
    test(`budget boundary totals=${withTotals} excess=${excess}`, async () => {
      // Ten 96-character rows plus separators exactly fill the available budget.
      const header = [withTotals ? 'H'.repeat(19) : 'H'.repeat(30)];
      const data = Array.from({ length: 11 }, (_, i) => ['x'.repeat(96 + (i === 9 ? excess : 0))]);
      const rows: Sheet = withTotals
        ? [['H'.repeat(18), 'M'], ...data.map(row => [row[0].slice(0, -2), '1']), ['', '12345678'], []]
        : [header, ...data, []];
      const count = excess ? 9 : 10;
      const output = strings(rows.slice(1, 1 + count));
      const totals = withTotals ? ['', '12345678'] : undefined;
      await check(rows, { maxChars: 1000 }, {
        totalRows: 11, nextOffset: count, truncated: true, cutBy: 'budget',
        ...(totals ? { totals, totalsText: line(totals) } : {}),
      }, output);
    });
  }
}
test('limit stops at two rows and points to row two', async () => {
  await check(STANDARD, { dimensionCount: 2, limit: 2 }, {
    ...standardOverrides, totalRows: 3, nextOffset: 2, truncated: true, cutBy: 'limit',
  }, strings(DATA.slice(0, 2)));
});
test('offset two returns the final data row and never totals', async () => {
  await check(STANDARD, { dimensionCount: 2, offset: 2 }, { ...standardOverrides, totalRows: 3 }, strings(DATA.slice(2)));
});
test('offset equal to totalRows returns an empty final page', async () => {
  await check(STANDARD, { dimensionCount: 2, offset: 3 }, { ...standardOverrides, totalRows: 3 }, []);
});
test('offset beyond totalRows uses the exact error', async () => {
  await assert.rejects(parseReportFile(googleCsv(STANDARD), { format: 'CSV', dimensionCount: 2, offset: 4 }),
    safeError('invalid_request', { message: 'offset is past the last row (the report has 3 rows).' }));
});
test('an oversized first row is shortened and returned', async () => {
  const short = 'x'.repeat(498) + '…';
  await check([['H'], ['x'.repeat(2000)], []], { maxChars: 1000 }, { cellsShortened: true }, [[short]]);
});
test('twenty oversized headers, first row and totals fit a 1000-character budget', async () => {
  const header = Array(20).fill('H'.repeat(400));
  const data = Array(20).fill('d'.repeat(400));
  const totals = ['', ...Array(19).fill('t'.repeat(400))];
  const bytes = googleCsv([header, data, totals, []]);
  const req: ReportPageRequest = { format: 'CSV', dimensionCount: 1, maxChars: 1000 };
  const h = Array(20).fill('H'.repeat(14) + '…');
  const d = Array(20).fill('d'.repeat(14) + '…');
  const t = ['', ...Array(19).fill('t'.repeat(14) + '…')];
  const page = invariant(await parseReportFile(bytes, req), 1000);
  assert.deepEqual(page, expected(bytes, req, h, [d], { totals: t, totalsText: line(t), cellsShortened: true }));
});
test('quote-only cells count doubled quotes and outer quotes in their cap', async () => {
  await check([['H'], ['"'.repeat(600)], []], {}, { cellsShortened: true }, [['"'.repeat(248) + '…']]);
});
test('cell caps below eight reject too many columns', async () => {
  await assert.rejects(parseReportFile(googleCsv([Array(60).fill('H'), Array(60).fill('d'), []]),
    { format: 'CSV', dimensionCount: 1, maxChars: 1000 }), malformed('too_many_columns'));
});
for (const size of [500, 600]) {
  test(`the 500 cap applies consistently to header, rows, totals and text for length ${size}`, async () => {
    const value = 'x'.repeat(size);
    const shortened = size === 500 ? value : 'x'.repeat(499) + '…';
    const bytes = googleCsv([[value, 'M'], ['id', value], ['', value], []]);
    const req: ReportPageRequest = { format: 'CSV', dimensionCount: 1 };
    const totals = ['', shortened];
    const page = invariant(await parseReportFile(bytes, req));
    assert.deepEqual(page, expected(bytes, req, [shortened, 'M'], [['id', shortened]], {
      totals, totalsText: line(totals), cellsShortened: size > 500,
    }));
  });
}
test('CSV rendering quotes punctuation and spaces and cleans all control characters', async () => {
  const raw = ['a,b', 'a"b', ' leading', 'trailing ', 'a\r\nb', 'a\u0000\u0001\t\u001f\u007fb'];
  const clean = ['a,b', 'a"b', ' leading', 'trailing ', 'a  b', 'a     b'];
  await check([HEADER, raw, []], { dimensionCount: 0 }, {}, [clean]);
});
test('footer filter values are capped to 300 characters', async () => {
  await check([['H'], [], ['Filter by Partner ID:', 'f'.repeat(400)]], {}, {
    metadata: { groupBy: [], filters: [{ label: 'Partner ID', value: 'f'.repeat(299) + '…' }] }, notes: [SHORTENED],
  }, []);
});
test('footer budget keeps fifteen 200-character notes and drops the rest', async () => {
  await check([['H'], [], ...Array.from({ length: 30 }, () => ['n'.repeat(200)])], {}, {
    notes: [...Array(15).fill('n'.repeat(200)), SHORTENED],
  }, []);
});
test('a filter is dropped whole when only its label fits and following lines are dropped', async () => {
  await check([['H'], [], ...Array.from({ length: 10 }, () => ['n'.repeat(299)]),
    ['Filter by ID:', 'v'.repeat(20)], ['Group By:', 'later']], {}, {
    notes: [...Array(10).fill('n'.repeat(299)), SHORTENED],
  }, []);
});
test('unknown labels, no-colon labels, duplicates and trimmed footer cells follow label rules', async () => {
  await check([[' H '], [], [' Unknown: ', ' v1 ', '', ' v2 ', ''],
    ['MRC Accredited Metrics', 'Impressions', 'Clicks'], ['Report Time:', 'first'],
    ['Report Time:', 'second'], ['Date Range:', 'start', 'end'], ['Date Range:', 'duplicate'],
    ['Group By:', 'one', '', 'two'], [' ', ' ']], {}, {
    header: [' H '], text: '" H "', metadata: { groupBy: ['one', 'two'], filters: [], reportTime: 'first', dateRange: 'start end' },
    notes: ['Unknown: v1; v2', 'MRC Accredited Metrics: Impressions; Clicks', 'Report Time: second', 'Date Range: duplicate'],
  }, []);
});
for (const ending of ['\r\n', '\n', '\r']) {
  test(`CSV tokenizer accepts BOM, quoted cells and ${JSON.stringify(ending)} endings without an extra row`, async () => {
    const bytes = new TextEncoder().encode('\uFEFFH1,H2,H3' + ending + '"a,b","a' + ending + 'b","a""b"' + ending);
    const req: ReportPageRequest = { format: 'CSV', dimensionCount: 0 };
    const page = invariant(await parseReportFile(bytes, req));
    assert.deepEqual(page, expected(bytes, req, ['H1', 'H2', 'H3'], [['a,b', 'a' + ' '.repeat(ending.length) + 'b', 'a"b']], {
      notes: ['The report file has no footer.'],
    }));
  });
}
for (const [name, bytes, reason] of [
  ['unterminated quote', new TextEncoder().encode('H\n"unclosed'), 'csv_unterminated'],
  ['invalid UTF8', new Uint8Array([0xc3, 0x28]), 'not_utf8'],
  ['short data row', googleCsv([['H1', 'H2'], ['one']]), 'row_width'],
  ['wide data row', googleCsv([['H'], ['one', 'two']]), 'row_width'],
  ['empty file', new Uint8Array(), 'no_header'],
  ['empty header', googleCsv([[' ', ''], ['data', 'value']]), 'no_header'],
] as const) {
  test(`CSV rejects ${name}`, async () => {
    await assert.rejects(parseReportFile(bytes, { format: 'CSV', dimensionCount: 0 }), malformed(reason));
  });
}
for (const [name, bytes, format, reason] of [
  ['nonzip XLSX', new Uint8Array([1, 2, 3]), 'XLSX', 'format_mismatch'],
  ['zip missing worksheet', zipSync({ 'empty.txt': strToU8('synthetic') }), 'XLSX', 'xlsx_unreadable'],
  ['CSV declared XLSX', googleCsv(STANDARD), 'XLSX', 'format_mismatch'],
  ['XLSX declared CSV', googleXlsx(STANDARD), 'CSV', 'format_mismatch'],
] as const) {
  test(name, async () => {
    await assert.rejects(parseReportFile(bytes, { format, dimensionCount: 2 }), malformed(reason));
  });
}
const INVALID = [
  ['dimensionCount', [-1, 0.5, NaN, Infinity], 'dimensionCount must be a whole number of 0 or more.'],
  ['offset', [-1, 0.5, NaN, Infinity], 'offset must be a whole number of 0 or more.'],
  ['limit', [0, 1001, 1.5, NaN, Infinity], 'limit must be a whole number from 1 to 1000.'],
  ['maxChars', [999, 50001, 1000.5, NaN, Infinity], 'maxChars must be a whole number from 1000 to 50000.'],
  ['format', ['JSON', 'csv', '', null], 'format must be XLSX or CSV.'],
] as const;
for (const [key, values, message] of INVALID) {
  for (const value of values) {
    test(`both exports reject invalid ${key}=${String(value)} before fetching or parsing`, async () => {
      const request = { format: 'CSV', dimensionCount: 2, [key]: value } as ReportPageRequest;
      let calls = 0;
      const fetch: typeof globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
      await assert.rejects(parseReportFile(new Uint8Array(), request), safeError('invalid_request', { message }));
      await assert.rejects(readReportFile({ ...request, url: LINK }, { fetch }), safeError('invalid_request', { message }));
      assert.equal(calls, 0);
    });
  }
}
for (const url of [
  'http://storage.googleapis.com/report', 'https://example.com/report',
  'https://storage.googleapis.com.example.com/report', 'https://user:pass@storage.googleapis.com/report',
  'https://user@storage.googleapis.com/report', 'https://storage.googleapis.com:444/report', 'not a URL',
]) {
  test(`rejects invalid storage link ${url} without fetching`, async () => {
    let calls = 0;
    await assert.rejects(readReportFile({ url, format: 'CSV', dimensionCount: 2 }, {
      fetch: async () => { calls++; throw new Error('must not fetch'); },
    }), safeError('invalid_link', { message: 'The report file link is not a Google Cloud Storage link.' }, url));
    assert.equal(calls, 0);
  });
}
test('explicit port 443 is accepted with exactly one credential-free GET and abort signal', async () => {
  const bytes = googleCsv(STANDARD);
  const url = LINK.replace('storage.googleapis.com', 'storage.googleapis.com:443');
  const calls: { input: unknown; init: RequestInit | undefined }[] = [];
  const page = invariant(await readReportFile({ url, format: 'CSV', dimensionCount: 2 }, {
    fetch: async (input, init) => { calls.push({ input, init }); return new Response(Buffer.from(bytes)); },
  }));
  assert.deepEqual(page, expected(bytes, { format: 'CSV', dimensionCount: 2 }, HEADER, strings(DATA), standardOverrides));
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].input), url);
  assert.deepEqual(Object.keys(calls[0].init!).sort(), ['method', 'redirect', 'signal']);
  assert.equal(calls[0].init!.method, 'GET');
  assert.equal(calls[0].init!.redirect, 'error');
  assert.ok(calls[0].init!.signal instanceof AbortSignal);
  assert.equal(calls[0].init!.signal.aborted, false);
});
for (const status of [400, 401, 403, 404, 410, 418, 429, 500, 503, 599]) {
  test(`HTTP ${status} cancels unread body, redacts errors and never retries`, async () => {
    let calls = 0;
    let cancelled = false;
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() { pulled = true; }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const expiry = [400, 401, 403, 404, 410].includes(status) ? ' The link may have expired; run the report again.' : '';
    await assert.rejects(readReportFile({ url: LINK, format: 'CSV', dimensionCount: 2 }, {
      fetch: async () => { calls++; return new Response(body, { status }); },
    }), safeError('download_failed', { httpStatus: status, message: `Google's report file could not be downloaded (HTTP ${status}).${expiry}` }));
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.equal(pulled, false);
  });
}
function tooLarge(bytes: number, limitBytes: number) {
  return safeError('too_large', { bytes, limitBytes,
    message: `The report file is too large to preview (${(bytes / 1048576).toFixed(1)} MB, limit ${(limitBytes / 1048576).toFixed(1)} MB). The full file is still available at its link.` });
}
test('oversized Content-Length cancels the body before reading it', async () => {
  let cancelled = false;
  let pulled = false;
  const body = new ReadableStream<Uint8Array>({ pull() { pulled = true; }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await assert.rejects(readReportFile({ url: LINK, format: 'CSV', dimensionCount: 2 }, {
    maxCsvBytes: 10, fetch: async () => new Response(body, { headers: { 'Content-Length': '11' } }),
  }), tooLarge(11, 10));
  assert.equal(cancelled, true);
  assert.equal(pulled, false);
});
test('stream cap cancels the reader at the first oversized chunk', async () => {
  let chunks = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(6)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(readReportFile({ url: LINK, format: 'CSV', dimensionCount: 2 }, {
    maxCsvBytes: 10, fetch: async () => new Response(body),
  }), tooLarge(12, 10));
  assert.equal(chunks, 2);
  assert.equal(cancelled, true);
});
test('download timeout is classified without retaining its original message', async () => {
  await assert.rejects(readReportFile({ url: LINK, format: 'CSV', dimensionCount: 2 }, {
    fetch: async () => { throw new DOMException(LINK, 'TimeoutError'); },
  }), safeError('timeout', { message: "Downloading Google's report file took too long. Try again shortly." }));
});
test('timeout covers body reads and classifies an AbortError using the signal reason', async () => {
  // Keep the event loop alive while the unref-ed AbortSignal.timeout timer fires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(readReportFile({ url: LINK, format: 'CSV', dimensionCount: 2 }, {
      timeoutMs: 5,
      fetch: async (_url, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init!.signal!.addEventListener('abort', () => controller.error(new DOMException(LINK, 'AbortError')), { once: true });
        },
      })),
    }), safeError('timeout', { message: "Downloading Google's report file took too long. Try again shortly." }));
  } finally { clearInterval(keepAlive); }
});
for (const fromBody of [false, true]) {
  test(`network TypeError from ${fromBody ? 'body' : 'fetch'} is redacted`, async () => {
    await assert.rejects(readReportFile({ url: LINK, format: 'CSV', dimensionCount: 2 }, {
      fetch: async () => {
        if (!fromBody) throw new TypeError(LINK);
        return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError(LINK)); } }));
      },
    }), safeError('network', { message: "Could not reach Google's report file storage. Try again shortly." }));
  });
}
function fourMiB(): ReadableStream<Uint8Array> {
  let remaining = 4 * 1024 * 1024;
  let first = true;
  return new ReadableStream({
    pull(controller) {
      if (remaining === 0) { controller.close(); return; }
      const chunk = new Uint8Array(Math.min(65536, remaining)).fill(32);
      if (first) { chunk.set(new TextEncoder().encode('H\nx\n\n')); first = false; }
      remaining -= chunk.length;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
}
test('default XLSX cap rejects a generated four MiB body', async () => {
  await assert.rejects(readReportFile({ url: LINK, format: 'XLSX', dimensionCount: 1 }, {
    fetch: async () => new Response(fourMiB()),
  }), tooLarge(3 * 1024 * 1024 + 65536, 3 * 1024 * 1024));
});
test('default CSV cap accepts the same generated four MiB body', async () => {
  const req: ReportPageRequest = { format: 'CSV', dimensionCount: 1 };
  const page = invariant(await readReportFile({ ...req, url: LINK }, { fetch: async () => new Response(fourMiB()) }));
  assert.deepEqual(page, { ...expected(new Uint8Array(), req, ['H'], [['x']]), fileBytes: 4 * 1024 * 1024 });
});
test('mocked XLSX download returns the exact standard page end to end', async () => {
  const bytes = googleXlsx(STANDARD);
  const req: ReportPageRequest = { format: 'XLSX', dimensionCount: 2 };
  const page = invariant(await readReportFile({ ...req, url: LINK }, { fetch: async () => new Response(Buffer.from(bytes)) }));
  assert.deepEqual(page, expected(bytes, req, HEADER, strings(DATA), standardOverrides));
});
for (const format of ['XLSX', 'CSV'] as const) {
  test(`${format} handles 15000 rows by 17 columns without timing assertions`, async () => {
    const header = Array.from({ length: 17 }, (_, i) => `Column ${i}`);
    const data = Array.from({ length: 15000 }, (_, i) => [String(1000001 + i), ...Array(16).fill(1)]);
    await check([header, ...data, []], { format }, {
      totalRows: 15000, nextOffset: 200, truncated: true, cutBy: 'limit',
    }, strings(data.slice(0, 200)));
  });
}
