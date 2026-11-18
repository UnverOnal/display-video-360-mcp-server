import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { runWithoutLogging, type ToolRunner } from './call.js';
import { DATE_PRESETS } from '../integrations/bidmanager/reporting.js';
import { safeErrorMessage, type PerformanceService, type PerformanceResult, type ResolvedLevel } from '../combined/performance.js';
import { PRESETS, BREAKDOWNS, type PresetName } from '../combined/presets.js';
import { renderFind } from './metadata.js';
import { renderCollected, renderStarted } from './reports.js';

const DESCRIPTION = "Answers \"how is <advertiser / campaign / insertion order / line item> doing\" in one call: finds the entity by name or ID, shows its status, flight, and budget, starts a DV360 report for it, and waits up to 20 seconds for the rows. If the report isn't ready by then, it returns a ticket: call get_report with it, and don't call get_performance again for the same question.\nGive the advertiser (advertiserId or advertiserName), and optionally one campaign, insertion order, or line item below it, by ID or by name; campaign, insertion order, and line item names are searched within that advertiser only. If a name matches several entities, nothing is started and the candidates are listed: ask the user which one, then call again with its ID.\npreset chooses the numbers: delivery (default: impressions, clicks, CTR, revenue, eCPM, eCPC), video, viewability, conversions, youtube (views, view rate, eCPV; use it for YouTube campaigns), reach (unique reach and frequency; without a day, week, or month breakdown Google allows at most 93 days). breakdown: total (default), day, week, month, or a level below the target. Default dates: the last 7 days.\nMoney is Revenue (Adv Currency): what the advertiser is billed, in the advertiser's currency. Call it revenue, not spend. The rules for reading numbers in get_report apply here too.\nFor custom dimensions or metrics, use run_report.";
const LABELS = { advertiser: 'Advertiser', campaign: 'Campaign', insertionOrder: 'Insertion order', lineItem: 'Line item' };
function pathLines(path: readonly ResolvedLevel[]): string[] {
  return path.map(item => `${LABELS[item.level]}: ${item.name === undefined ? item.id : `${item.name} (${item.id})`}${item.matched !== 'id' && item.matched !== 'exact' ? ' · partial name match' : ''}`);
}
export function renderPerformance(result: PerformanceResult): { text: string; isError: boolean } {
  if (result.kind === 'invalid') return { text: ['Nothing was started. Fix these and try again:', ...result.problems.map(problem => `- ${problem}`)].join('\n'), isError: true };
  if (result.kind === 'not_started') return { text: [...pathLines(result.path), result.message].join('\n'), isError: true };
  if (result.kind === 'unresolved') {
    const level = LABELS[result.level].toLowerCase();
    const scope = result.parents.advertiserId === undefined ? 'all partners' : `advertiser ${result.parents.advertiserId}${result.parents.campaignId === undefined ? '' : `, campaign ${result.parents.campaignId}`}${result.parents.insertionOrderId === undefined ? '' : `, insertion order ${result.parents.insertionOrderId}`}`;
    const message = result.reason === 'ambiguous'
      ? `No report was started: the ${level} name "${result.find.query}" matched several ${level}s. Ask the user which one, then call get_performance again with its ${result.level}Id.`
      : result.reason === 'none' ? `No report was started: the ${level} name "${result.find.query}" matched no ${level} (searched: ${scope}).`
        : `No report was started: the ${level} name "${result.find.query}" could not be searched completely, so no report was started.`;
    return { text: [...pathLines(result.path), message, renderFind(result.find, result.parents)].join('\n'), isError: result.reason !== 'ambiguous' };
  }
  const last = result.path[result.path.length - 1];
  const level = LABELS[last.level].toLowerCase();
  const header = [
    `Performance of ${level} ${last.name === undefined ? last.id : `${last.name} (${last.id})`}`,
    ...pathLines(result.path),
    ...(result.advertiser?.partnerId === undefined ? [] : [`Partner: ${result.advertiser.partnerId}`]),
    `Status: ${result.target?.status ?? result.advertiser?.status ?? '?'}`,
    ...(result.target?.summary ?? []),
    `Report: ${result.preset} (${result.reportType}), breakdown ${result.breakdown}, dates ${result.dateRange.text}${result.dateRange.isDefault ? ' (default)' : ''}`,
    ...result.notes.map(note => `Note: ${note}`),
    ...result.warnings.map(warning => `Warning: ${warning}`),
    ...(result.collected === undefined ? [] : result.started.warnings.map(warning => `Warning: ${warning}`)),
  ];
  let reportPart = result.collected === undefined
    ? renderStarted(result.started) + (result.collectFailed
      ? '\nCall get_report with this queryId and reportId.'
      : '\nThere was no time left in this call to wait for it. Call get_report with this queryId and reportId.')
    : renderCollected(result.collected);
  let requestedLine = '';
  if (result.requestedRow !== undefined) {
    const requested = result.requestedRow;
    const page = result.collected?.status === 'done' ? result.collected.page : undefined;
    const column = page?.header.findIndex(header => header.toLowerCase() === `${LABELS[requested.level]} ID`.toLowerCase()) ?? -1;
    const index = column < 0 ? -1 : page!.rows.findIndex(row => row[column] === requested.id);
    requestedLine = `\nRequested row: ${LABELS[requested.level]} ID ${requested.id}` + (index >= 0 ? ` (row ${index + 1} of this page)` : ' (not in this page; use get_report with offset to find it)');
  }
  reportPart += requestedLine;
  let text = [...header, reportPart].join('\n');
  if (text.length > 20_000 && result.collected?.status === 'done') {
    const rendered = renderCollected(result.collected);
    const previewAt = rendered.indexOf('\nPreview (CSV, first line is the header):');
    const totalsAt = rendered.indexOf("\nTotals row (Google's own,");
    const cutAt = Math.min(...[previewAt, totalsAt].filter(index => index >= 0));
    reportPart = (Number.isFinite(cutAt) ? rendered.slice(0, cutAt) : rendered) + requestedLine;
    text = [...header, reportPart, 'The preview was too long for this reply. Call get_report with the same IDs (offset 0) to see it.'].join('\n');
  }
  const collected = result.collected;
  return { text, isError: collected?.status === 'failed' || (collected?.status === 'done_no_preview' && !collected.url) };
}
export function registerPerformanceTools(server: McpServer, performance: PerformanceService, run: ToolRunner = runWithoutLogging): void {
  const id = z.string().regex(/^[0-9]{1,20}$/).optional();
  const name = z.string().max(200).optional();
  server.registerTool('get_performance', {
    title: 'Get performance', description: DESCRIPTION,
    inputSchema: z.object({
      advertiserId: id, advertiserName: name, campaignId: id, campaignName: name,
      insertionOrderId: id, insertionOrderName: name, lineItemId: id, lineItemName: name,
      preset: z.enum(Object.keys(PRESETS) as [PresetName, ...PresetName[]]).optional(),
      breakdown: z.enum(BREAKDOWNS).optional(),
      dateRange: z.object({ preset: z.enum(DATE_PRESETS).optional(), startDate: z.string().max(10).optional(), endDate: z.string().max(10).optional() }).strict().optional(),
      format: z.enum(['XLSX', 'CSV']).optional(),
    }).strict(), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (args, ctx) => run('get_performance', async call => {
    try {
      const result = await performance.getPerformance({ ...args, signal: ctx.mcpReq.signal, callId: call.callId });
      if (result.kind === 'report' && result.collected?.status === 'done_no_preview') call.note(result.collected.reason);
      const rendered = renderPerformance(result);
      return { content: [{ type: 'text' as const, text: rendered.text }], ...(rendered.isError ? { isError: true } : {}) };
    } catch (error) {
      call.failed(error);
      return { content: [{ type: 'text' as const, text: safeErrorMessage(error) }], isError: true };
    }
  }));
}
