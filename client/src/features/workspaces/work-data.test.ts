import test from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { invalidateWorkOrderReads } from "./work-data";

test("a work-order change marks the property, make-ready and dashboard copies stale", async () => {
  const client = new QueryClient();
  const open = ["rent-ops-workspace", "work-orders-open", "manager", "org-a", "property-a", true];
  const dashboard = ["rent-ops-workspace", "dashboard-company", "manager", "org-a", "2026-09-23"];
  const rentRoll = ["rent-ops-workspace", "bootstrap", "manager"];
  for (const key of [open, dashboard, rentRoll]) client.setQueryData(key, { items: [] });
  await invalidateWorkOrderReads(client);
  assert.equal(client.getQueryState(open)?.isInvalidated, true);
  assert.equal(client.getQueryState(dashboard)?.isInvalidated, true);
  assert.equal(client.getQueryState(rentRoll)?.isInvalidated, false, "unrelated rental reads keep their cache");
  client.clear();
});
