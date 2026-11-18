import type { CallOptions } from '../google/request.js';
import type { BidManagerClient } from './client.js';
import { BidManagerError } from './errors.js';
import { isExpiredMcpTitle } from './titles.js';

export type CleanupResult = {
  readonly status: 'completed' | 'skipped';
  readonly deletedQueryIds: readonly string[];
  readonly warnings: readonly string[];
};

export type QueryCleanup = { run(call?: CallOptions): Promise<CleanupResult> };

const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 2;
const MAX_DELETES_PER_RUN = 5;
const ORDER_BY = 'queryId';
const CLEANUP_WARNING = 'Old [MCP] queries could not be cleaned up this time.';
const RESET_WARNING = 'The cleanup position for old [MCP] queries was reset.';
export const CLEANUP_MIN_INTERVAL_MS = 30 * 60_000;

export function createQueryCleanup(
  client: Pick<BidManagerClient, 'listQueries' | 'deleteQuery'>,
  dependencies?: { readonly now?: () => Date; readonly minIntervalMs?: number },
): QueryCleanup {
  const now = dependencies?.now ?? (() => new Date());
  const minIntervalMs = dependencies?.minIntervalMs ?? 0;
  let cursor: string | undefined;
  let running = false;
  let lastCompletedAt: number | undefined;

  return {
    async run(call?: CallOptions): Promise<CleanupResult> {
      if (running) {
        return { status: 'skipped', deletedQueryIds: [], warnings: [] };
      }

      running = true;
      const deletedQueryIds: string[] = [];
      const warnings: string[] = [];
      const result: CleanupResult = { status: 'completed', deletedQueryIds, warnings };
      let cut = false;
      let throttled = false;
      const deadlineReached = () => {
        if (call?.deadline !== undefined && now().getTime() >= call.deadline) cut = true;
        return cut;
      };

      // Cleanup is best-effort: one attempt per call, never retried.
      const single: CallOptions = { ...call, singleAttempt: true };
      try {
        const runNow = now();
        if (lastCompletedAt !== undefined && runNow.getTime() - lastCompletedAt < minIntervalMs) {
          throttled = true;
          return { status: 'skipped', deletedQueryIds: [], warnings: [] };
        }
        for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_RUN; pageIndex++) {
          if (deadlineReached()) return result;
          let page;
          try {
            page = await client.listQueries({ pageSize: PAGE_SIZE, orderBy: ORDER_BY, pageToken: cursor }, single);
          } catch (error) {
            // Google returned 500 for a bad page token (verified live, 2026-11-06).
            if (cursor !== undefined && error instanceof BidManagerError
              && (error.kind === 'invalid_request' || error.kind === 'server_error')) {
              cursor = undefined;
              warnings.push(RESET_WARNING);
            } else {
              warnings.push(CLEANUP_WARNING);
            }
            return result;
          }

          const eligible = page.queries.filter(query => isExpiredMcpTitle(query.metadata.title, runNow));
          for (const query of eligible) {
            // Keep the page position if its remaining candidates exceed this run's budget.
            if (deletedQueryIds.length === MAX_DELETES_PER_RUN) return result;
            if (deadlineReached()) return result;
            try {
              await client.deleteQuery(query.queryId, single);
            } catch (error) {
              if (!(error instanceof BidManagerError) || error.kind !== 'not_found') throw error;
            }
            deletedQueryIds.push(query.queryId);
          }

          cursor = page.nextPageToken;
          if (cursor === undefined) return result;
        }
      } catch {
        warnings.push(CLEANUP_WARNING);
      } finally {
        running = false;
        if (minIntervalMs > 0 && !cut && !throttled && warnings.length === 0) {
          try { lastCompletedAt = now().getTime(); } catch { warnings.push(CLEANUP_WARNING); }
        }
      }

      return result;
    },
  };
}
