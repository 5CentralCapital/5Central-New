import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOpenTabs, openTabKey } from "./open-tabs";
import type { WorkspaceRoute } from "./workspace-state";

const route = (section: WorkspaceRoute["section"], recordId?: string, extra: Partial<WorkspaceRoute> = {}): WorkspaceRoute => ({ section, tab: "summary", report: "rent-roll", ...(recordId ? { recordId } : {}), ...extra });
const keys = (tabs: WorkspaceRoute[]) => tabs.map(openTabKey);

test("records open as tabs; sub-views update the same tab", () => {
  let tabs = nextOpenTabs([], route("dashboard"));
  tabs = nextOpenTabs(tabs, route("tenants", "a"));
  tabs = nextOpenTabs(tabs, route("tenants", "a", { tab: "ledger" }));
  tabs = nextOpenTabs(tabs, route("tenants", "b"));
  assert.deepEqual(keys(tabs), keys([route("dashboard"), route("tenants", "a"), route("tenants", "b")]));
  assert.equal(tabs[1]!.tab, "ledger", "switching back restores the sub-tab");
});

test("a section landing becomes the record it opens", () => {
  let tabs = nextOpenTabs([route("dashboard")], route("tenants"));
  tabs = nextOpenTabs(tabs, route("tenants", "a"));
  assert.deepEqual(keys(tabs), keys([route("dashboard"), route("tenants", "a")]));
});
