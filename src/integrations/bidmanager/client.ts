import type { AuthorizedFetch } from '../google/auth.js';
import { createSendJson, resolveRuntime, type CallOptions, type RequestRuntime, type SendInit } from '../google/request.js';
import {
  BID_MANAGER_MIN_GAP_MS, createDailyLatch, createPacer, type Idempotency, type RetryPolicy,
} from '../google/retry.js';
import { BidManagerError, classifyHttpError } from './errors.js';
import { parseMcpTitle } from './titles.js';

export const BID_MANAGER_SCOPE = 'https://www.googleapis.com/auth/doubleclickbidmanager';

export type ApiDate = { readonly year: number; readonly month: number; readonly day: number };

export type DataRange = {
  readonly range: string;                 // e.g. 'CUSTOM_DATES', 'PREVIOUS_MONTH'
  readonly customStartDate?: ApiDate;
  readonly customEndDate?: ApiDate;
};

export type QueryParameters = {
  readonly type?: string;
  readonly groupBys?: readonly string[];
  readonly filters?: readonly { readonly type: string; readonly value: string }[];
  readonly metrics?: readonly string[];
  readonly [key: string]: unknown;        // Google's other fields (e.g. options) are kept
};

export type QueryMetadata = {
  readonly title: string;
  readonly dataRange?: DataRange;
  readonly format?: string;               // 'CSV' | 'XLSX'
  readonly [key: string]: unknown;
};

export type Query = {
  readonly queryId: string;
  readonly metadata: QueryMetadata;
  readonly params?: QueryParameters;
  readonly schedule?: QuerySchedule;
  readonly [key: string]: unknown;
};

export type QuerySchedule = { readonly frequency?: string; readonly [key: string]: unknown };

// Omit<Query, ...> loses named properties because Query has a string index signature.
export type NewQuery = {
  readonly metadata: QueryMetadata;
  readonly params: QueryParameters;
  readonly schedule?: QuerySchedule;
};

export type ReportState = 'STATE_UNSPECIFIED' | 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';

export type Report = {
  readonly key: { readonly queryId: string; readonly reportId: string };
  readonly metadata: {
    readonly status: { readonly state: ReportState; readonly finishTime?: string; readonly format?: string };
    readonly reportDataStartDate?: ApiDate;
    readonly reportDataEndDate?: ApiDate;
    readonly googleCloudStoragePath?: string;
    readonly [key: string]: unknown;
  };
  readonly params?: QueryParameters;
  readonly [key: string]: unknown;
};

export type ListQueriesOptions = {
  readonly pageSize?: number;             // 1–100
  readonly pageToken?: string;
  readonly orderBy?: 'queryId' | 'queryId desc' | 'metadata.title' | 'metadata.title desc';
};

export type QueryPage = { readonly queries: readonly Query[]; readonly nextPageToken?: string };

export type ListReportsOptions = { readonly pageSize?: number; readonly orderBy?: 'key.reportId' | 'key.reportId desc' };
export type ReportList = { readonly reports: readonly Report[]; readonly nextPageToken?: string };

export type BidManagerClient = {
  createQuery(query: NewQuery, call?: CallOptions): Promise<Query>;
  runQuery(queryId: string, options?: { readonly dataRange?: DataRange }, call?: CallOptions): Promise<Report>;
  getQuery(queryId: string, call?: CallOptions): Promise<Query>;
  listQueries(options?: ListQueriesOptions, call?: CallOptions): Promise<QueryPage>;
  deleteQuery(queryId: string, call?: CallOptions): Promise<void>;
  getReport(queryId: string, reportId: string, call?: CallOptions): Promise<Report>;
  listReports(queryId: string, options?: ListReportsOptions, call?: CallOptions): Promise<ReportList>;
};

export type BidManagerClientOptions = {
  readonly timeoutMs?: number;            // per attempt; default 30_000
  readonly retry?: RetryPolicy;           // default DEFAULT_RETRY_POLICY
  readonly runtime?: Partial<RequestRuntime>;
};

const BASE_URL = 'https://doubleclickbidmanager.googleapis.com/v2';
const ID_PATTERN = /^[0-9]{1,20}$/;
const REPORT_STATES: readonly string[] = ['STATE_UNSPECIFIED', 'QUEUED', 'RUNNING', 'DONE', 'FAILED'];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function checkId(value: string): void {
  if (!validId(value)) throw new BidManagerError('invalid_request', 'Query and report IDs must be numeric.');
}

function isQuery(value: unknown): value is Query {
  const query = record(value);
  return validId(query?.queryId) && typeof record(query?.metadata)?.title === 'string';
}

function isReport(value: unknown): value is Report {
  const report = record(value);
  const key = record(report?.key);
  const metadata = record(report?.metadata);
  const state = record(metadata?.status)?.state;
  return validId(key?.queryId) && validId(key?.reportId)
    && typeof state === 'string' && REPORT_STATES.includes(state)
    && (metadata?.googleCloudStoragePath === undefined || typeof metadata.googleCloudStoragePath === 'string');
}

export function createBidManagerClient(
  fetch: AuthorizedFetch,
  options: BidManagerClientOptions = {},
): BidManagerClient {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const runtime = resolveRuntime(options.runtime);
  // One latch and one pacer per client: the daily quota and the 4/s limit are per project.
  const latch = createDailyLatch(runtime.now);
  const pacer = createPacer({ minGapMs: BID_MANAGER_MIN_GAP_MS, now: runtime.now, sleep: runtime.sleep });

  const send = createSendJson({
    api: 'bidmanager', fetch, timeoutMs, runtime, latch, pacer,
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
    errors: { classify: classifyHttpError, create: kind => new BidManagerError(kind) },
  });

  type Call = { readonly operation: string; readonly idempotency: Idempotency; readonly call?: CallOptions };

  async function request(path: string, init: SendInit, { operation, idempotency, call }: Call, ignoreBody = false): Promise<unknown> {
    return send(`${BASE_URL}${path}`, init, { ...call, operation, idempotency, ignoreBody });
  }

  async function queryRequest(path: string, init: SendInit, call: Call): Promise<Query> {
    const value = await request(path, init, call);
    if (!isQuery(value)) throw new BidManagerError('unexpected_response');
    return value;
  }

  async function reportRequest(path: string, init: SendInit, call: Call): Promise<Report> {
    const value = await request(path, init, call);
    if (!isReport(value)) throw new BidManagerError('unexpected_response');
    return value;
  }

  function checkPageSize(pageSize: number | undefined): void {
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
      throw new BidManagerError('invalid_request', 'pageSize must be an integer from 1 to 100.');
    }
  }

  function post(body: unknown): SendInit {
    return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }

  return {
    async createQuery(query, call) {
      if (!parseMcpTitle(query.metadata.title)) {
        throw new BidManagerError('invalid_request', 'Only [MCP] queries can be created.');
      }
      // Not repeated on a timeout or 5xx: Google may already have created the query.
      return queryRequest('/queries', post(query), { operation: 'queries.create', idempotency: 'rate_limit_only', call });
    },
    async runQuery(queryId, options, call) {
      checkId(queryId);
      // Not repeated on a timeout or 5xx: Google may already have started the run.
      return reportRequest(`/queries/${queryId}:run`, post(options?.dataRange === undefined ? {} : { dataRange: options.dataRange }),
        { operation: 'queries.run', idempotency: 'rate_limit_only', call });
    },
    async getQuery(queryId, call) {
      checkId(queryId);
      return queryRequest(`/queries/${queryId}`, { method: 'GET' }, { operation: 'queries.get', idempotency: 'idempotent', call });
    },
    async listQueries(options = {}, call) {
      checkPageSize(options.pageSize);
      const params = new URLSearchParams();
      if (options.pageSize !== undefined) params.set('pageSize', String(options.pageSize));
      if (options.pageToken !== undefined) params.set('pageToken', options.pageToken);
      if (options.orderBy !== undefined) params.set('orderBy', options.orderBy);
      const value = record(await request(`/queries${params.size ? `?${params}` : ''}`, { method: 'GET' },
        { operation: 'queries.list', idempotency: 'idempotent', call }));
      const queries = value?.queries === undefined ? [] : value.queries;
      const token = value?.nextPageToken;
      if (!value || !Array.isArray(queries) || !queries.every(isQuery)
        || (token !== undefined && typeof token !== 'string')) {
        throw new BidManagerError('unexpected_response');
      }
      return { queries, ...(token ? { nextPageToken: token as string } : {}) };
    },
    async deleteQuery(queryId, call) {
      checkId(queryId);
      await request(`/queries/${queryId}`, { method: 'DELETE' }, { operation: 'queries.delete', idempotency: 'idempotent', call }, true);
    },
    async getReport(queryId, reportId, call) {
      checkId(queryId);
      checkId(reportId);
      return reportRequest(`/queries/${queryId}/reports/${reportId}`, { method: 'GET' },
        { operation: 'queries.reports.get', idempotency: 'idempotent', call });
    },
    async listReports(queryId, options = {}, call) {
      checkId(queryId);
      checkPageSize(options.pageSize);
      const params = new URLSearchParams();
      if (options.pageSize !== undefined) params.set('pageSize', String(options.pageSize));
      if (options.orderBy !== undefined) params.set('orderBy', options.orderBy);
      const value = record(await request(`/queries/${queryId}/reports${params.size ? `?${params}` : ''}`, { method: 'GET' },
        { operation: 'queries.reports.list', idempotency: 'idempotent', call }));
      const reports = value?.reports === undefined ? [] : value.reports;
      const token = value?.nextPageToken;
      if (!value || !Array.isArray(reports) || !reports.every(isReport)
        || (token !== undefined && typeof token !== 'string')) {
        throw new BidManagerError('unexpected_response');
      }
      return { reports, ...(token ? { nextPageToken: token as string } : {}) };
    },
  };
}
