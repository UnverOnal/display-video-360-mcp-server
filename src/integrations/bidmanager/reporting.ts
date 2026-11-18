import { GoogleCredentialsError } from '../google/auth.js';
import type { CallOptions } from '../google/request.js';
import { BidManagerError } from './errors.js';
import { validateReportFields } from './fields.js';
import { readReportFile, ReportFileError } from './report-file.js';
import { buildMcpTitle } from './titles.js';
import type { BidManagerClient, ReportState, DataRange, Query, Report } from './client.js';
import type { QueryCleanup } from './cleanup.js';
import type { ReportPage, ReportFileErrorKind, ReadReportFileRequest, ReportFileOptions } from './report-file.js';
import type { ReportType } from './fields.js';

export const DATE_PRESETS = Object.freeze([
  'PREVIOUS_DAY', 'CURRENT_DAY', 'LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'LAST_60_DAYS',
  'LAST_90_DAYS', 'LAST_365_DAYS', 'WEEK_TO_DATE', 'MONTH_TO_DATE', 'QUARTER_TO_DATE',
  'YEAR_TO_DATE', 'PREVIOUS_WEEK', 'PREVIOUS_MONTH', 'PREVIOUS_QUARTER', 'PREVIOUS_YEAR',
] as const);
export type DatePreset = (typeof DATE_PRESETS)[number];
export type ReportFormat = 'XLSX' | 'CSV';

export type DateRangeInput = {
  readonly preset?: DatePreset;
  readonly startDate?: string;   // YYYY-MM-DD
  readonly endDate?: string;     // YYYY-MM-DD
};

export type ReportTicket = { readonly queryId: string; readonly reportId: string };

export type AdHocReportRequest = {
  readonly deadline?: number;
  readonly type: ReportType;
  readonly dimensions: readonly string[];
  readonly metrics: readonly string[];
  readonly filters?: readonly { readonly type: string; readonly value: string }[];
  readonly dateRange: DateRangeInput;
  readonly format?: ReportFormat;   // default 'XLSX'
  readonly name?: string;           // becomes the [MCP] title description
  readonly signal?: AbortSignal;
  readonly callId?: string;
};

export type SavedReportRequest = {
  readonly queryId: string;
  readonly dateRange?: DateRangeInput; // omitted: the saved query's own range
  readonly format?: ReportFormat;      // default 'XLSX'
  readonly signal?: AbortSignal;
  readonly callId?: string;
};

export type StartedReport = {
  readonly ticket: ReportTicket;
  readonly state: ReportState;
  readonly title: string;              // title of the query that was run
  readonly format: ReportFormat;
  readonly source: 'new' | 'saved' | 'saved_copy';
  readonly savedQueryId?: string;      // saved and saved_copy only
  readonly savedFormat?: string;       // saved_copy only: the saved query's metadata.format, if a string
  readonly copyReason?: 'format' | 'notifications';
  readonly warnings: readonly string[];
};

export type StartResult =
  | { readonly ok: true; readonly report: StartedReport }
  | { readonly ok: false; readonly problems: readonly string[] };   // local validation only; no Google call made

export type CollectRequest = ReportTicket & {
  readonly waitBudgetMs?: number;
  readonly offset?: number;   // default 0
  readonly limit?: number;    // default 200, 1–200
  readonly signal?: AbortSignal;
  readonly callId?: string;
};

export type CollectResult =
  | { readonly status: 'pending'; readonly ticket: ReportTicket; readonly state: ReportState; readonly waitedMs: number }
  | { readonly status: 'failed'; readonly ticket: ReportTicket }
  | { readonly status: 'done'; readonly ticket: ReportTicket; readonly reportType?: string;
      readonly format: ReportFormat; readonly url: string; readonly page: ReportPage }
  | { readonly status: 'done_no_preview'; readonly ticket: ReportTicket; readonly reportType?: string;
      readonly format: ReportFormat; readonly url?: string; readonly reason: ReportFileErrorKind | 'busy' | 'deferred';
      readonly message: string };

export type SavedQuerySummary = {
  readonly queryId: string;
  readonly title: string;          // cut to 120 characters with "…"
  readonly type?: string;
  readonly format?: string;
  readonly range?: string;         // metadata.dataRange.range
  readonly frequency?: string;     // schedule.frequency
};

export type SavedQueryList = {
  readonly queries: readonly SavedQuerySummary[];   // at most 100; always the matches of whole API pages
  readonly pagesRead: number;                        // 1–3 pages whose matches are returned
  readonly nextPageToken?: string;                   // continues exactly after the last returned page (§5.6)
};

export type ListSavedRequest = {
  readonly titleContains?: string;   // case-insensitive per foldTitle (§5.6), trimmed
  readonly includeMcp?: boolean;     // default false
  readonly pageToken?: string;
  readonly signal?: AbortSignal;
  readonly callId?: string;
};

export type ReportingDependencies = {
  readonly client: Pick<BidManagerClient, 'createQuery' | 'runQuery' | 'getQuery' | 'listQueries' | 'getReport' | 'listReports'>;
  readonly cleanup: QueryCleanup;
  readonly readReportFile?: (request: ReadReportFileRequest, options?: ReportFileOptions) => Promise<ReportPage>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;  // resolves early (no throw) on abort
  readonly random?: () => number;                                        // [0, 1)
};

export type ReportingService = {
  startAdHocReport(request: AdHocReportRequest): Promise<StartResult>;
  startSavedReport(request: SavedReportRequest): Promise<StartResult>;
  collectReport(request: CollectRequest): Promise<CollectResult>;
  listSavedQueries(request: ListSavedRequest): Promise<SavedQueryList>;
};

export const TOOL_BUDGET_MS = 45_000;
const WAITS_MS = [5000, 10000, 20000];
const JITTER_MS = 1000;
const WAIT_BUDGET_MS = 40000;
const READ_START_LIMIT_MS = 40000;
const DOWNLOAD_TIMEOUT_MS = 20000;
const PAGE_LIMIT_DEFAULT = 200;
const PAGE_LIMIT_MAX = 200;
const MAX_CONCURRENT_READS = 2;
const RECOVERY_PAGE_SIZE = 10;
const RECOVERY_TIMEOUT_MS = 10_000;
const AMBIGUOUS_RUN_KINDS: readonly string[] = ['timeout', 'network', 'server_error'];
const RECOVERED_WARNING = 'Google did not confirm the start in time; this report was found by looking it up.';
const RECOVERED_SAVED_WARNING = 'Google did not confirm the start in time; this is the report now running for the saved query (it may be one someone else started).';
const NOT_STARTED_MESSAGE = 'Google did not confirm that the report started, and no report was found for it. Starting it again is safe.';
const MAY_HAVE_STARTED_MESSAGE = 'Google did not confirm that the report started, and this could not be checked. It may still be running: wait a few minutes before starting it again, to avoid running it twice.';

export function toDataRange(input: DateRangeInput): { ok: true; dataRange: DataRange } | { ok: false; problem: string } {
  const fail = (problem: string) => ({ ok: false as const, problem });
  const { preset, startDate, endDate } = input;
  if (preset !== undefined && (startDate !== undefined || endDate !== undefined)) return fail('Use either a preset or startDate and endDate, not both.');
  if (preset !== undefined) {
    if (!DATE_PRESETS.includes(preset)) return fail('Give a date range: a preset, or both startDate and endDate.');
    return { ok: true, dataRange: { range: preset } };
  }
  if (startDate === undefined && endDate === undefined) return fail('Give a date range: a preset, or both startDate and endDate.');
  if (startDate === undefined || endDate === undefined) return fail('Give both startDate and endDate.');
  const dates = [];
  for (const [field, value] of [['startDate', startDate], ['endDate', endDate]] as const) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || year < 2000 || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      return fail(`${field} must be a real date written YYYY-MM-DD.`);
    }
    dates.push({ year, month, day });
  }
  if (startDate > endDate) return fail('startDate must not be after endDate.');
  return { ok: true, dataRange: { range: 'CUSTOM_DATES', customStartDate: dates[0], customEndDate: dates[1] } };
}

export function safeErrorMessage(error: unknown): string {
  return error instanceof BidManagerError || error instanceof GoogleCredentialsError || error instanceof ReportFileError
    ? error.message : "Unexpected server error. Try again; if it keeps happening, report it to the server's maintainer.";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
function pending(report: Report): boolean {
  return ['QUEUED', 'RUNNING', 'STATE_UNSPECIFIED'].includes(report.metadata.status.state);
}
function foldTitle(title: string): string { return title.replace(/[İIı]/g, 'i').toLowerCase(); }

export function createReportingService(dependencies: ReportingDependencies): ReportingService {
  const { client, cleanup } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const wait = dependencies.sleep ?? sleep;
  const random = dependencies.random ?? Math.random;
  const read = dependencies.readReportFile ?? readReportFile;
  let reads = 0;

  // A run that failed ambiguously (timeout, network, 5xx) may still have started; look before answering.
  async function runQuery(
    queryId: string, dataRange: DataRange | undefined, call: CallOptions, inPlace: boolean,
  ): Promise<{ readonly report: Report; readonly warning?: string }> {
    try {
      return { report: await client.runQuery(queryId, dataRange ? { dataRange } : undefined, call) };
    } catch (error) {
      if (!(error instanceof BidManagerError) || !AMBIGUOUS_RUN_KINDS.includes(error.kind)) throw error;
      const lookupCall: CallOptions = { signal: call.signal, singleAttempt: true, timeoutMs: RECOVERY_TIMEOUT_MS, ...(call.callId === undefined ? {} : { callId: call.callId }) };
      let reports: readonly Report[];
      try {
        reports = (await client.listReports(queryId, inPlace
          ? { pageSize: RECOVERY_PAGE_SIZE, orderBy: 'key.reportId desc' } : { pageSize: RECOVERY_PAGE_SIZE }, lookupCall)).reports;
      } catch {
        throw new BidManagerError(error.kind, MAY_HAVE_STARTED_MESSAGE, error.diagnostics);
      }
      if (!inPlace) {
        // A fresh [MCP] query has no older reports: any report is this run.
        if (reports.length === 0) throw new BidManagerError(error.kind, NOT_STARTED_MESSAGE, error.diagnostics);
        return { report: reports[0], warning: RECOVERED_WARNING };
      }
      // A saved query has older reports, so only a single unfinished one can be taken as this run.
      const running = reports.filter(report => report.metadata.status.state === 'QUEUED' || report.metadata.status.state === 'RUNNING');
      if (running.length !== 1) throw new BidManagerError(error.kind, MAY_HAVE_STARTED_MESSAGE, error.diagnostics);
      return { report: running[0], warning: RECOVERED_SAVED_WARNING };
    }
  }

  async function started(
    query: Query, run: { readonly report: Report; readonly warning?: string }, format: ReportFormat,
    source: StartedReport['source'], call: CallOptions, savedQuery?: Query,
  ): Promise<StartResult> {
    const { report } = run;
    const cleaned = await cleanup.run(call);
    // Saved copies are created for a format mismatch or notification settings; report format first if both apply.
    const reason: StartedReport['copyReason'] = savedQuery?.metadata.format !== format ? 'format' : 'notifications';
    return { ok: true, report: {
      ticket: { queryId: query.queryId, reportId: report.key.reportId }, state: report.metadata.status.state,
      title: query.metadata.title, format, source,
      warnings: run.warning === undefined ? cleaned.warnings : [run.warning, ...cleaned.warnings],
      ...(savedQuery ? { savedQueryId: savedQuery.queryId } : {}),
      ...(source === 'saved_copy' && typeof savedQuery?.metadata.format === 'string' ? { savedFormat: savedQuery.metadata.format } : {}),
      ...(source === 'saved_copy' ? { copyReason: reason } : {}),
    } };
  }

  return {
    async startAdHocReport(request) {
      const call: CallOptions = { signal: request.signal, deadline: Math.min(now().getTime() + TOOL_BUDGET_MS, request.deadline ?? Infinity), ...(request.callId === undefined ? {} : { callId: request.callId }) };
      const range = toDataRange(request.dateRange);
      const fields = validateReportFields(request);
      const problems = [...(!range.ok ? [range.problem] : []), ...(!fields.ok ? fields.problems : [])];
      if (!range.ok || !fields.ok) return { ok: false, problems };
      const format = request.format ?? 'XLSX';
      const query = await client.createQuery({
        metadata: { title: buildMcpTitle(request.name ?? `${request.type} report`, now()), dataRange: range.dataRange, format, sendNotification: false },
        params: fields.params, schedule: { frequency: 'ONE_TIME' },
      }, call);
      return started(query, await runQuery(query.queryId, undefined, call, false), format, 'new', call);
    },
    async startSavedReport(request) {
      const call: CallOptions = { signal: request.signal, deadline: now().getTime() + TOOL_BUDGET_MS, ...(request.callId === undefined ? {} : { callId: request.callId }) };
      const range = request.dateRange === undefined ? undefined : toDataRange(request.dateRange);
      if (range && !range.ok) return { ok: false, problems: [range.problem] };
      const dataRange = range?.ok ? range.dataRange : undefined;
      const saved = await client.getQuery(request.queryId, call);
      const format = request.format ?? 'XLSX';
      const notifications = saved.metadata.sendNotification === true
        || (Array.isArray(saved.metadata.shareEmailAddress) && saved.metadata.shareEmailAddress.length > 0);
      if (saved.metadata.format === format && !notifications) {
        return started(saved, await runQuery(saved.queryId, dataRange, call, true), format, 'saved', call, saved);
      }
      const copyRange = dataRange ?? saved.metadata.dataRange;
      if (!saved.params || typeof saved.params !== 'object' || Array.isArray(saved.params) || !copyRange) throw new BidManagerError('unexpected_response');
      const copy = await client.createQuery({
        metadata: { title: buildMcpTitle(`Copy of ${saved.metadata.title}`, now()), dataRange: copyRange, format, sendNotification: false },
        params: saved.params, schedule: { frequency: 'ONE_TIME' },
      }, call);
      return started(copy, await runQuery(copy.queryId, undefined, call, false), format, 'saved_copy', call, saved);
    },
    async collectReport(request) {
      const { queryId, reportId, offset = 0, limit = PAGE_LIMIT_DEFAULT, signal } = request;
      if (!Number.isInteger(offset) || offset < 0) throw new BidManagerError('invalid_request', 'offset must be a whole number of 0 or more.');
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) throw new BidManagerError('invalid_request', 'limit must be a whole number from 1 to 200.');
      const waitBudgetMs = request.waitBudgetMs ?? WAIT_BUDGET_MS;
      if (!Number.isInteger(waitBudgetMs) || waitBudgetMs < 0 || waitBudgetMs > WAIT_BUDGET_MS) throw new BidManagerError('invalid_request', 'waitBudgetMs must be a whole number from 0 to 40000.');
      const readStartLimitMs = request.waitBudgetMs === undefined ? READ_START_LIMIT_MS : waitBudgetMs + 5_000;
      const ticket = { queryId, reportId };
      const start = now().getTime();
      const elapsed = () => now().getTime() - start;
      const pollCall: CallOptions = { signal, deadline: start + waitBudgetMs, ...(request.callId === undefined ? {} : { callId: request.callId }) };
      const queryCall: CallOptions = { signal, deadline: start + readStartLimitMs, ...(request.callId === undefined ? {} : { callId: request.callId }) };
      let report = await client.getReport(queryId, reportId, pollCall);
      for (const ms of WAITS_MS) {
        if (!pending(report) || signal?.aborted) break;
        const delay = ms + Math.floor(random() * JITTER_MS);
        if (elapsed() + delay > waitBudgetMs) break;
        await wait(delay, signal);
        if (signal?.aborted) break;
        report = await client.getReport(queryId, reportId, pollCall);
      }
      if (pending(report)) return { status: 'pending', ticket, state: report.metadata.status.state, waitedMs: elapsed() };
      if (report.metadata.status.state === 'FAILED') return { status: 'failed', ticket };
      const { format } = report.metadata.status;
      const url = report.metadata.googleCloudStoragePath;
      if ((format !== 'CSV' && format !== 'XLSX') || !url) throw new BidManagerError('unexpected_response');
      let reportType = typeof report.params?.type === 'string' ? report.params.type : undefined;
      const deferred = (): CollectResult => ({ status: 'done_no_preview', ticket, format, url, reportType, reason: 'deferred', message: 'This call ran out of time before reading the file. Call get_report again with the same IDs for the preview.' });
      if (elapsed() > readStartLimitMs) return deferred();
      let groupBys = report.params?.groupBys;
      if (!Array.isArray(groupBys)) {
        const query = await client.getQuery(queryId, queryCall);
        groupBys = query.params?.groupBys;
        if (!Array.isArray(groupBys)) throw new BidManagerError('unexpected_response');
        if (reportType === undefined && typeof query.params?.type === 'string') reportType = query.params.type;
        if (elapsed() > readStartLimitMs) return deferred();
      }
      if (reads >= MAX_CONCURRENT_READS) return { status: 'done_no_preview', ticket, format, url, reportType, reason: 'busy', message: 'The server is reading other reports right now. Call get_report again in a moment for the preview.' };
      reads++;
      try {
        const page = await read({ url, format, dimensionCount: groupBys.length, offset, limit }, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
        return { status: 'done', ticket, format, url, reportType, page };
      } catch (error) {
        if (!(error instanceof ReportFileError)) throw error;
        const hideUrl = error.kind === 'invalid_link' || (error.kind === 'download_failed' && [400, 401, 403, 404, 410].includes(error.httpStatus ?? 0));
        return { status: 'done_no_preview', ticket, format, reportType, ...(!hideUrl ? { url } : {}), reason: error.kind, message: error.message };
      } finally { reads--; }
    },
    async listSavedQueries(request) {
      const call: CallOptions = { signal: request.signal, deadline: now().getTime() + TOOL_BUDGET_MS, ...(request.callId === undefined ? {} : { callId: request.callId }) };
      const queries: SavedQuerySummary[] = [];
      let pagesRead = 0;
      let pageToken = request.pageToken;
      const search = foldTitle(request.titleContains?.trim() ?? '');
      for (let i = 0; i < 3; i++) {
        const page = await client.listQueries({ pageSize: 100, orderBy: 'metadata.title', pageToken }, call);
        const matches = page.queries.filter(query => (request.includeMcp || !query.metadata.title.startsWith('[MCP] ')) && foldTitle(query.metadata.title).includes(search));
        if (queries.length + matches.length > 100) return { queries, pagesRead, nextPageToken: pageToken };
        for (const query of matches) {
          const clean = query.metadata.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
          const summary: SavedQuerySummary = { queryId: query.queryId, title: clean.length > 120 ? clean.slice(0, 119) + '…' : clean,
            ...(typeof query.params?.type === 'string' ? { type: query.params.type } : {}),
            ...(typeof query.metadata.format === 'string' ? { format: query.metadata.format } : {}),
            ...(typeof query.metadata.dataRange?.range === 'string' ? { range: query.metadata.dataRange.range } : {}),
            ...(typeof query.schedule?.frequency === 'string' ? { frequency: query.schedule.frequency } : {}),
          };
          queries.push(summary);
        }
        pagesRead++;
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
      return { queries, pagesRead, ...(pageToken ? { nextPageToken: pageToken } : {}) };
    },
  };
}
