import { runWithoutLogging, type ToolCall, type ToolRunner } from './call.js';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
  REPORT_TYPES, catalogFor, SCOPE_RULES, REQUIRED_DIMENSIONS, MULTI_ID_FILTER_TYPES,
  type ReportType,
} from '../integrations/bidmanager/fields.js';
import {
  DATE_PRESETS, safeErrorMessage, type ReportingService, type StartedReport,
  type CollectResult, type SavedQueryList, type ListSavedRequest,
} from '../integrations/bidmanager/reporting.js';

const descriptions = {
  "list_report_fields": "Lists the dimensions, filters, and metrics a DV360 report type accepts, with Google's codes, names, and usage notes, plus the type's rules (required partner filter, required dimensions). Call it before run_report: run_report accepts only these codes. Makes no Google API call.",
  "run_report": "Starts a DV360 performance report (Bid Manager) and returns a ticket at once. Then call get_report with the ticket to collect it; reports take from seconds to hours.\nUse codes from list_report_fields for the chosen type. Filters take numeric IDs (e.g. {type: \"FILTER_PARTNER\", value: \"123\"}); find IDs by name with find_entities, or drill down with the list tools.\nChoose the coarsest grouping that answers the question: Google computes exact totals for whatever you group by, so run a grouped report for totals instead of adding up rows.\nDates are in each advertiser's time zone. The default file is XLSX; ask for CSV only when the user wants CSV.\nEach run uses shared Google quota. Do not start the same report twice; call get_report on the existing ticket instead.",
  "run_saved_report": "Runs one of the server's Google account's saved DV360 reports (find its ID with list_saved_reports) for a new date range, and returns a ticket at once; then call get_report. Without dateRange, the saved range is used. The saved report is never changed: if it was saved in a different format than requested, or is set to email people when it finishes, a temporary [MCP] copy is run instead.\nOnly reports created by the server's Google account are visible.",
  "get_report": "Checks a report started by run_report or run_saved_report and, when it is done, returns the link to the full file and a preview of its rows. While the report is running it waits about 20 seconds, then says to call again. Use offset to page through rows.\nRules for reading the numbers:\n- Always give the user the file link; the preview is often only part of the report.\n- Never add up money across currencies. Use the USD metrics, or group by Advertiser Currency.\n- Revenue is what the client is billed; media cost is what the media cost. They are different.\n- Rates (CTR, completion rate, view rate, eCPM, eCPC, eCPA, eCPV, % viewable) are never added or averaged; recompute them from their counts.\n- Unique reach and average frequency are never added across rows; run a report at the level you need.\n- Never compute totals from a preview that is cut off; run a grouped report instead.\n- Numbers for the previous month can still change for up to 7 days.",
  "list_saved_reports": "Lists the saved DV360 reports of the server's Google account (ID, title, type, format, date range), sorted by title. The server's own temporary [MCP] reports are left out unless includeMcp is true. Reports that other people created under their own accounts are not visible. Use titleContains to search, and pageToken to continue."
} as const;

const FILE_LINK = "Full report file (Google's signed link, valid for about 4 months; anyone with the link can open the report, so share it like the file itself):";
const SHORTENED = 'Some footer lines were shortened.';

export function renderStarted(report: StartedReport): string {
  const reason = report.copyReason === 'notifications'
    ? 'it is set to email people when it finishes, and the copy sends no emails'
    : `it is saved as ${report.savedFormat || 'an unspecified format'}`;
  const source = report.source === 'new' ? 'a new [MCP] query'
    : report.source === 'saved' ? `saved report ${report.savedQueryId}, run as it is`
      : `a temporary [MCP] copy of saved report ${report.savedQueryId}, because ${reason}; the saved report was not changed`;
  return [
    `Report started: ${source}.`,
    `Ticket: queryId ${report.ticket.queryId}, reportId ${report.ticket.reportId}. State: ${report.state}. Format: ${report.format}.`,
    `Query title: ${report.title}`,
    ...report.warnings.map(warning => `Warning: ${warning}`),
    'Next: call get_report with this queryId and reportId.',
  ].join('\n');
}

export function renderProblems(problems: readonly string[]): string {
  return ['The report was not started. Fix these and try again:', ...problems.map(problem => `- ${problem}`)].join('\n');
}

export function renderCollected(result: CollectResult): string {
  const { queryId, reportId } = result.ticket;
  if (result.status === 'pending') {
    return `Report ${reportId} (query ${queryId}) is still ${result.state} after waiting ${Math.round(result.waitedMs / 1000)} s in this call. Call get_report again with the same IDs. Do not start the report again.`;
  }
  if (result.status === 'failed') {
    return `Google could not produce report ${reportId} (query ${queryId}); its state is FAILED and Google gives no reason. Check the fields and date range, or try a shorter range, then start a new report.`;
  }
  if (result.status === 'done_no_preview') {
    return [
      `Report ${reportId} (query ${queryId}) is done, but the preview could not be read: ${result.message}`,
      ...(result.url ? [FILE_LINK, result.url] : []),
      ...(result.reason === 'too_large' ? ['For questions, run a grouped report with fewer dimensions or a shorter date range; its preview will fit.'] : []),
    ].join('\n');
  }
  const { page } = result;
  const { metadata } = page;
  return [
    `Report ${reportId} (query ${queryId}) is done. File format: ${result.format}.`,
    FILE_LINK, result.url,
    ...(metadata.dateRange ? [`Date range: ${metadata.dateRange}`] : []),
    ...(metadata.reportTime ? [`Report time: ${metadata.reportTime}`] : []),
    ...(metadata.groupBy.length ? [`Group by: ${metadata.groupBy.join(', ')}`] : []),
    ...(metadata.filters.length ? [`Filters: ${metadata.filters.map(filter => `${filter.label}: ${filter.value}`).join('; ')}${page.notes.includes(SHORTENED) ? ' (shortened; the file has the full lists)' : ''}`] : []),
    page.returnedRows > 0
      ? `Rows: ${page.totalRows} data rows in the report. This page: rows ${page.offset + 1}–${page.offset + page.returnedRows} (${page.returnedRows} rows).`
      : `Rows: ${page.totalRows} data rows in the report. This page has no rows.`,
    ...(page.nextOffset !== undefined ? [`More rows: call get_report with offset ${page.nextOffset}. This preview is partial: do not compute totals from it; run a grouped report instead.`] : []),
    ...(page.cellsShortened ? ['Some long cells are shortened with "…" here; the file has them in full.'] : []),
    ...page.warnings.map(warning => `Warning: ${warning}`),
    ...page.notes.filter(note => note !== SHORTENED).map(note => `Note: ${note}`),
    `Values are exactly as in the file. ${result.format === 'XLSX' ? 'Rates (CTR, completion rate, view rate, % viewable) are fractions here (0.0057 means 0.57%).' : 'Rates (CTR, completion rate, view rate, % viewable) are percent strings here (for example 0.57%).'} Amounts in advertiser currency mix currencies unless grouped by Advertiser Currency.`,
    ...(result.reportType === 'REACH' ? ['REACH reports have no totals row: Google does not add up unique reach. For total reach, run the report without the breakdown dimensions.'] : []),
    ...(page.totalRows > 0 ? ['Preview (CSV, first line is the header):', page.text] : []),
    ...(page.totalsText !== undefined ? ["Totals row (Google's own, same columns; an empty cell means Google did not total that column, e.g. amounts in mixed currencies: leave it empty, don't fill it in):", page.totalsText] : []),
  ].join('\n');
}

export function renderSavedList(result: SavedQueryList, request: ListSavedRequest = {}): string {
  return [
    `Saved reports of the server's Google account${request.titleContains ? ` matching "${request.titleContains}"` : ''} (${result.queries.length} shown):`,
    ...result.queries.map(query => `- ${query.queryId} · ${query.title} · ${query.type ?? '?'} · ${query.format ?? '?'} · ${query.range ?? '?'}${query.frequency && query.frequency !== 'ONE_TIME' ? ` · ${query.frequency}` : ''}`),
    ...(!result.queries.length ? ['No saved reports found in this part of the list.'] : []),
    ...(result.nextPageToken ? [`More saved reports follow: call list_saved_reports with pageToken "${result.nextPageToken}"${request.titleContains ? ' and the same titleContains' : ''}.`] : []),
    'Run one with run_saved_report and its ID.',
  ].join('\n');
}

export function renderFields(type: ReportType): string {
  const catalog = catalogFor(type);
  const filterOnly = catalog.filters.filter(filter => !catalog.dimensions.some(dimension => dimension.code === filter.code));
  return [
    `${type} report fields. Use the codes with run_report.`,
    `Rule: ${SCOPE_RULES[type] === 'none' ? 'No partner filter is needed.' : 'Exactly one FILTER_PARTNER filter is required.'}`,
    ...(MULTI_ID_FILTER_TYPES.includes(type) ? ['Rule: several IDs for one filter act as alternatives (OR).'] : []),
    'Dimensions (code · name[ · filterable by ID][ · note]):',
    ...catalog.dimensions.map(dimension => `- ${dimension.code} · ${dimension.name}${dimension.filterTypes.includes(type) ? ' · filterable by ID' : ''}${dimension.note ? ` · ${dimension.note}` : ''}`),
    ...(filterOnly.length ? [`Filter-only codes (not groupable in ${type}): ${filterOnly.map(filter => `${filter.code} · ${filter.name}`).join(', ')}`] : []),
    'Metrics (code · name[ · needs <dimension>][ · note]):',
    ...catalog.metrics.map(metric => {
      const required = REQUIRED_DIMENSIONS[type][metric.code];
      return `- ${metric.code} · ${metric.name}${required?.length ? ` · needs ${required.join(', ')}` : ''}${metric.note ? ` · ${metric.note}` : ''}`;
    }),
    ...(type === 'YOUTUBE' ? ['YOUTUBE has no Date, Week, or Month dimension and no partner grouping yet.'] : []),
  ].join('\n');
}

export function registerReportTools(server: McpServer, reporting: ReportingService, run: ToolRunner = runWithoutLogging): void {
  const id = z.string().regex(/^[0-9]{1,20}$/);
  const dateRange = z.object({
    preset: z.enum(DATE_PRESETS).optional(),
    startDate: z.string().max(10).optional(), endDate: z.string().max(10).optional(),
  }).strict();
  const format = z.enum(['XLSX', 'CSV']).optional();
  const readOnly = { readOnlyHint: true, openWorldHint: true };
  const runAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const textResult = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });
  const handle = (tool: string, operation: (call: ToolCall) => Promise<{ text: string; isError?: boolean }>) =>
    run(tool, async call => {
      try { const result = await operation(call); return textResult(result.text, result.isError); }
      catch (error) { call.failed(error); return textResult(safeErrorMessage(error), true); }
    });
  server.registerTool('list_report_fields', {
    title: 'List report fields', description: descriptions.list_report_fields,
    inputSchema: z.object({ type: z.enum(REPORT_TYPES) }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, args => handle('list_report_fields', async () => ({ text: renderFields(args.type) })));
  server.registerTool('run_report', {
    title: 'Start a report', description: descriptions.run_report,
    inputSchema: z.object({
      type: z.enum(REPORT_TYPES), dimensions: z.array(z.string().max(100)).min(1).max(27),
      metrics: z.array(z.string().max(100)).min(1).max(35),
      filters: z.array(z.object({ type: z.string().max(100), value: z.string().max(20) }).strict()).max(20).optional(),
      dateRange, format, name: z.string().max(200).optional(),
    }).strict(), annotations: runAnnotations,
  }, (args, ctx) => handle('run_report', async call => {
    const result = await reporting.startAdHocReport({ ...args, signal: ctx.mcpReq.signal, callId: call.callId });
    return result.ok ? { text: renderStarted(result.report) } : { text: renderProblems(result.problems), isError: true };
  }));
  server.registerTool('run_saved_report', {
    title: 'Start a saved report', description: descriptions.run_saved_report,
    inputSchema: z.object({ queryId: id, dateRange: dateRange.optional(), format }).strict(), annotations: runAnnotations,
  }, (args, ctx) => handle('run_saved_report', async call => {
    const result = await reporting.startSavedReport({ ...args, signal: ctx.mcpReq.signal, callId: call.callId });
    return result.ok ? { text: renderStarted(result.report) } : { text: renderProblems(result.problems), isError: true };
  }));
  server.registerTool('get_report', {
    title: 'Get a report', description: descriptions.get_report,
    inputSchema: z.object({ queryId: id, reportId: id, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
    annotations: readOnly,
  }, (args, ctx) => handle('get_report', async call => {
    const result = await reporting.collectReport({ ...args, signal: ctx.mcpReq.signal, callId: call.callId });
    if (result.status === 'done_no_preview') call.note(result.reason);
    return { text: renderCollected(result), isError: result.status === 'failed' || (result.status === 'done_no_preview' && !result.url) };
  }));
  server.registerTool('list_saved_reports', {
    title: 'List saved reports', description: descriptions.list_saved_reports,
    inputSchema: z.object({ titleContains: z.string().max(100).optional(), includeMcp: z.boolean().optional(), pageToken: z.string().max(2000).optional() }).strict(),
    annotations: readOnly,
  }, (args, ctx) => handle('list_saved_reports', async call => ({
    text: renderSavedList(await reporting.listSavedQueries({ ...args, signal: ctx.mcpReq.signal, callId: call.callId }), args),
  })));
}
