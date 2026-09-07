import assert from "node:assert/strict";
import test from "node:test";

import { nowIsoDate } from "./dates";

test("operational dates follow the Eastern business day instead of UTC midnight", () => {
  assert.equal(nowIsoDate(new Date("2026-08-17T02:30:00.000Z")), "2026-08-16");
  assert.equal(nowIsoDate(new Date("2026-08-17T04:30:00.000Z")), "2026-08-17");
});
