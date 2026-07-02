import { useCallback, useMemo, useRef, useState } from 'react';

export type ItemStatus = 'pending' | 'active' | 'done' | 'error' | 'cancelled';

export interface BatchItem<TArgs, TResult> {
  id: string;
  args: TArgs;
  status: ItemStatus;
  result?: TResult;
  error?: Error;
  startedAt?: number;
  finishedAt?: number;
}

export interface UseBatchProcessorOptions<TResult> {
  /** Maximum number of items running at once. */
  concurrency?: number;
  /** Called for each item; should return a promise that respects the AbortSignal. */
  run: (args: unknown, signal: AbortSignal) => Promise<TResult>;
  /** Called when a single item completes successfully. */
  onItemDone?: (id: string, result: TResult) => void;
}

export interface BatchController<TArgs, TResult> {
  items: BatchItem<TArgs, TResult>[];
  enqueue: (args: TArgs) => string;
  enqueueMany: (argsList: TArgs[]) => string[];
  retry: (id: string) => void;
  cancel: (id?: string) => void;
  reset: () => void;
  /** Remove a single item from the list (also cancels it if active). */
  removeItem: (id: string) => void;
  /** Convenience booleans. */
  isRunning: boolean;
  isDone: boolean;
  hasErrors: boolean;
  progress: { done: number; total: number; active: number; pending: number; errored: number };
}

let _idCounter = 0;
const nextId = () => `item-${++_idCounter}-${Date.now().toString(36)}`;

/**
 * Generic bounded-concurrency batch runner.
 *
 * - Items are added to a queue.
 * - Up to `concurrency` items are active at once.
 * - `cancel(id)` aborts a single item; `cancel()` aborts everything.
 * - `retry(id)` re-queues an errored/cancelled item.
 * - Per-item AbortController is owned here so we can cancel in-flight calls
 *   (the `run` callback must respect the signal it receives).
 */
export function useBatchProcessor<TArgs, TResult>(
  opts: UseBatchProcessorOptions<TResult>,
): BatchController<TArgs, TResult> {
  const { concurrency = 2, run, onItemDone } = opts;
  const [items, setItems] = useState<BatchItem<TArgs, TResult>[]>([]);
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const updateItem = useCallback((id: string, patch: Partial<BatchItem<TArgs, TResult>>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const removeItem = useCallback((id: string) => {
    controllersRef.current.get(id)?.abort();
    controllersRef.current.delete(id);
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const startNext = useCallback(() => {
    // Pick the next 'pending' item and activate it. Bound by `concurrency`.
    const state = itemsRef.current;
    const activeCount = state.filter((it) => it.status === 'active').length;
    if (activeCount >= concurrency) return;
    const next = state.find((it) => it.status === 'pending');
    if (!next) return;

    const controller = new AbortController();
    controllersRef.current.set(next.id, controller);
    updateItem(next.id, { status: 'active', startedAt: Date.now() });

    run(next.args, controller.signal)
      .then((result) => {
        controllersRef.current.delete(next.id);
        updateItem(next.id, { status: 'done', result, finishedAt: Date.now() });
        onItemDone?.(next.id, result);
      })
      .catch((error: Error) => {
        controllersRef.current.delete(next.id);
        const wasAborted = error?.name === 'AbortError';
        updateItem(next.id, {
          status: wasAborted ? 'cancelled' : 'error',
          error,
          finishedAt: Date.now(),
        });
      })
      .finally(() => {
        // Try to start another pending item.
        startNext();
      });
  }, [run, updateItem, onItemDone, concurrency]);

  const enqueue = useCallback(
    (args: TArgs): string => {
      const id = nextId();
      const activeCount = itemsRef.current.filter((it) => it.status === 'active').length;
      const initialStatus: ItemStatus = activeCount >= concurrency ? 'pending' : 'active';
      setItems((prev) => [...prev, { id, args, status: initialStatus }]);

      if (initialStatus === 'pending') {
        window.setTimeout(startNext, 0);
        return id;
      }

      const controller = new AbortController();
      controllersRef.current.set(id, controller);
      const patch = (status: ItemStatus, extra: Partial<BatchItem<TArgs, TResult>> = {}) => {
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status, ...extra } : it)));
      };

      patch('active', { startedAt: Date.now() });

      run(args, controller.signal)
        .then((result) => {
          controllersRef.current.delete(id);
          patch('done', { result, finishedAt: Date.now() });
          onItemDone?.(id, result);
          window.setTimeout(startNext, 0);
        })
        .catch((error: Error) => {
          controllersRef.current.delete(id);
          const wasAborted = error?.name === 'AbortError';
          patch(wasAborted ? 'cancelled' : 'error', { error, finishedAt: Date.now() });
          window.setTimeout(startNext, 0);
        });

      return id;
    },
    [run, onItemDone, startNext, concurrency],
  );

  const enqueueMany = useCallback(
    (argsList: TArgs[]): string[] => {
      // First item runs immediately; the rest are 'pending' and will be
      // picked up as active items complete.
      if (argsList.length === 0) return [];
      const ids: string[] = [];
      ids.push(enqueue(argsList[0]));
      for (let i = 1; i < argsList.length; i++) {
        const id = nextId();
        setItems((prev) => [...prev, { id, args: argsList[i], status: 'pending' }]);
        ids.push(id);
      }
      // Try to start more items up to concurrency.
      window.setTimeout(startNext, 0);
      return ids;
    },
    [enqueue, startNext],
  );

  const cancel = useCallback(
    (id?: string) => {
      if (id) {
        const ctrl = controllersRef.current.get(id);
        ctrl?.abort();
        controllersRef.current.delete(id);
        setItems((prev) =>
          prev.map((it) =>
            it.id === id && (it.status === 'active' || it.status === 'pending')
              ? { ...it, status: 'cancelled' as ItemStatus, finishedAt: Date.now() }
              : it,
          ),
        );
      } else {
        controllersRef.current.forEach((c) => c.abort());
        controllersRef.current.clear();
        setItems((prev) =>
          prev.map((it) =>
            it.status === 'active' || it.status === 'pending'
              ? { ...it, status: 'cancelled' as ItemStatus, finishedAt: Date.now() }
              : it,
          ),
        );
      }
      // Start another if we just freed a slot.
      window.setTimeout(startNext, 0);
    },
    [startNext],
  );

  const retry = useCallback(
    (id: string) => {
      // Make the failed item pending again. The active loop will pick it up.
      setItems((prev) =>
        prev.map((it) =>
          it.id === id && (it.status === 'error' || it.status === 'cancelled')
            ? { ...it, status: 'pending', error: undefined, finishedAt: undefined }
            : it,
        ),
      );
      window.setTimeout(startNext, 0);
    },
    [startNext],
  );

  const reset = useCallback(() => {
    cancel();
    setItems([]);
  }, [cancel]);

  const isRunning = items.some((it) => it.status === 'active' || it.status === 'pending');
  const isDone = items.length > 0 && !isRunning;
  const hasErrors = items.some((it) => it.status === 'error');
  const progress = useMemo(() => {
    const done = items.filter((it) => it.status === 'done').length;
    const active = items.filter((it) => it.status === 'active').length;
    const pending = items.filter((it) => it.status === 'pending').length;
    const errored = items.filter((it) => it.status === 'error').length;
    return { done, total: items.length, active, pending, errored };
  }, [items]);

  return {
    items,
    enqueue,
    enqueueMany,
    retry,
    cancel,
    reset,
    removeItem,
    isRunning,
    isDone,
    hasErrors,
    progress,
  };
}
