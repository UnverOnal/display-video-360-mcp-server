import { readSheet } from 'read-excel-file/node';

export type ReportFileFormat = 'XLSX' | 'CSV';

export type ReportFileErrorKind =
  | 'invalid_request' | 'invalid_link' | 'download_failed'
  | 'timeout' | 'network' | 'too_large' | 'malformed';

export type ReportFileMalformedReason =
  | 'format_mismatch' | 'xlsx_unreadable' | 'not_utf8' | 'csv_unterminated'
  | 'no_header' | 'row_width' | 'dimension_count' | 'too_many_columns';

type ErrorDetails = {
  readonly httpStatus?: number;
  readonly bytes?: number;
  readonly limitBytes?: number;
  readonly reason?: ReportFileMalformedReason;
};

export class ReportFileError extends Error {
  readonly kind: ReportFileErrorKind;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly bytes?: number;
  readonly limitBytes?: number;
  readonly reason?: ReportFileMalformedReason;

  constructor(kind: ReportFileErrorKind, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'ReportFileError';
    this.kind = kind;
    this.retryable = kind === 'timeout' || kind === 'network'
      || (kind === 'download_failed' && details.httpStatus !== undefined
        && (details.httpStatus === 429 || (details.httpStatus >= 500 && details.httpStatus <= 599)));
    if (kind === 'download_failed') this.httpStatus = details.httpStatus;
    if (kind === 'too_large') {
      this.bytes = details.bytes;
      this.limitBytes = details.limitBytes;
    }
    if (kind === 'malformed') this.reason = details.reason;
  }
}

export type ReportPageRequest = {
  readonly format: ReportFileFormat;
  readonly dimensionCount: number;
  readonly offset?: number;
  readonly limit?: number;
  readonly maxChars?: number;
};

export type ReadReportFileRequest = ReportPageRequest & { readonly url: string };

export type ReportFileOptions = {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxXlsxBytes?: number;
  readonly maxCsvBytes?: number;
};

export type ReportMetadata = {
  readonly reportTime?: string;
  readonly dateRange?: string;
  readonly groupBy: readonly string[];
  readonly filters: readonly { readonly label: string; readonly value: string }[];
};

export type ReportPage = {
  readonly format: ReportFileFormat;
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly text: string;
  readonly totalsText?: string;
  readonly totalRows: number;
  readonly offset: number;
  readonly returnedRows: number;
  readonly nextOffset?: number;
  readonly truncated: boolean;
  readonly cutBy?: 'limit' | 'budget';
  readonly cellsShortened: boolean;
  readonly totals?: readonly string[];
  readonly metadata: ReportMetadata;
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
  readonly fileBytes: number;
};

type ValidatedRequest = Required<ReportPageRequest>;

function validateRequest(request: ReportPageRequest): ValidatedRequest {
  const { format, dimensionCount, offset = 0, limit = 200, maxChars = 16_000 } = request;
  if (!Number.isInteger(dimensionCount) || dimensionCount < 0) {
    throw new ReportFileError('invalid_request', 'dimensionCount must be a whole number of 0 or more.');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ReportFileError('invalid_request', 'offset must be a whole number of 0 or more.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ReportFileError('invalid_request', 'limit must be a whole number from 1 to 1000.');
  }
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 50_000) {
    throw new ReportFileError('invalid_request', 'maxChars must be a whole number from 1000 to 50000.');
  }
  if (format !== 'XLSX' && format !== 'CSV') {
    throw new ReportFileError('invalid_request', 'format must be XLSX or CSV.');
  }
  return { format, dimensionCount, offset, limit, maxChars };
}

function malformed(reason: ReportFileMalformedReason): ReportFileError {
  return new ReportFileError('malformed', `Google's report file has an unexpected layout (${reason}).`, { reason });
}

function tooLarge(bytes: number, limitBytes: number): ReportFileError {
  return new ReportFileError('too_large',
    `The report file is too large to preview (${(bytes / 1048576).toFixed(1)} MB, limit ${(limitBytes / 1048576).toFixed(1)} MB). The full file is still available at its link.`,
    { bytes, limitBytes });
}

function errorName(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
}

export async function readReportFile(
  request: ReadReportFileRequest,
  options: ReportFileOptions = {},
): Promise<ReportPage> {
  const validated = validateRequest(request);
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com'
      || url.port !== '' || url.username !== '' || url.password !== '') throw new Error();
  } catch {
    throw new ReportFileError('invalid_link', 'The report file link is not a Google Cloud Storage link.');
  }

  const limitBytes = validated.format === 'XLSX'
    ? (options.maxXlsxBytes ?? 3 * 1024 * 1024)
    : (options.maxCsvBytes ?? 32 * 1024 * 1024);
  const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  let bytes: Uint8Array;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(request.url, {
      method: 'GET', redirect: 'error', signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      const expiry = [400, 401, 403, 404, 410].includes(status)
        ? ' The link may have expired; run the report again.' : '';
      throw new ReportFileError('download_failed',
        `Google's report file could not be downloaded (HTTP ${status}).${expiry}`, { httpStatus: status });
    }
    const length = response.headers.get('Content-Length');
    if (length !== null && Number(length) > limitBytes) {
      await response.body?.cancel().catch(() => {});
      throw tooLarge(Number(length), limitBytes);
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > limitBytes) {
            await reader.cancel().catch(() => {});
            throw tooLarge(size, limitBytes);
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    bytes = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, position);
      position += chunk.length;
    }
  } catch (error) {
    if (error instanceof ReportFileError) throw error;
    const timedOut = errorName(error) === 'TimeoutError'
      || (signal.aborted && errorName(signal.reason) === 'TimeoutError');
    throw new ReportFileError(timedOut ? 'timeout' : 'network', timedOut
      ? "Downloading Google's report file took too long. Try again shortly."
      : "Could not reach Google's report file storage. Try again shortly.");
  }
  return parseReportFile(bytes, validated);
}

function isEmpty(row: readonly string[]): boolean {
  return row.every(cell => cell.trim() === '');
}

function renderCell(cell: string): string {
  return /[,\"]|^ | $/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

function renderRow(row: readonly string[]): string {
  return row.map(renderCell).join(',');
}

function cleanCell(cell: string): string {
  return cell.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

class ReportAssembler {
  private header?: string[];
  private readonly pageRows: string[][] = [];
  private lastRow?: string[];
  private totalRows = 0;
  private inFooter = false;
  private reportTime?: string;
  private dateRange?: string;
  private readonly groupBy: string[] = [];
  private readonly filters: { label: string; value: string }[] = [];
  private readonly warnings: string[] = [];
  private readonly notes: string[] = [];
  private footerChars = 0;
  private footerStopped = false;
  private footerShortened = false;

  constructor(private readonly request: ValidatedRequest) {}

  accept(row: string[]): void {
    if (!this.header) {
      if (isEmpty(row)) throw malformed('no_header');
      if (this.request.dimensionCount > row.length) throw malformed('dimension_count');
      this.header = row;
    } else if (this.inFooter) {
      if (!isEmpty(row)) this.acceptFooter(row);
    } else if (isEmpty(row)) {
      this.inFooter = true;
    } else {
      if (row.length !== this.header.length) throw malformed('row_width');
      if (this.totalRows >= this.request.offset
        && this.totalRows - this.request.offset <= this.request.limit) this.pageRows.push(row);
      this.lastRow = row;
      this.totalRows++;
    }
  }

  // Count strings in their original footer order, keeping a filter atomic.
  private keepFooter(strings: string[]): string[] | undefined {
    if (this.footerStopped) return undefined;
    const capped = strings.map(value => {
      if (value.length <= 300) return value;
      this.footerShortened = true;
      return `${value.slice(0, 299)}…`;
    });
    const length = capped.reduce((sum, value) => sum + value.length, 0);
    if (this.footerChars + length > 3000) {
      this.footerStopped = true;
      this.footerShortened = true;
      return undefined;
    }
    this.footerChars += length;
    return capped;
  }

  private acceptFooter(row: string[]): void {
    if (this.footerStopped) return;
    const trimmed = row.map(cell => cell.trim());
    while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
    const first = trimmed[0] ?? '';
    const values = trimmed.slice(1).filter(cell => cell !== '');
    const label = first.replace(/:$/, '').trim();
    if (label === 'Report Time' && this.reportTime === undefined) {
      const kept = this.keepFooter([values.join(' ')]);
      if (kept) this.reportTime = kept[0];
    } else if (label === 'Date Range' && this.dateRange === undefined) {
      const kept = this.keepFooter([values.join(' ')]);
      if (kept) this.dateRange = kept[0];
    } else if (label === 'Group By') {
      for (const value of values) {
        const kept = this.keepFooter([value]);
        if (kept) this.groupBy.push(kept[0]);
      }
    } else if (label.startsWith('Filter by ')) {
      const kept = this.keepFooter([label.slice(10), values.join(', ')]);
      if (kept) this.filters.push({ label: kept[0], value: kept[1] });
    } else if (first.startsWith('Some rows may be missing')) {
      const kept = this.keepFooter([first + (values.length ? ` ${values.join(', ')}` : '')]);
      if (kept) this.warnings.push(kept[0]);
    } else if (first.startsWith('Reporting numbers from the previous month')) {
      const kept = this.keepFooter([first]);
      if (kept) this.warnings.push(kept[0]);
    } else {
      const kept = this.keepFooter([values.length ? `${label}: ${values.join('; ')}` : first]);
      if (kept) this.notes.push(kept[0]);
    }
  }

  finish(fileBytes: number): ReportPage {
    if (!this.header) throw malformed('no_header');
    let rawTotals: string[] | undefined;
    const { dimensionCount, offset, limit, maxChars, format } = this.request;
    if (dimensionCount > 0 && this.totalRows >= 2 && this.lastRow
      && isEmpty(this.lastRow.slice(0, dimensionCount))) {
      rawTotals = this.lastRow;
      this.totalRows--;
      if (this.totalRows >= offset && this.totalRows - offset <= limit) this.pageRows.pop();
    }
    if (!this.inFooter) this.notes.push('The report file has no footer.');
    if (this.footerShortened) this.notes.push('Some footer lines were shortened.');
    if (offset > this.totalRows) {
      throw new ReportFileError('invalid_request',
        `offset is past the last row (the report has ${this.totalRows} rows).`);
    }

    const n = this.header.length;
    const k = rawTotals ? 3 : 2;
    const cellCap = Math.min(500, Math.floor((maxChars - (k - 1) - k * (n - 1)) / (k * n)));
    if (cellCap < 8) throw malformed('too_many_columns');
    let cellsShortened = false;
    const shortenRow = (row: string[]): { cells: string[]; shortened: boolean } => {
      let shortened = false;
      const cells = row.map(cell => {
        const cleaned = cleanCell(cell);
        if (renderCell(cleaned).length <= cellCap) return cleaned;
        shortened = true;
        // Only prefixes shorter than cellCap can fit, even without escaping.
        // Descending search also handles a trailing space changing quoting.
        for (let length = Math.min(cleaned.length, cellCap - 1); length >= 0; length--) {
          const candidate = `${cleaned.slice(0, length)}…`;
          if (renderCell(candidate).length <= cellCap) return candidate;
        }
        return '…';
      });
      return { cells, shortened };
    };
    const headerResult = shortenRow(this.header);
    const header = headerResult.cells;
    cellsShortened = headerResult.shortened;
    const totalsResult = rawTotals ? shortenRow(rawTotals) : undefined;
    const totals = totalsResult?.cells;
    if (totalsResult?.shortened) cellsShortened = true;
    const totalsText = totals ? renderRow(totals) : undefined;
    let text = renderRow(header);
    const budget = maxChars - (totalsText ? 1 + totalsText.length : 0);
    const rows: string[][] = [];
    let cutBy: 'limit' | 'budget' | undefined;
    for (const row of this.pageRows) {
      if (rows.length === limit) {
        cutBy = 'limit';
        break;
      }
      const result = shortenRow(row);
      const line = renderRow(result.cells);
      if (text.length + 1 + line.length > budget) {
        cutBy = 'budget';
        break;
      }
      text += `\n${line}`;
      rows.push(result.cells);
      if (result.shortened) cellsShortened = true;
    }
    const nextOffset = offset + rows.length < this.totalRows ? offset + rows.length : undefined;
    return {
      format, header, rows, text,
      ...(totals ? { totals, totalsText } : {}),
      totalRows: this.totalRows, offset, returnedRows: rows.length,
      ...(nextOffset !== undefined ? { nextOffset, cutBy } : {}),
      truncated: nextOffset !== undefined, cellsShortened,
      metadata: {
        ...(this.reportTime !== undefined ? { reportTime: this.reportTime } : {}),
        ...(this.dateRange !== undefined ? { dateRange: this.dateRange } : {}),
        groupBy: this.groupBy, filters: this.filters,
      },
      warnings: this.warnings, notes: this.notes, fileBytes,
    };
  }
}

function tokenizeCsv(text: string, accept: (row: string[]) => void): void {
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let rowStarted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    rowStarted = true;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' || char === '\n') {
      row.push(cell);
      accept(row);
      row = [];
      cell = '';
      rowStarted = false;
      if (char === '\r' && text[index + 1] === '\n') index++;
    } else cell += char;
  }
  if (quoted) throw malformed('csv_unterminated');
  if (rowStarted) {
    row.push(cell);
    accept(row);
  }
}

export async function parseReportFile(bytes: Uint8Array, request: ReportPageRequest): Promise<ReportPage> {
  const validated = validateRequest(request);
  const assembler = new ReportAssembler(validated);
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (validated.format === 'XLSX') {
    if (!zipped) throw malformed('format_mismatch');
    let sheet;
    try {
      sheet = await readSheet(Buffer.from(bytes), { parseNumber: value => value, trim: false });
    } catch {
      throw malformed('xlsx_unreadable');
    }
    for (const row of sheet) {
      assembler.accept(row.map(cell => {
        if (cell === null) return '';
        if (cell instanceof Date) return cell.toISOString();
        if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
        return String(cell);
      }));
    }
  } else {
    if (zipped) throw malformed('format_mismatch');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw malformed('not_utf8');
    }
    if (text.startsWith('\ufeff')) text = text.slice(1);
    tokenizeCsv(text, row => assembler.accept(row));
  }
  return assembler.finish(bytes.length);
}
