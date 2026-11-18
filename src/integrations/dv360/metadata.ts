import { createHash } from 'node:crypto';
import { GoogleCredentialsError } from '../google/auth.js';
import type { CallOptions } from '../google/request.js';
import {
  FILTERABLE_STATUSES, checkStatuses, type Dv360Client, type EntityStatus, type Page, type ResourceType,
} from './client.js';
import { Dv360Error } from './errors.js';
import {
  MAX_NAME_CHARS, MAX_ROW_CHARS, chooseSegment, clean, formatCount, formatDateRange, formatMoney,
  formatRow, orderSegments, statusText, summarize,
} from './format.js';
import { compareMatches, foldName, matchName, type MatchKind } from './names.js';

export type { ResourceType } from './client.js';
export type { MatchKind } from './names.js';

export const STATUS_NAMES = ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED', 'SCHEDULED_FOR_DELETION'] as const;
export type StatusName = typeof STATUS_NAMES[number];
const STATUS_PREFIX = 'ENTITY_STATUS_';
function shortNames(resource: ResourceType): readonly StatusName[] {
  return Object.freeze(FILTERABLE_STATUSES[resource].map(status => status.slice(STATUS_PREFIX.length) as StatusName));
}
export const RESOURCE_STATUSES: Readonly<Record<ResourceType, readonly StatusName[]>> = Object.freeze({
  partner: shortNames('partner'),
  advertiser: shortNames('advertiser'),
  campaign: shortNames('campaign'),
  insertionOrder: shortNames('insertionOrder'),
  lineItem: shortNames('lineItem'),
});
export const DEFAULT_PAGE_SIZE = 40;
export const MAX_PAGE_SIZE = 40;

export type ListRequest = {
  readonly resource: ResourceType;
  readonly partnerId?: string;
  readonly advertiserId?: string;
  readonly campaignId?: string;
  readonly insertionOrderId?: string;
  readonly statuses?: readonly StatusName[];
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly signal?: AbortSignal;
  readonly callId?: string;
};

export type Row = { readonly id: string; readonly line: string };

export type ListResult = {
  readonly resource: ResourceType;
  readonly rows: readonly Row[];
  readonly statusFilter: 'default' | readonly StatusName[];
  readonly nextPageToken?: string;
  readonly currency?: string;
  readonly warnings: readonly string[];
};

export type GetRequest = {
  readonly resource: ResourceType;
  readonly id: string;
  readonly advertiserId?: string;
  readonly signal?: AbortSignal;
  readonly callId?: string;
};

export type GetResult = {
  readonly resource: ResourceType;
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly summary: readonly string[];
  readonly segments?: readonly string[];
  readonly details: string;
  readonly detailsOmitted?: number;
  readonly warnings: readonly string[];
};

export const MAX_NAME_QUERY_CHARS = 200;
export const MAX_MATCHES = 20;

export type FindRequest = {
  readonly deadline?: number;
  readonly resource: ResourceType;
  readonly name: string;
  readonly partnerId?: string;         // advertisers only; optional (absent = all visible partners)
  readonly advertiserId?: string;      // required for campaigns, insertion orders, line items
  readonly campaignId?: string;        // insertion orders and line items only
  readonly insertionOrderId?: string;  // line items only
  readonly statuses?: readonly StatusName[];
  readonly refresh?: 'zero_matches' | 'no_exact';   // advertisers only; default 'zero_matches'
  readonly signal?: AbortSignal;
  readonly callId?: string;
};

export type Match = {
  readonly id: string;
  readonly name: string;      // clean(displayName, MAX_NAME_CHARS)
  readonly status: string;    // statusText(entityStatus)
  readonly kind: MatchKind;
  readonly partnerId?: string;        // advertisers
  readonly advertiserId?: string;     // campaigns, insertion orders, line items
  readonly campaignId?: string;       // insertion orders, line items (when Google sends it)
  readonly insertionOrderId?: string; // line items (when Google sends it)
};

export type FindResult = {
  readonly resource: ResourceType;
  readonly query: string;               // clean(trimmed name, MAX_NAME_QUERY_CHARS), for display
  readonly matches: readonly Match[];   // at most MAX_MATCHES, ranked by compareMatches
  readonly totalMatches: number;
  readonly exactMatches: number;
  readonly searched: number;            // entities whose status passed the filter (i.e. compared by name)
  readonly partnersSearched?: number;   // advertisers only: directories used (cached or loaded)
  readonly partnersDenied?: number;     // advertisers only: partners that refused the listing (access_denied)
  readonly partnersFailed?: number;     // advertisers only: partners whose load failed for another reason
  readonly partnersNotStarted?: number; // advertisers only: partners not reached before the scan budget ended
  readonly complete: boolean;
  readonly statusFilter: 'default' | readonly StatusName[];
  readonly notes: readonly string[];    // informational (denied partners)
  readonly warnings: readonly string[]; // anything that may hide matches
};

export type FindParents = Pick<ListRequest, 'resource' | 'partnerId' | 'advertiserId' | 'campaignId' | 'insertionOrderId'>;
export type TargetLevel = 'campaign' | 'insertionOrder' | 'lineItem';
export type DescribeRequest = {
  readonly advertiserId: string;
  readonly target?: { readonly resource: TargetLevel; readonly id: string };
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  readonly callId?: string;
};
export type DescribedAdvertiser = {
  readonly id: string; readonly name: string; readonly status: string;
  readonly partnerId?: string;
  readonly currency?: string;
};
export type DescribedTarget = {
  readonly resource: TargetLevel; readonly id: string; readonly name: string; readonly status: string;
  readonly summary: readonly string[];
  readonly campaignId?: string;
  readonly insertionOrderId?: string;
  readonly lineItemType?: string;
};
export type DescribeResult = {
  readonly advertiser?: DescribedAdvertiser;
  readonly advertiserProblem?: string;
  readonly target?: DescribedTarget;
  readonly warnings: readonly string[];
};
export type MetadataService = {
  describeTarget(request: DescribeRequest): Promise<DescribeResult>;
  list(request: ListRequest): Promise<ListResult>;
  get(request: GetRequest): Promise<GetResult>;
  find(request: FindRequest): Promise<FindResult>;
};

export type MetadataDependencies = {
  readonly client: Dv360Client;
  readonly now?: () => Date;
};

const MAX_DETAILS_CHARS = 12_000;
const MAX_SEGMENT_LINES = 20;
const ID_FIELDS = {
  partner: 'partnerId', advertiser: 'advertiserId', campaign: 'campaignId',
  insertionOrder: 'insertionOrderId', lineItem: 'lineItemId',
} as const satisfies Record<ResourceType, string>;
const TOKEN_PATTERN = /^v1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{1,1400})$/;
export const TOOL_BUDGET_MS = 45_000;
const GENERIC_ERROR = "Unexpected server error. Try again; if it keeps happening, report it to the server's maintainer.";

// find() bounds (plan M6 step 1, §5.3) and the advertiser directory cache (§5.5).
export const FIND_PAGE_SIZE = 200;
export const FIND_INSERTION_ORDER_PAGE_SIZE = 100;
export const MAX_FIND_PAGES = 5;
export const MAX_DIRECTORY_PAGES = 25;
export const SCAN_BUDGET_MS = 25_000;
export const MAX_PARTNER_SCANS = 3;
export const MAX_PARTNERS = 50;
export const DIRECTORY_TTL_MS = 600_000;
export const MAX_CACHED_DIRECTORIES = 50;
export const DIRECTORY_REFRESH_AFTER_MS = 60_000;
const PARENT_PLACEHOLDER = '0';
const FIND_PARENT_MESSAGE = "advertiserId is required to search campaigns, insertion orders, and line items. If you know only the advertiser's name, find it first with type advertiser.";
const PARTNER_DEFAULT_STATUSES = FILTERABLE_STATUSES.partner.filter(status => status !== 'ENTITY_STATUS_ARCHIVED');
const CUT_HINTS: Readonly<Record<ResourceType, string>> = {
  partner: 'a more specific name', advertiser: 'partnerId', campaign: 'a more specific name',
  insertionOrder: 'campaignId', lineItem: 'campaignId or insertionOrderId',
};
const REFRESH_WARNING = 'Some advertiser lists could not be refreshed; results may be up to 10 minutes old.';

type DirectoryEntry = {
  readonly id: string;
  readonly displayName: string;
  readonly entityStatus?: string;
  readonly partnerId: string;
};
type CacheEntry =
  | { readonly kind: 'directory'; readonly entries: readonly DirectoryEntry[]; readonly loadedAt: number }
  | { readonly kind: 'denied'; readonly loadedAt: number };
type CutReason = 'too many entries' | 'time limit';
type Candidate = { readonly match: Match; readonly folded: string };

/** Short status names to Google's enum, as mainList always did; odd input passes through for checkStatuses to refuse. */
function toEntityStatuses(statuses: readonly StatusName[]): readonly EntityStatus[] {
  return Array.isArray(statuses)
    ? statuses.map(name => (typeof name === 'string' ? `${STATUS_PREFIX}${name}` : name) as EntityStatus)
    : statuses as unknown as readonly EntityStatus[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function invalid(message: string): Dv360Error {
  return new Dv360Error('invalid_request', message);
}

export function safeErrorMessage(error: unknown): string {
  return error instanceof Dv360Error || error instanceof GoogleCredentialsError ? error.message : GENERIC_ERROR;
}

function isChild(resource: ResourceType): boolean {
  return resource === 'campaign' || resource === 'insertionOrder' || resource === 'lineItem';
}

function canonicalStatuses(resource: ResourceType, statuses: readonly StatusName[]): readonly StatusName[] {
  const order = RESOURCE_STATUSES[resource];
  const rank = (status: StatusName) => { const index = order.indexOf(status); return index < 0 ? order.length : index; };
  return [...new Set(statuses)].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function fingerprint(request: ListRequest, pageSize: number): string {
  const statuses = request.statuses === undefined ? 'default' : canonicalStatuses(request.resource, request.statuses);
  const canonical = JSON.stringify([
    request.resource, request.partnerId ?? null, request.advertiserId ?? null,
    request.campaignId ?? null, request.insertionOrderId ?? null, statuses, pageSize,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function wrapToken(print: string, googleToken: string): string {
  const encoded = Buffer.from(googleToken, 'utf8').toString('base64url');
  // Both limits must hold, or the server would hand out a token it later refuses (non-ASCII tokens encode longer).
  if (googleToken.length > 1_000 || encoded.length > 1_400) throw new Dv360Error('unexpected_response');
  return `v1.${print}.${encoded}`;
}

function unwrapToken(token: string, print: string): string {
  const notValid = invalid('pageToken is not valid. Start again without pageToken.');
  const match = TOKEN_PATTERN.exec(token);
  if (!match) throw notValid;
  if (match[1] !== print) {
    throw invalid('This pageToken belongs to a different request. Repeat exactly the arguments of the call that returned it, or start again without pageToken.');
  }
  const decoded = Buffer.from(match[2], 'base64url').toString('utf8');
  if (decoded.length === 0 || decoded.length > 1_000 || Buffer.from(decoded, 'utf8').toString('base64url') !== match[2]) throw notValid;
  return decoded;
}

function validate(request: ListRequest): void {
  const { resource } = request;
  if (resource === 'advertiser' && request.partnerId === undefined) throw invalid('partnerId is required.');
  if (isChild(resource) && request.advertiserId === undefined) throw invalid('advertiserId is required.');
  if (resource !== 'advertiser' && request.partnerId !== undefined) throw invalid('partnerId is only valid for advertisers.');
  if (!isChild(resource) && request.advertiserId !== undefined) {
    throw invalid('advertiserId is only valid for campaigns, insertion orders, and line items.');
  }
  if (request.campaignId !== undefined && resource !== 'insertionOrder' && resource !== 'lineItem') {
    throw invalid('campaignId is only valid for insertion orders and line items.');
  }
  if (request.insertionOrderId !== undefined && resource !== 'lineItem') {
    throw invalid('insertionOrderId is only valid for line items.');
  }
}

function localDate(now: Date, timeZone: unknown): string | undefined {
  if (typeof timeZone !== 'string' || timeZone === '') return undefined;
  try {
    const text = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

type Advertiser = { readonly currency?: string; readonly today: string; readonly warnings: readonly string[] };

function advertiserContext(
  resource: ResourceType, lookup: PromiseSettledResult<unknown> | undefined, now: Date,
): Advertiser {
  const warnings: string[] = [];
  let currency: string | undefined;
  let timeZone: unknown;
  if (lookup?.status === 'fulfilled') {
    const config = record(record(lookup.value)?.generalConfig);
    const code = config?.currencyCode;
    if (typeof code === 'string' && /^[A-Z]{3}$/.test(code)) currency = code;
    else warnings.push('The advertiser\'s currency could not be read (no currency on the advertiser); amounts are shown as "(advertiser currency)".');
    timeZone = config?.timeZone;
  } else if (lookup?.status === 'rejected') {
    warnings.push(`The advertiser's currency could not be read (${safeErrorMessage(lookup.reason)}); amounts are shown as "(advertiser currency)".`);
  }
  const local = localDate(now, timeZone);
  if (resource === 'insertionOrder' && local === undefined) {
    warnings.push("The advertiser's time zone could not be read; current and next budget segments are chosen by the UTC date.");
  }
  return { ...(currency === undefined ? {} : { currency }), today: local ?? now.toISOString().slice(0, 10), warnings };
}

function rowFor(resource: ResourceType, entity: Record<string, unknown>, advertiser: Advertiser): Row {
  const id = String(entity[ID_FIELDS[resource]]);
  const line = formatRow(
    id, clean(entity.displayName, MAX_NAME_CHARS), statusText(entity.entityStatus),
    summarize(resource, entity, { ...(advertiser.currency === undefined ? {} : { currency: advertiser.currency }), today: advertiser.today }),
  );
  if (line.length > MAX_ROW_CHARS) {
    throw new Dv360Error('unexpected_response', "A metadata row was longer than expected. Report this to the server's maintainer.");
  }
  return { id, line };
}

function segmentLines(entity: Record<string, unknown>, advertiser: Advertiser): readonly string[] | undefined {
  const budget = record(entity.budget);
  if (!budget) return undefined;
  const segments = Array.isArray(budget.budgetSegments) ? budget.budgetSegments as unknown[] : [];
  if (segments.length === 0) return undefined;
  const chosen = chooseSegment(segments, advertiser.today);
  const lines = orderSegments(segments).map(segment => {
    const data = record(segment) ?? {};
    const amount = budget.budgetUnit === 'BUDGET_UNIT_CURRENCY' ? formatMoney(data.budgetAmountMicros, advertiser.currency)
      : budget.budgetUnit === 'BUDGET_UNIT_IMPRESSIONS' ? `${formatCount(data.budgetAmountMicros)} impressions` : '?';
    const prefix = chosen !== undefined && chosen.segment === segment ? `${chosen.label}: ` : '';
    return `${prefix}${formatDateRange(data.dateRange)} ${amount}`;
  });
  if (lines.length <= MAX_SEGMENT_LINES) return lines;
  return [...lines.slice(0, MAX_SEGMENT_LINES), `… ${lines.length - MAX_SEGMENT_LINES} more segments in the details below`];
}

export function createMetadataService(dependencies: MetadataDependencies): MetadataService {
  const { client } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  async function mainList(request: ListRequest, pageSize: number, googleToken: string | undefined, call: CallOptions) {
    const statuses = request.statuses === undefined
      ? (request.resource === 'partner' ? PARTNER_DEFAULT_STATUSES : undefined)
      : toEntityStatuses(request.statuses);
    const options = {
      ...(statuses === undefined ? {} : { statuses }), pageSize,
      ...(googleToken === undefined ? {} : { pageToken: googleToken }),
    };
    switch (request.resource) {
      case 'partner': return client.listPartners(options, call);
      case 'advertiser': return client.listAdvertisers(request.partnerId as string, options, call);
      case 'campaign': return client.listCampaigns(request.advertiserId as string, options, call);
      case 'insertionOrder':
        return client.listInsertionOrders(request.advertiserId as string, {
          ...options, ...(request.campaignId === undefined ? {} : { campaignId: request.campaignId }),
        }, call);
      case 'lineItem':
        return client.listLineItems(request.advertiserId as string, {
          ...options,
          ...(request.campaignId === undefined ? {} : { campaignId: request.campaignId }),
          ...(request.insertionOrderId === undefined ? {} : { insertionOrderId: request.insertionOrderId }),
        }, call);
      default: throw invalid('Unknown resource.');
    }
  }

  async function mainGet(request: GetRequest, call: CallOptions) {
    const advertiserId = request.advertiserId as string;
    switch (request.resource) {
      case 'partner': return client.getPartner(request.id, call);
      case 'advertiser': return client.getAdvertiser(request.id, call);
      case 'campaign': return client.getCampaign(advertiserId, request.id, call);
      case 'insertionOrder': return client.getInsertionOrder(advertiserId, request.id, call);
      case 'lineItem': return client.getLineItem(advertiserId, request.id, call);
      default: throw invalid('Unknown resource.');
    }
  }

  // Children get currency and time zone from the advertiser lookup; partners and advertisers need no context.
  function contextFor(resource: ResourceType, lookup: PromiseSettledResult<unknown> | undefined): Advertiser {
    return isChild(resource)
      ? advertiserContext(resource, lookup, now())
      : { today: now().toISOString().slice(0, 10), warnings: [] };
  }

  async function settle<T>(main: Promise<T>, resource: ResourceType, advertiserId: string | undefined, call: CallOptions) {
    if (!isChild(resource)) return { value: await main, lookup: undefined };
    const [mainResult, lookup] = await Promise.allSettled([main, client.getAdvertiser(advertiserId as string, call)]);
    if (mainResult.status === 'rejected') throw mainResult.reason;
    return { value: mainResult.value, lookup };
  }

  // Advertiser directories per partner, shared by every caller of this service: all callers use the same Google identity.
  const directories = new Map<string, CacheEntry>();

  function store(partnerId: string, entry: CacheEntry): void {
    // Delete then set, so Map order equals load order and the first key is the oldest.
    directories.delete(partnerId);
    directories.set(partnerId, entry);
    while (directories.size > MAX_CACHED_DIRECTORIES) directories.delete(directories.keys().next().value as string);
  }

  async function find(request: FindRequest): Promise<FindResult> {
    const startMs = now().getTime();
    const { resource, signal } = request;
    const call: CallOptions = { signal, deadline: Math.min(startMs + TOOL_BUDGET_MS, request.deadline ?? Infinity), ...(request.callId === undefined ? {} : { callId: request.callId }) };

    // Validation: before any Google call.
    const trimmed = typeof request.name === 'string' ? request.name.trim() : '';
    const foldedQuery = foldName(trimmed);
    if (trimmed === '' || foldedQuery === '') throw invalid('name must not be empty.');
    if (trimmed.length > MAX_NAME_QUERY_CHARS) throw invalid(`name must be at most ${MAX_NAME_QUERY_CHARS} characters.`);
    if (isChild(resource) && request.advertiserId === undefined) throw invalid(FIND_PARENT_MESSAGE);
    validate({
      resource,
      ...(resource === 'advertiser' ? { partnerId: request.partnerId ?? PARENT_PLACEHOLDER }
        : request.partnerId === undefined ? {} : { partnerId: request.partnerId }),
      ...(request.advertiserId === undefined ? {} : { advertiserId: request.advertiserId }),
      ...(request.campaignId === undefined ? {} : { campaignId: request.campaignId }),
      ...(request.insertionOrderId === undefined ? {} : { insertionOrderId: request.insertionOrderId }),
    });
    if (request.refresh !== undefined && resource !== 'advertiser') throw invalid('refresh is only valid for advertisers.');
    const statuses = request.statuses === undefined ? undefined : checkStatuses(resource, toEntityStatuses(request.statuses));

    const budgetEnded = () => now().getTime() >= Math.min(startMs + SCAN_BUDGET_MS, request.deadline ?? Infinity);
    // A caller abort surfaces as an ordinary request error, so it is recognised by the signal, never by the error.
    const throwIfAborted = () => { if (signal?.aborted) throw new Dv360Error('timeout'); };
    const warnings: string[] = [];
    const notes: string[] = [];
    let cut: CutReason | undefined;
    const noteCut = (reason: CutReason) => { cut ??= reason; };

    // Pages of one scope, in order; stops at its page bound or when the scan budget has ended.
    async function scan<T>(
      fetchPage: (pageToken: string | undefined) => Promise<Page<T>>, maxPages: number,
    ): Promise<{ readonly items: readonly T[]; readonly cut?: CutReason }> {
      const items: T[] = [];
      let pageToken: string | undefined;
      for (let page = 0; ; page++) {
        if (page === maxPages) return { items, cut: 'too many entries' };
        if (budgetEnded()) return { items, cut: 'time limit' };
        const result = await fetchPage(pageToken);
        throwIfAborted();
        items.push(...result.items);
        pageToken = result.nextPageToken;
        if (pageToken === undefined) return { items };
      }
    }

    const candidates: Candidate[] = [];
    let searched = 0;
    const consider = (displayName: string, entityStatus: unknown, match: Omit<Match, 'name' | 'status' | 'kind'>) => {
      searched++;
      const kind = matchName(foldedQuery, displayName);
      if (kind === undefined) return;
      candidates.push({
        folded: foldName(displayName),
        match: { ...match, name: clean(displayName, MAX_NAME_CHARS), status: statusText(entityStatus), kind },
      });
    };

    let fanOut: { partnersSearched: number; partnersDenied: number; partnersFailed: number; partnersNotStarted: number } | undefined;
    let complete = true;

    if (resource === 'advertiser') {
      fanOut = await searchAdvertisers();
    } else {
      const pageSize = resource === 'insertionOrder' ? FIND_INSERTION_ORDER_PAGE_SIZE : FIND_PAGE_SIZE;
      const listOptions = (pageToken: string | undefined) => ({
        ...(resource === 'partner' ? { statuses: statuses ?? PARTNER_DEFAULT_STATUSES } : statuses === undefined ? {} : { statuses }),
        pageSize, ...(pageToken === undefined ? {} : { pageToken }),
      });
      const advertiserId = request.advertiserId as string;
      const fetchPage = (pageToken: string | undefined): Promise<Page<Record<string, unknown> & { displayName: string; entityStatus?: string }>> => {
        switch (resource) {
          case 'partner': return client.listPartners(listOptions(pageToken), call);
          case 'campaign': return client.listCampaigns(advertiserId, listOptions(pageToken), call);
          case 'insertionOrder':
            return client.listInsertionOrders(advertiserId, {
              ...listOptions(pageToken), ...(request.campaignId === undefined ? {} : { campaignId: request.campaignId }),
            }, call);
          default:
            return client.listLineItems(advertiserId, {
              ...listOptions(pageToken),
              ...(request.campaignId === undefined ? {} : { campaignId: request.campaignId }),
              ...(request.insertionOrderId === undefined ? {} : { insertionOrderId: request.insertionOrderId }),
            }, call);
        }
      };
      const result = await scan(fetchPage, MAX_FIND_PAGES);
      if (result.cut) noteCut(result.cut);
      for (const entity of result.items) {
        const parents = resource === 'partner' ? {} : {
          advertiserId: typeof entity.advertiserId === 'string' ? entity.advertiserId : advertiserId,
          ...(resource !== 'campaign' && typeof entity.campaignId === 'string' ? { campaignId: entity.campaignId } : {}),
          ...(resource === 'lineItem' && typeof entity.insertionOrderId === 'string' ? { insertionOrderId: entity.insertionOrderId } : {}),
        };
        consider(entity.displayName, entity.entityStatus, { id: String(entity[ID_FIELDS[resource]]), ...parents });
      }
    }

    // Advertisers: one directory per partner, from the cache or loaded (§5.4, §5.5).
    async function searchAdvertisers() {
      let partnerIds: readonly string[];
      if (request.partnerId !== undefined) {
        partnerIds = [request.partnerId];
      } else {
        const page = await client.listPartners({ statuses: PARTNER_DEFAULT_STATUSES, pageSize: FIND_PAGE_SIZE }, call);
        throwIfAborted();
        partnerIds = page.items.slice(0, MAX_PARTNERS).map(item => item.partnerId);
        if (page.nextPageToken !== undefined || page.items.length > MAX_PARTNERS) {
          complete = false;
          warnings.push(`The account sees more than ${MAX_PARTNERS} partners; only the first ${MAX_PARTNERS} were searched. Give partnerId to search one partner.`);
        }
      }

      type Used = { readonly partnerId: string; entries: readonly DirectoryEntry[]; loadedAt: number; fresh: boolean };
      type Outcome = { readonly kind: 'used'; readonly used: Used } | { readonly kind: 'denied' } | { readonly kind: 'failed'; readonly error: unknown };

      async function load(partnerId: string): Promise<{ readonly entries: readonly DirectoryEntry[]; readonly cut?: CutReason }> {
        const result = await scan(pageToken => client.listAdvertisers(partnerId, {
          pageSize: FIND_PAGE_SIZE, ...(pageToken === undefined ? {} : { pageToken }),
        }, call), MAX_DIRECTORY_PAGES);
        const entries = result.items.map(item => ({
          id: item.advertiserId, displayName: item.displayName, partnerId,
          ...(item.entityStatus === undefined ? {} : { entityStatus: item.entityStatus }),
        }));
        return { entries, ...(result.cut === undefined ? {} : { cut: result.cut }) };
      }

      // Runs work over the items in order, at most MAX_PARTNER_SCANS at once; no item starts after the scan budget.
      // Returns the abort error, if the caller aborted; workers never throw.
      async function pool(count: number, work: (index: number) => Promise<void>): Promise<{ aborted?: unknown; started: number }> {
        let next = 0;
        let aborted: { error: unknown } | undefined;
        const runner = async () => {
          while (next < count && aborted === undefined && !signal?.aborted && !budgetEnded()) {
            const index = next++;
            try { await work(index); } catch (error) { aborted ??= { error }; }
          }
        };
        await Promise.all(Array.from({ length: Math.min(MAX_PARTNER_SCANS, count) }, runner));
        if (aborted === undefined && signal?.aborted) aborted = { error: new Dv360Error('timeout') };
        return { ...(aborted === undefined ? {} : { aborted: aborted.error }), started: next };
      }

      const outcomes: (Outcome | undefined)[] = partnerIds.map(() => undefined);
      const first = await pool(partnerIds.length, async index => {
        const partnerId = partnerIds[index];
        const cached = directories.get(partnerId);
        if (cached !== undefined) {
          if (now().getTime() - cached.loadedAt < DIRECTORY_TTL_MS) {
            outcomes[index] = cached.kind === 'denied' ? { kind: 'denied' }
              : { kind: 'used', used: { partnerId, entries: cached.entries, loadedAt: cached.loadedAt, fresh: false } };
            return;
          }
          directories.delete(partnerId);   // expired: a miss
        }
        try {
          const loaded = await load(partnerId);
          const loadedAt = now().getTime();
          if (loaded.cut === undefined) store(partnerId, { kind: 'directory', entries: loaded.entries, loadedAt });
          else noteCut(loaded.cut);
          outcomes[index] = { kind: 'used', used: { partnerId, entries: loaded.entries, loadedAt, fresh: true } };
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof Dv360Error && error.kind === 'access_denied') {
            store(partnerId, { kind: 'denied', loadedAt: now().getTime() });
            outcomes[index] = { kind: 'denied' };
          } else {
            outcomes[index] = { kind: 'failed', error };
          }
        }
      });
      if (first.aborted !== undefined) throw first.aborted;

      const used = outcomes.flatMap(outcome => (outcome?.kind === 'used' ? [outcome.used] : []));
      const denied = outcomes.filter(outcome => outcome?.kind === 'denied').length;
      const failures = outcomes.flatMap(outcome => (outcome?.kind === 'failed' ? [outcome.error] : []));
      const notStarted = outcomes.filter(outcome => outcome === undefined).length;
      if (used.length === 0 && denied === 0 && failures.length > 0) throw failures[0];

      const matchAll = () => {
        candidates.length = 0;
        searched = 0;
        for (const directory of used) {
          for (const entry of directory.entries) {
            if (statuses !== undefined && !statuses.includes(entry.entityStatus as EntityStatus)) continue;
            consider(entry.displayName, entry.entityStatus, { id: entry.id, partnerId: entry.partnerId });
          }
        }
      };
      matchAll();

      // Refresh once: directories older than 60 s, loaded before this call, when the matches look stale.
      const mode = request.refresh ?? 'zero_matches';
      const stale = mode === 'zero_matches' ? candidates.length === 0 : !candidates.some(candidate => candidate.match.kind === 'exact');
      const toReload = stale
        ? used.filter(directory => !directory.fresh && now().getTime() - directory.loadedAt > DIRECTORY_REFRESH_AFTER_MS) : [];
      if (toReload.length > 0) {
        let refreshFailed = false;
        const reloaded = await pool(toReload.length, async index => {
          const directory = toReload[index];
          try {
            const loaded = await load(directory.partnerId);
            if (loaded.cut !== undefined) { refreshFailed = true; return; }
            const loadedAt = now().getTime();
            store(directory.partnerId, { kind: 'directory', entries: loaded.entries, loadedAt });
            directory.entries = loaded.entries;
            directory.loadedAt = loadedAt;
            directory.fresh = true;
          } catch (error) {
            if (signal?.aborted) throw error;
            refreshFailed = true;   // the old directory stays cached and is used
          }
        });
        if (reloaded.aborted !== undefined) throw reloaded.aborted;
        if (refreshFailed || reloaded.started < toReload.length) warnings.push(REFRESH_WARNING);
        matchAll();
      }

      const total = partnerIds.length;
      if (denied > 0) notes.push(`${denied} of ${total} partners don't give this account access to their advertisers; they were skipped.`);
      if (failures.length > 0) {
        complete = false;
        warnings.push(`${failures.length} of ${total} partners could not be searched (${safeErrorMessage(failures[0])}); results may be missing.`);
      }
      if (notStarted > 0) {
        complete = false;
        warnings.push(`${notStarted} of ${total} partners were not searched (time limit); repeat the search to continue, or give partnerId.`);
      }
      return { partnersSearched: used.length, partnersDenied: denied, partnersFailed: failures.length, partnersNotStarted: notStarted };
    }

    if (cut !== undefined) {
      complete = false;
      warnings.unshift(`The search stopped before the end of the list (${cut}); results may be missing. Narrow it with ${CUT_HINTS[resource]}.`);
    }
    const ranked = [...candidates].sort((a, b) => compareMatches(
      { kind: a.match.kind, folded: a.folded, id: a.match.id }, { kind: b.match.kind, folded: b.folded, id: b.match.id },
    ));
    return {
      resource,
      query: clean(trimmed, MAX_NAME_QUERY_CHARS),
      matches: ranked.slice(0, MAX_MATCHES).map(candidate => candidate.match),
      totalMatches: ranked.length,
      exactMatches: ranked.filter(candidate => candidate.match.kind === 'exact').length,
      searched,
      ...(fanOut ?? {}),
      complete,
      statusFilter: request.statuses === undefined ? 'default' : canonicalStatuses(resource, request.statuses),
      notes,
      warnings,
    };
  }

  return {
    find,
    async describeTarget(request) {
      if (!/^[0-9]{1,20}$/.test(request.advertiserId) || (request.target !== undefined && !/^[0-9]{1,20}$/.test(request.target.id))) throw invalid('IDs must be numeric.');
      const call: CallOptions = { signal: request.signal, deadline: Math.min(now().getTime() + TOOL_BUDGET_MS, request.deadline ?? Infinity), ...(request.callId === undefined ? {} : { callId: request.callId }) };
      const [lookup, targetResult] = await Promise.allSettled([
        client.getAdvertiser(request.advertiserId, call),
        ...(request.target === undefined ? [] : [mainGet({ resource: request.target.resource, id: request.target.id, advertiserId: request.advertiserId }, call)]),
      ]);
      if (targetResult?.status === 'rejected') throw targetResult.reason;
      if (lookup.status === 'rejected' && lookup.reason instanceof Dv360Error
        && (lookup.reason.kind === 'not_found' || lookup.reason.kind === 'access_denied')) throw lookup.reason;
      const context = advertiserContext(request.target?.resource ?? 'advertiser', lookup, now());
      const entity = targetResult?.status === 'fulfilled' ? targetResult.value as Record<string, unknown> : undefined;
      const advertiser = lookup.status === 'fulfilled' ? lookup.value : undefined;
      return {
        ...(advertiser === undefined ? { advertiserProblem: safeErrorMessage(lookup.status === 'rejected' ? lookup.reason : undefined) } : {
          advertiser: { id: request.advertiserId, name: clean(advertiser.displayName, 200), status: statusText(advertiser.entityStatus),
            ...(typeof advertiser.partnerId === 'string' && /^[0-9]{1,20}$/.test(advertiser.partnerId) ? { partnerId: advertiser.partnerId } : {}),
            ...(context.currency === undefined ? {} : { currency: context.currency }),
          },
        }),
        ...(entity === undefined || request.target === undefined ? {} : { target: {
          resource: request.target.resource, id: request.target.id, name: clean(entity.displayName, 200), status: statusText(entity.entityStatus),
          summary: summarize(request.target.resource, entity, { ...(context.currency === undefined ? {} : { currency: context.currency }), today: context.today }),
          ...(typeof entity.campaignId === 'string' ? { campaignId: entity.campaignId } : {}),
          ...(typeof entity.insertionOrderId === 'string' ? { insertionOrderId: entity.insertionOrderId } : {}),
          ...(typeof entity.lineItemType === 'string' ? { lineItemType: entity.lineItemType } : {}),
        } }),
        warnings: context.warnings,
      };
    },
    async list(request) {
      const call: CallOptions = { signal: request.signal, deadline: now().getTime() + TOOL_BUDGET_MS, ...(request.callId === undefined ? {} : { callId: request.callId }) };
      validate(request);
      const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
        throw invalid(`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
      }
      const print = fingerprint(request, pageSize);
      const googleToken = request.pageToken === undefined ? undefined : unwrapToken(request.pageToken, print);
      let settled;
      try {
        settled = await settle(mainList(request, pageSize, googleToken, call), request.resource, request.advertiserId, call);
      } catch (error) {
        // Only Google's own 400 means the token was refused; local guard errors have no HTTP status.
        if (googleToken !== undefined && error instanceof Dv360Error && error.kind === 'invalid_request'
          && error.diagnostics.httpStatus === 400) {
          throw invalid('The pageToken is no longer accepted by Google. Start again without pageToken.');
        }
        throw error;
      }
      const advertiser = contextFor(request.resource, settled.lookup);
      const rows = (settled.value.items as readonly Record<string, unknown>[]).map(entity => rowFor(request.resource, entity, advertiser));
      const next = settled.value.nextPageToken;
      return {
        resource: request.resource,
        rows,
        statusFilter: request.statuses === undefined ? 'default' : canonicalStatuses(request.resource, request.statuses),
        ...(next === undefined ? {} : { nextPageToken: wrapToken(print, next) }),
        ...(advertiser.currency === undefined ? {} : { currency: advertiser.currency }),
        warnings: advertiser.warnings,
      };
    },

    async get(request) {
      const call: CallOptions = { signal: request.signal, deadline: now().getTime() + TOOL_BUDGET_MS, ...(request.callId === undefined ? {} : { callId: request.callId }) };
      if (isChild(request.resource) && request.advertiserId === undefined) throw invalid('advertiserId is required.');
      if (!isChild(request.resource) && request.advertiserId !== undefined) {
        throw invalid('advertiserId is only valid for campaigns, insertion orders, and line items.');
      }
      const settled = await settle(mainGet(request, call), request.resource, request.advertiserId, call);
      const entity = settled.value as unknown as Record<string, unknown>;
      const advertiser = contextFor(request.resource, settled.lookup);
      const { name: _resourcePath, ...rest } = entity;
      const json = JSON.stringify(rest);
      const segments = request.resource === 'insertionOrder' ? segmentLines(entity, advertiser) : undefined;
      return {
        resource: request.resource,
        id: String(entity[ID_FIELDS[request.resource]]),
        name: clean(entity.displayName, 200),
        status: statusText(entity.entityStatus),
        summary: summarize(request.resource, entity, {
          ...(advertiser.currency === undefined ? {} : { currency: advertiser.currency }), today: advertiser.today,
        }),
        ...(segments === undefined ? {} : { segments }),
        details: json.length > MAX_DETAILS_CHARS ? '' : json,
        ...(json.length > MAX_DETAILS_CHARS ? { detailsOmitted: json.length } : {}),
        warnings: advertiser.warnings,
      };
    },
  };
}
