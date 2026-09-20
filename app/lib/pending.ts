/**
 * Everything waiting for a decision, across every paired account.
 *
 * This lives above the screens because the tab bar needs the count even while
 * the owner is looking at the Accounts tab — a badge that only updates on the
 * screen it describes is not a badge.
 *
 * Polls as well as listening for pushes: a push can be dropped, throttled or
 * denied permission, and the design says the request must still turn up here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account } from './accounts';
import { ApiError } from './api';
import type { PendingRequest } from './api';
import { clientFor } from './pairing';
import { byNewestFirst, isExpired } from './time';

const POLL_MS = 15_000;
/** How often expired requests are dropped from the list and the badge. */
const PRUNE_MS = 1_000;

export interface PendingItem {
  account: Account;
  request: PendingRequest;
}

export interface Pending {
  /** Unexpired requests, newest first. */
  items: PendingItem[];
  /** What to say when one or more accounts could not be reached. */
  problem: string | null;
  /** True only until the first fetch settles, so the empty state does not flash. */
  loading: boolean;
  reload: () => Promise<void>;
}

export function usePendingRequests(accounts: Account[]): Pending {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [, tick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    if (accounts.length === 0) {
      setItems([]);
      setProblem(null);
      setLoading(false);
      return;
    }
    // One account being unreachable must not hide the others' requests.
    const results = await Promise.all(
      accounts.map(async account => {
        try {
          const requests = await clientFor(account).listRequests();
          return { account, requests, error: null as string | null };
        } catch (err) {
          const message =
            err instanceof ApiError ? err.message : 'Could not reach the approval server.';
          return { account, requests: [] as PendingRequest[], error: message };
        }
      }),
    );
    if (!mounted.current) return;

    setItems(
      results
        .flatMap(r => r.requests.map(request => ({ account: r.account, request })))
        .sort((a, b) => byNewestFirst(a.request, b.request)),
    );

    const failed = results.filter(r => r.error);
    setProblem(
      failed.length === 0
        ? null
        : failed.length === accounts.length
          ? failed[0].error
          : `${failed.length} of ${accounts.length} accounts could not be reached.`,
    );
    setLoading(false);
  }, [accounts]);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(id);
  }, [reload]);

  // A separate, cheap timer: expiry is a clock event, not a network one, and a
  // request that has run out must leave the list and the badge immediately.
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), PRUNE_MS);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  return {
    items: items.filter(item => !isExpired(item.request.expiresAt, now)),
    problem,
    loading,
    reload,
  };
}
