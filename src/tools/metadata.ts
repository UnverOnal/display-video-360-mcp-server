import { runWithoutLogging, type ToolCall, type ToolRunner } from './call.js';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
  RESOURCE_STATUSES, STATUS_NAMES, safeErrorMessage,
  type FindParents, type FindRequest, type FindResult, type GetResult, type ListRequest, type ListResult, type MetadataService,
  type ResourceType, type StatusName,
} from '../integrations/dv360/metadata.js';

const MAX_LIST_TEXT = 20_000;
const MAX_GET_TEXT = 16_700;
const MAX_FIND_TEXT = 12_000;
const PAGING_SENTENCE = 'Use pageToken from a result to get the next page, with exactly the same other arguments.';

const descriptions = {
  list_partners: "Lists the DV360 partners the server's Google account can see (ID, name, status, currency). Start here when the user names no IDs. DV360's hierarchy is partner → advertiser → campaign → insertion order → line item; drill down with list_advertisers, list_campaigns, list_insertion_orders, and list_line_items. Archived partners are hidden unless statuses includes ARCHIVED.\nIDs from these tools work in the report tools' filters (e.g. FILTER_PARTNER, FILTER_ADVERTISER, FILTER_MEDIA_PLAN for campaigns, FILTER_INSERTION_ORDER, FILTER_LINE_ITEM).",
  list_advertisers: "Lists the advertisers under one DV360 partner (ID, name, status, currency, time zone). Needs a partnerId (from list_partners). Statuses: ACTIVE, PAUSED, SCHEDULED_FOR_DELETION; all are shown by default (advertisers can't be archived).\nTo find an advertiser by name, use find_entities.",
  list_campaigns: 'Lists the campaigns of one advertiser (ID, name, status, goal, planned dates, planned spend). Archived campaigns are hidden unless statuses includes ARCHIVED. Planned spend is informational and does not cap spending.',
  list_insertion_orders: "Lists the insertion orders of one advertiser, optionally only those of one campaign (ID, name, status, campaign, budget type and automation, the current or next budget segment, pacing). Drafts are shown; archived insertion orders are hidden unless statuses includes ARCHIVED.\nAmounts are converted from Google's micros and shown with the advertiser's currency. Impression budgets are shown as impression counts, never money.",
  list_line_items: 'Lists the line items of one advertiser, optionally narrowed to one campaign or insertion order (ID, name, status, insertion order, type, flight, budget, bid strategy). Archived line items are hidden unless statuses includes ARCHIVED; an empty list can mean they are all archived.\nBudgets: "fixed" amounts are money in the advertiser\'s currency or impression counts, as labelled; "unlimited" has no cap; "automatic" is set by the insertion order. Never add money across advertisers with different currencies.',
  get_metadata: "Shows one DV360 partner, advertiser, campaign, insertion order, or line item in detail: a readable summary (amounts with currency, every budget segment) followed by Google's full record as JSON. Campaigns, insertion orders, and line items need their advertiserId.\nPrefer the summary lines for amounts. In the JSON, money fields (budgetAmountMicros and maxAmount under a currency budget, bidAmountMicros, plannedSpendAmountMicros, dailyMaxMicros) are millionths of the advertiser's currency. Other Micros fields are not money: performanceGoalPercentageMicros is a percentage in millionths, and performanceGoalAmountMicros depends on the goal type (money, percentage, or a ratio such as ROAS). Under budgetUnit BUDGET_UNIT_IMPRESSIONS, line item maxAmount and insertion order segment budgetAmountMicros are plain impression counts (not micros, despite the name); for campaign budgets the unit is not yet verified.",
  find_entities: "Finds DV360 partners, advertisers, campaigns, insertion orders, or line items by name and returns their IDs. Matching ignores case and finds every name that contains the text; exact names come first, then names that start with it. Campaigns, insertion orders, and line items need their advertiserId (find the advertiser first if you only know its name). Advertisers are searched under partnerId, or under every partner the account can see when partnerId is omitted.\nStatuses: partners, insertion orders, and line items accept ACTIVE, PAUSED, DRAFT, ARCHIVED (partners also SCHEDULED_FOR_DELETION); campaigns ACTIVE, PAUSED, ARCHIVED; advertisers ACTIVE, PAUSED, SCHEDULED_FOR_DELETION. Defaults are the list tools' (archived hidden; all advertisers shown).\nUse the IDs with get_metadata, the list tools, and the report tools' filters. When several entities match, ask the user which one they mean instead of guessing. An incomplete search is not proof that no match exists.",
} as const;

const LABELS: Record<ResourceType, { plural: string; lower: string; tool: string; single: string }> = {
  partner: { plural: 'Partners', lower: 'partners', tool: 'list_partners', single: 'Partner' },
  advertiser: { plural: 'Advertisers', lower: 'advertisers', tool: 'list_advertisers', single: 'Advertiser' },
  campaign: { plural: 'Campaigns', lower: 'campaigns', tool: 'list_campaigns', single: 'Campaign' },
  insertionOrder: { plural: 'Insertion orders', lower: 'insertion orders', tool: 'list_insertion_orders', single: 'Insertion order' },
  lineItem: { plural: 'Line items', lower: 'line items', tool: 'list_line_items', single: 'Line item' },
};


function parentClause(request: FindParents): string {
  switch (request.resource) {
    case 'partner': return '';
    case 'advertiser': return `under partner ${request.partnerId}`;
    case 'campaign': return `of advertiser ${request.advertiserId}`;
    case 'insertionOrder':
      return `of advertiser ${request.advertiserId}${request.campaignId === undefined ? '' : `, campaign ${request.campaignId}`}`;
    case 'lineItem':
      return `of advertiser ${request.advertiserId}${request.campaignId === undefined ? '' : `, campaign ${request.campaignId}`}${request.insertionOrderId === undefined ? '' : `, insertion order ${request.insertionOrderId}`}`;
  }
}

function statusClause(result: Pick<ListResult, 'resource' | 'statusFilter'>): string {
  if (result.statusFilter === 'default') {
    return result.resource === 'advertiser' ? '; statuses: all' : '; statuses: all except archived';
  }
  return `; statuses: ${result.statusFilter.join(', ')}`;
}

export function renderList(result: ListResult, request: ListRequest): string {
  const label = LABELS[result.resource];
  const clause = parentClause(request);
  return [
    `${label.plural}${clause ? ` ${clause}` : ''} (${result.rows.length} shown${statusClause(result)}):`,
    ...result.rows.map(row => row.line),
    // Google may return an empty page that still has a next-page token; then more results follow.
    ...(result.rows.length === 0 && result.nextPageToken === undefined
      ? [`No ${label.lower} found with these statuses. An empty list means none are visible to this account with these statuses.`] : []),
    ...(result.rows.length === 0 && result.nextPageToken !== undefined ? [`No ${label.lower} on this page; more follow.`] : []),
    ...(result.currency === undefined ? [] : [`Note: amounts are in ${result.currency} (the advertiser's currency).`]),
    ...result.warnings.map(warning => `Warning: ${warning}`),
    result.nextPageToken === undefined
      ? 'End of list.'
      : `More ${label.lower} follow: call ${label.tool} again with the same arguments and pageToken "${result.nextPageToken}".`,
  ].join('\n');
}

export function renderFind(result: FindResult, request: FindParents): string {
  const label = LABELS[result.resource];
  const allPartners = result.resource === 'advertiser' && request.partnerId === undefined;
  const scope = allPartners ? 'under all partners' : parentClause(request);
  const partners = allPartners ? ` under ${result.partnersSearched ?? 0} partners` : '';
  const shown = result.matches.length;
  const tag = (match: FindResult['matches'][number]): string => {
    const parent = result.resource === 'advertiser' ? match.partnerId && `partner ${match.partnerId}`
      : result.resource === 'insertionOrder' ? match.campaignId && `campaign ${match.campaignId}`
        : result.resource === 'lineItem' ? match.insertionOrderId && `insertion order ${match.insertionOrderId}` : undefined;
    return `${parent ? ` · ${parent}` : ''}${match.kind === 'exact' ? ' · exact name' : ''}`;
  };
  const hint = result.resource === 'advertiser' && request.partnerId !== undefined
    ? 'Check the spelling, or search under all partners (omit partnerId).'
    : result.resource !== 'advertiser' && result.statusFilter === 'default'
      ? 'Check the spelling, or include ARCHIVED in statuses.' : 'Check the spelling.';
  return [
    `${label.plural}${scope ? ` ${scope}` : ''} matching "${result.query}" (${shown} of ${result.totalMatches} shown; searched ${result.searched} ${label.lower}${partners}${statusClause(result)}):`,
    ...result.matches.map(match => `${match.id} · ${match.name} · ${match.status}${tag(match)}`),
    ...(result.totalMatches > shown ? [`${result.totalMatches - shown} more matches not shown; use a more specific name.`] : []),
    ...(result.totalMatches === 0 && !result.complete ? ['The search was incomplete, so this is not proof that no match exists.'] : []),
    ...(result.totalMatches === 0 && result.complete
      ? [`No ${label.lower} match "${result.query}". Matching ignores case and finds names that contain the text. ${hint}`] : []),
    ...result.notes.map(note => `Note: ${note}`),
    ...result.warnings.map(warning => `Warning: ${warning}`),
    ...(shown > 0 ? ["Use these IDs with get_metadata, the list tools, and the report tools' filters."] : []),
  ].join('\n');
}

export function renderGet(result: GetResult): string {
  const label = LABELS[result.resource];
  return [
    `${label.single} ${result.id}: ${result.name}`,
    `Status: ${result.status}`,
    ...result.summary,
    ...(result.segments === undefined || result.segments.length === 0 ? [] : ['Budget segments:', ...result.segments.map(line => `- ${line}`)]),
    ...result.warnings.map(warning => `Warning: ${warning}`),
    ...(result.detailsOmitted === undefined
      ? ["Details (Google's record as JSON; for units of Micros and budget fields see the get_metadata description, and prefer the summary lines above):", result.details]
      : [`Details omitted: Google's record is ${result.detailsOmitted} characters, too long to show here. The summary above has the key fields.`]),
  ].join('\n');
}

export function registerMetadataTools(server: McpServer, metadata: MetadataService, run: ToolRunner = runWithoutLogging): void {
  const id = z.string().regex(/^[0-9]{1,20}$/);
  const pageSize = z.number().int().min(1).max(40).optional();
  const pageToken = z.string().max(2000).optional();
  const statuses = (resource: ResourceType) =>
    z.array(z.enum(RESOURCE_STATUSES[resource] as unknown as [StatusName, ...StatusName[]])).min(1).max(5).optional();
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const textResult = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });
  const handle = (tool: string, operation: (call: ToolCall) => Promise<{ text: string; isError?: boolean }>) =>
    run(tool, async call => {
      try { const result = await operation(call); return textResult(result.text, result.isError); }
      catch (error) { call.failed(error); return textResult(safeErrorMessage(error), true); }
    });
  const runList = (tool: string, request: ListRequest) => handle(tool, async call => {
    const text = renderList(await metadata.list({ ...request, callId: call.callId }), request);
    // A result past the limit is a bug; it is refused whole, and never returned with a page token.
    return text.length > MAX_LIST_TEXT
      ? { text: 'The result was too long to show. Use a smaller pageSize.', isError: true } : { text };
  });

  server.registerTool('list_partners', {
    title: 'List partners', description: `${descriptions.list_partners}\n${PAGING_SENTENCE}`,
    inputSchema: z.object({ statuses: statuses('partner'), pageSize, pageToken }).strict(), annotations,
  }, (args, ctx) => runList('list_partners', { signal: ctx.mcpReq.signal, resource: 'partner', ...args }));
  server.registerTool('list_advertisers', {
    title: 'List advertisers', description: `${descriptions.list_advertisers}\n${PAGING_SENTENCE}`,
    inputSchema: z.object({ partnerId: id, statuses: statuses('advertiser'), pageSize, pageToken }).strict(), annotations,
  }, (args, ctx) => runList('list_advertisers', { signal: ctx.mcpReq.signal, resource: 'advertiser', ...args }));
  server.registerTool('list_campaigns', {
    title: 'List campaigns', description: `${descriptions.list_campaigns}\n${PAGING_SENTENCE}`,
    inputSchema: z.object({ advertiserId: id, statuses: statuses('campaign'), pageSize, pageToken }).strict(), annotations,
  }, (args, ctx) => runList('list_campaigns', { signal: ctx.mcpReq.signal, resource: 'campaign', ...args }));
  server.registerTool('list_insertion_orders', {
    title: 'List insertion orders', description: `${descriptions.list_insertion_orders}\n${PAGING_SENTENCE}`,
    inputSchema: z.object({
      advertiserId: id, campaignId: id.optional(), statuses: statuses('insertionOrder'), pageSize, pageToken,
    }).strict(), annotations,
  }, (args, ctx) => runList('list_insertion_orders', { signal: ctx.mcpReq.signal, resource: 'insertionOrder', ...args }));
  server.registerTool('list_line_items', {
    title: 'List line items', description: `${descriptions.list_line_items}\n${PAGING_SENTENCE}`,
    inputSchema: z.object({
      advertiserId: id, campaignId: id.optional(), insertionOrderId: id.optional(),
      statuses: statuses('lineItem'), pageSize, pageToken,
    }).strict(), annotations,
  }, (args, ctx) => runList('list_line_items', { signal: ctx.mcpReq.signal, resource: 'lineItem', ...args }));
  server.registerTool('get_metadata', {
    title: 'Get DV360 entity details', description: descriptions.get_metadata,
    inputSchema: z.object({
      type: z.enum(['partner', 'advertiser', 'campaign', 'insertion_order', 'line_item']), id, advertiserId: id.optional(),
    }).strict(), annotations,
  }, (args, ctx) => handle('get_metadata', async call => {
    const resource: ResourceType = args.type === 'insertion_order' ? 'insertionOrder' : args.type === 'line_item' ? 'lineItem' : args.type;
    const needsAdvertiser = resource === 'campaign' || resource === 'insertionOrder' || resource === 'lineItem';
    if (needsAdvertiser && args.advertiserId === undefined) {
      return { text: 'advertiserId is required for campaigns, insertion orders, and line items.', isError: true };
    }
    if (!needsAdvertiser && args.advertiserId !== undefined) {
      return { text: 'advertiserId is only used for campaigns, insertion orders, and line items.', isError: true };
    }
    const text = renderGet(await metadata.get({
      resource, id: args.id, ...(args.advertiserId === undefined ? {} : { advertiserId: args.advertiserId }), signal: ctx.mcpReq.signal, callId: call.callId,
    }));
    return text.length > MAX_GET_TEXT ? { text: 'The record was too long to show.', isError: true } : { text };
  }));
  server.registerTool('find_entities', {
    title: 'Find DV360 entities by name', description: descriptions.find_entities,
    inputSchema: z.object({
      type: z.enum(['partner', 'advertiser', 'campaign', 'insertion_order', 'line_item']),
      name: z.string().min(1).max(200),
      partnerId: id.optional(), advertiserId: id.optional(),
      campaignId: id.optional(), insertionOrderId: id.optional(),
      statuses: z.array(z.enum(STATUS_NAMES)).min(1).max(5).optional(),
    }).strict(), annotations,
  }, (args, ctx) => handle('find_entities', async call => {
    const resource: ResourceType = args.type === 'insertion_order' ? 'insertionOrder' : args.type === 'line_item' ? 'lineItem' : args.type;
    const request: FindRequest = {
      resource, name: args.name,
      ...(args.partnerId === undefined ? {} : { partnerId: args.partnerId }),
      ...(args.advertiserId === undefined ? {} : { advertiserId: args.advertiserId }),
      ...(args.campaignId === undefined ? {} : { campaignId: args.campaignId }),
      ...(args.insertionOrderId === undefined ? {} : { insertionOrderId: args.insertionOrderId }),
      ...(args.statuses === undefined ? {} : { statuses: args.statuses }),
      signal: ctx.mcpReq.signal, callId: call.callId,
    };
    const text = renderFind(await metadata.find(request), request);
    // A result past the limit is a bug guard: 20 rows of at most 400 characters plus a header are far below it.
    return text.length > MAX_FIND_TEXT ? { text: 'The result was too long to show. Use a more specific name.', isError: true } : { text };
  }));
}
