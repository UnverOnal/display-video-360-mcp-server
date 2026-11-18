import type { AuthorizedFetch } from '../google/auth.js';
import { createGetJson, type CallOptions, type RequestRuntime } from '../google/request.js';
import type { RetryPolicy } from '../google/retry.js';
import { Dv360Error, classifyHttpError } from './errors.js';

export const DISPLAY_VIDEO_SCOPE = 'https://www.googleapis.com/auth/display-video';

export type EntityStatus =
  | 'ENTITY_STATUS_ACTIVE' | 'ENTITY_STATUS_ARCHIVED' | 'ENTITY_STATUS_DRAFT'
  | 'ENTITY_STATUS_PAUSED' | 'ENTITY_STATUS_SCHEDULED_FOR_DELETION';

export type ResourceType = 'partner' | 'advertiser' | 'campaign' | 'insertionOrder' | 'lineItem';

export const FILTERABLE_STATUSES: Readonly<Record<ResourceType, readonly EntityStatus[]>> = Object.freeze({
  partner: Object.freeze<EntityStatus[]>([
    'ENTITY_STATUS_ACTIVE', 'ENTITY_STATUS_PAUSED', 'ENTITY_STATUS_DRAFT',
    'ENTITY_STATUS_ARCHIVED', 'ENTITY_STATUS_SCHEDULED_FOR_DELETION',
  ]),
  advertiser: Object.freeze<EntityStatus[]>([
    'ENTITY_STATUS_ACTIVE', 'ENTITY_STATUS_PAUSED', 'ENTITY_STATUS_SCHEDULED_FOR_DELETION',
  ]),
  campaign: Object.freeze<EntityStatus[]>(['ENTITY_STATUS_ACTIVE', 'ENTITY_STATUS_PAUSED', 'ENTITY_STATUS_ARCHIVED']),
  insertionOrder: Object.freeze<EntityStatus[]>([
    'ENTITY_STATUS_ACTIVE', 'ENTITY_STATUS_PAUSED', 'ENTITY_STATUS_DRAFT', 'ENTITY_STATUS_ARCHIVED',
  ]),
  lineItem: Object.freeze<EntityStatus[]>([
    'ENTITY_STATUS_ACTIVE', 'ENTITY_STATUS_PAUSED', 'ENTITY_STATUS_DRAFT', 'ENTITY_STATUS_ARCHIVED',
  ]),
});

type Entity = {
  readonly displayName: string;
  readonly entityStatus?: string;
  readonly [key: string]: unknown;
};
export type Partner = Entity & { readonly partnerId: string };
export type Advertiser = Entity & { readonly advertiserId: string; readonly partnerId?: string };
export type Campaign = Entity & { readonly campaignId: string; readonly advertiserId?: string };
export type InsertionOrder = Entity & { readonly insertionOrderId: string; readonly advertiserId?: string; readonly campaignId?: string };
export type LineItem = Entity & { readonly lineItemId: string; readonly advertiserId?: string; readonly campaignId?: string; readonly insertionOrderId?: string };

export type Page<T> = { readonly items: readonly T[]; readonly nextPageToken?: string };

export type ListOptions = {
  readonly statuses?: readonly EntityStatus[];
  readonly pageSize?: number;
  readonly pageToken?: string;
};
export type InsertionOrderListOptions = ListOptions & { readonly campaignId?: string };
export type LineItemListOptions = ListOptions & { readonly campaignId?: string; readonly insertionOrderId?: string };

export type Dv360Client = {
  listPartners(options?: ListOptions, call?: CallOptions): Promise<Page<Partner>>;
  listAdvertisers(partnerId: string, options?: ListOptions, call?: CallOptions): Promise<Page<Advertiser>>;
  listCampaigns(advertiserId: string, options?: ListOptions, call?: CallOptions): Promise<Page<Campaign>>;
  listInsertionOrders(advertiserId: string, options?: InsertionOrderListOptions, call?: CallOptions): Promise<Page<InsertionOrder>>;
  listLineItems(advertiserId: string, options?: LineItemListOptions, call?: CallOptions): Promise<Page<LineItem>>;
  getPartner(partnerId: string, call?: CallOptions): Promise<Partner>;
  getAdvertiser(advertiserId: string, call?: CallOptions): Promise<Advertiser>;
  getCampaign(advertiserId: string, campaignId: string, call?: CallOptions): Promise<Campaign>;
  getInsertionOrder(advertiserId: string, insertionOrderId: string, call?: CallOptions): Promise<InsertionOrder>;
  getLineItem(advertiserId: string, lineItemId: string, call?: CallOptions): Promise<LineItem>;
};

export type Dv360ClientOptions = {
  readonly timeoutMs?: number;            // per attempt; default 30_000
  readonly retry?: RetryPolicy;           // default DEFAULT_RETRY_POLICY
  readonly runtime?: Partial<RequestRuntime>;
};

const BASE_URL = 'https://displayvideo.googleapis.com/v4';
const ID_PATTERN = /^[0-9]{1,20}$/;
const RESOURCES = {
  partner: { key: 'partners', idField: 'partnerId', parentFields: [], label: 'partners' },
  advertiser: { key: 'advertisers', idField: 'advertiserId', parentFields: ['partnerId'], label: 'advertisers' },
  campaign: { key: 'campaigns', idField: 'campaignId', parentFields: ['advertiserId'], label: 'campaigns' },
  insertionOrder: {
    key: 'insertionOrders', idField: 'insertionOrderId', parentFields: ['advertiserId', 'campaignId'], label: 'insertion orders',
  },
  lineItem: {
    key: 'lineItems', idField: 'lineItemId', parentFields: ['advertiserId', 'campaignId', 'insertionOrderId'], label: 'line items',
  },
} as const;

type ResourceEntities = {
  partner: Partner;
  advertiser: Advertiser;
  campaign: Campaign;
  insertionOrder: InsertionOrder;
  lineItem: LineItem;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function checkId(value: string): void {
  if (!validId(value)) throw new Dv360Error('invalid_request', 'IDs must be numeric.');
}

function isEntity<R extends ResourceType>(value: unknown, resource: R): value is ResourceEntities[R] {
  const entity = record(value);
  const { idField, parentFields } = RESOURCES[resource];
  return entity !== undefined && validId(entity[idField]) && typeof entity.displayName === 'string'
    && (entity.entityStatus === undefined || typeof entity.entityStatus === 'string')
    && parentFields.every(field => entity[field] === undefined || validId(entity[field]));
}

/** Validates statuses for one resource and returns them de-duplicated, in canonical order. */
export function checkStatuses(resource: ResourceType, requestedStatuses: readonly EntityStatus[]): readonly EntityStatus[] {
  if (!Array.isArray(requestedStatuses)) {
    throw new Dv360Error('invalid_request', `That value is not a valid status for ${RESOURCES[resource].label}.`);
  }
  if (requestedStatuses.length === 0) throw new Dv360Error('invalid_request', 'statuses must not be empty.');
  for (const status of requestedStatuses) {
    if (!FILTERABLE_STATUSES[resource].includes(status)) {
      // Echo only our known enum values; arbitrary caller text must never enter an error.
      const value = FILTERABLE_STATUSES.partner.includes(status) ? status : 'That value';
      throw new Dv360Error('invalid_request', `${value} is not a valid status for ${RESOURCES[resource].label}.`);
    }
  }
  return FILTERABLE_STATUSES[resource].filter(status => requestedStatuses.includes(status));
}

function buildFilter(resource: ResourceType, options: LineItemListOptions): string {
  const parts: string[] = [];
  if (options.statuses !== undefined) {
    const statuses = checkStatuses(resource, options.statuses);
    const restrictions = statuses.map(status => `entityStatus="${status}"`);
    parts.push(restrictions.length === 1 ? restrictions[0] : `(${restrictions.join(' OR ')})`);
  }
  if ((resource === 'insertionOrder' || resource === 'lineItem') && options.campaignId !== undefined) {
    checkId(options.campaignId);
    parts.push(`campaignId="${options.campaignId}"`);
  }
  if (resource === 'lineItem' && options.insertionOrderId !== undefined) {
    checkId(options.insertionOrderId);
    parts.push(`insertionOrderId="${options.insertionOrderId}"`);
  }
  const filter = parts.join(' AND ');
  if (filter.length > 500) throw new Dv360Error('invalid_request', 'The filter is too long.');
  return filter;
}

export function createDv360Client(fetch: AuthorizedFetch, options: Dv360ClientOptions = {}): Dv360Client {
  const timeoutMs = options.timeoutMs ?? 30_000;

  const getJson = createGetJson({
    api: 'dv360', fetch, timeoutMs,
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    errors: { classify: classifyHttpError, create: kind => new Dv360Error(kind) },
  });

  async function get(path: string, params: URLSearchParams, operation: string, call: CallOptions | undefined): Promise<unknown> {
    return getJson(`${BASE_URL}${path}${params.size ? `?${params}` : ''}`, { ...call, operation });
  }

  async function list<R extends ResourceType>(
    resource: R, path: string, options: LineItemListOptions = {}, call: CallOptions | undefined, partnerId?: string,
  ): Promise<Page<ResourceEntities[R]>> {
    const maxPageSize = resource === 'insertionOrder' ? 100 : 200;
    if (options.pageSize !== undefined
      && (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > maxPageSize)) {
      throw new Dv360Error('invalid_request', `pageSize must be an integer from 1 to ${maxPageSize}.`);
    }
    if (options.pageToken !== undefined
      && (typeof options.pageToken !== 'string' || options.pageToken.length === 0 || options.pageToken.length > 1_000)) {
      throw new Dv360Error('invalid_request', 'pageToken is not valid.');
    }
    const filter = buildFilter(resource, options);
    const params = new URLSearchParams();
    if (partnerId !== undefined) params.set('partnerId', partnerId);
    if (options.pageSize !== undefined) params.set('pageSize', String(options.pageSize));
    if (options.pageToken !== undefined) params.set('pageToken', options.pageToken);
    if (filter) params.set('filter', filter);
    const value = record(await get(path, params, `${RESOURCES[resource].key}.list`, call));
    const items = value?.[RESOURCES[resource].key] === undefined ? [] : value[RESOURCES[resource].key];
    const token = value?.nextPageToken;
    if (!value || !Array.isArray(items) || !items.every((item): item is ResourceEntities[R] => isEntity(item, resource))
      || (token !== undefined && typeof token !== 'string')) {
      throw new Dv360Error('unexpected_response');
    }
    return { items, ...(token ? { nextPageToken: token as string } : {}) };
  }

  async function getEntity<R extends ResourceType>(
    resource: R, path: string, id: string, call: CallOptions | undefined, advertiserId?: string,
  ): Promise<ResourceEntities[R]> {
    checkId(id);
    if (advertiserId !== undefined) checkId(advertiserId);
    const value = await get(path, new URLSearchParams(), `${RESOURCES[resource].key}.get`, call);
    if (!isEntity(value, resource) || value[RESOURCES[resource].idField] !== id
      || (advertiserId !== undefined && value.advertiserId !== undefined && value.advertiserId !== advertiserId)) {
      throw new Dv360Error('unexpected_response');
    }
    return value;
  }

  return {
    async listPartners(options, call) {
      return list('partner', '/partners', options, call);
    },
    async listAdvertisers(partnerId, options, call) {
      checkId(partnerId);
      return list('advertiser', '/advertisers', options, call, partnerId);
    },
    async listCampaigns(advertiserId, options, call) {
      checkId(advertiserId);
      return list('campaign', `/advertisers/${advertiserId}/campaigns`, options, call);
    },
    async listInsertionOrders(advertiserId, options, call) {
      checkId(advertiserId);
      return list('insertionOrder', `/advertisers/${advertiserId}/insertionOrders`, options, call);
    },
    async listLineItems(advertiserId, options, call) {
      checkId(advertiserId);
      return list('lineItem', `/advertisers/${advertiserId}/lineItems`, options, call);
    },
    async getPartner(partnerId, call) {
      return getEntity('partner', `/partners/${partnerId}`, partnerId, call);
    },
    async getAdvertiser(advertiserId, call) {
      return getEntity('advertiser', `/advertisers/${advertiserId}`, advertiserId, call);
    },
    async getCampaign(advertiserId, campaignId, call) {
      checkId(advertiserId);
      return getEntity('campaign', `/advertisers/${advertiserId}/campaigns/${campaignId}`, campaignId, call, advertiserId);
    },
    async getInsertionOrder(advertiserId, insertionOrderId, call) {
      checkId(advertiserId);
      return getEntity('insertionOrder', `/advertisers/${advertiserId}/insertionOrders/${insertionOrderId}`, insertionOrderId, call, advertiserId);
    },
    async getLineItem(advertiserId, lineItemId, call) {
      checkId(advertiserId);
      return getEntity('lineItem', `/advertisers/${advertiserId}/lineItems/${lineItemId}`, lineItemId, call, advertiserId);
    },
  };
}
