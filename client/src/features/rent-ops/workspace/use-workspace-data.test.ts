import assert from 'node:assert/strict';
import test from 'node:test';
import { onlineManager, QueryClient, QueryObserver } from '@tanstack/react-query';
import { refreshWorkspaceQueriesRequired } from './use-workspace-data';

const bootstrapKey = ['rent-ops-workspace', 'bootstrap', 'scope'] as const;

function clientWithActiveBootstrap(queryFn: () => Promise<unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(client, { queryKey: bootstrapKey, queryFn });
  const unsubscribe = observer.subscribe(() => undefined);
  return { client, observer, unsubscribe };
}

test('required workspace refresh rejects when an active occupancy read fails', async () => {
  let calls = 0;
  const { client, observer, unsubscribe } = clientWithActiveBootstrap(async () => {
    calls += 1;
    if (calls > 1) throw new Error('occupancy read failed');
    return { generatedAt: '2026-09-12T00:00:00.000Z' };
  });
  try {
    await observer.refetch();
    await assert.rejects(() => refreshWorkspaceQueriesRequired(client, [bootstrapKey]), /occupancy read failed/);
    assert.equal(calls, 2);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test('required workspace refresh resolves only after the active read succeeds', async () => {
  let calls = 0;
  const { client, observer, unsubscribe } = clientWithActiveBootstrap(async () => {
    calls += 1;
    return { generatedAt: `2026-09-12T00:00:0${calls}.000Z` };
  });
  try {
    await observer.refetch();
    await refreshWorkspaceQueriesRequired(client, [bootstrapKey]);
    assert.equal(calls, 2);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test('required workspace refresh rejects when the active occupancy read is paused', async () => {
  onlineManager.setOnline(true);
  let calls = 0;
  const { client, observer, unsubscribe } = clientWithActiveBootstrap(async () => {
    calls += 1;
    return { generatedAt: `2026-09-12T00:00:0${calls}.000Z` };
  });
  try {
    await observer.refetch();
    onlineManager.setOnline(false);
    await assert.rejects(() => refreshWorkspaceQueriesRequired(client, [bootstrapKey]), /could not be refreshed/);
    const state = client.getQueryState(bootstrapKey);
    assert.equal(state?.fetchStatus, 'paused');
    assert.equal(state?.isInvalidated, true);
    assert.equal(calls, 1);
  } finally {
    onlineManager.setOnline(true);
    unsubscribe();
    client.clear();
  }
});

test('required workspace refresh rejects when the required read is unmounted during refresh', async () => {
  let calls = 0;
  let unsubscribe = () => undefined;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(client, {
    queryKey: bootstrapKey,
    queryFn: async () => {
      calls += 1;
      if (calls > 1) unsubscribe();
      return { generatedAt: `2026-09-12T00:00:0${calls}.000Z` };
    },
  });
  unsubscribe = observer.subscribe(() => undefined);
  try {
    await observer.refetch();
    await assert.rejects(() => refreshWorkspaceQueriesRequired(client, [bootstrapKey]), /could not be refreshed/);
    assert.equal(calls, 2);
  } finally {
    unsubscribe();
    client.clear();
  }
});
