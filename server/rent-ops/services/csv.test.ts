import assert from "node:assert/strict";
import test from "node:test";
import { toCsv } from "./csv";

test("CSV keeps negative amounts numeric while neutralizing formula text", () => {
  const csv = toCsv([{ balanceCents: -5025, paid: true, name: "=HYPERLINK(\"x\")", note: "-1+1", tab: "\tcmd", plain: "a,b" }]);
  assert.equal(csv, [
    "balanceCents,paid,name,note,tab,plain",
    "-5025,true,\"'=HYPERLINK(\"\"x\"\")\",'-1+1,'\tcmd,\"a,b\"",
  ].join("\n"));
});
