import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeApiPathForLogging } from "./request-logging";

test("redacts applicant resume tokens from logged paths", () => {
  assert.equal(
    sanitizeApiPathForLogging(
      "/api/rent-ops/public/applications/super-secret-token/documents",
    ),
    "/api/rent-ops/public/applications/:token/documents",
  );
  assert.equal(
    sanitizeApiPathForLogging("/apply?resume=super-secret-token&source=listing"),
    "/apply?resume=:redacted&source=listing",
  );
  assert.equal(
    sanitizeApiPathForLogging("/apply?source=listing&token=super-secret-token"),
    "/apply?source=listing&token=:redacted",
  );
});

test("leaves unrelated API paths unchanged", () => {
  assert.equal(
    sanitizeApiPathForLogging("/api/rent-ops/reports/rent-roll"),
    "/api/rent-ops/reports/rent-roll",
  );
});
