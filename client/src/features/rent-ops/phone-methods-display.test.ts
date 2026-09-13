import assert from "node:assert/strict";
import test from "node:test";
import { currentPhoneMethods, phoneTypeLabel } from "./phone-methods-display";

test("explicit current phone remains primary over duplicate stale imported methods without mutating history", () => {
  const person = { phone: "941-555-0101", phoneMethods: [
    { id: "old", value: "(941) 555-0202", type: "Mobile", isPrimary: true },
    { id: "duplicate", value: "+1 941 555 0202", type: "Home", isPrimary: true },
    { value: "941.555.0202", type: "Mobile", isPrimary: true },
    { value: "941-555-0303", type: "Work" },
    { value: " " },
  ] };
  const before = structuredClone(person);
  const display = currentPhoneMethods(person);
  assert.equal(display.hasPreviousPrimary, true);
  assert.deepEqual(display.rows.map(row => [row.value, row.isPrimary]), [["941-555-0101", true], ["(941) 555-0202", false], ["941-555-0303", false]]);
  assert.equal(display.rows[1].type, "Mobile / Home");
  assert.deepEqual(person, before);
});

test("current phone matching an imported alternate is promoted once and retains its type", () => {
  const display = currentPhoneMethods({ phone: "941-555-0101", phoneMethods: [{ value: "+1 (941) 555-0101", type: "Mobile", isPrimary: false }, { value: "9415550202", isPrimary: true }] });
  assert.equal(display.rows.length, 2);
  assert.equal(display.rows[0].type, "Mobile");
  assert.equal(display.rows.filter(row => row.isPrimary).length, 1);
});

test("without current phone, distinct extensions and supplied primary metadata remain available", () => {
  const display = currentPhoneMethods({ phoneMethods: [{ value: "9415550101 ext 10", isPrimary: true }, { value: "9415550101 ext 20" }] });
  assert.equal(display.rows.length, 2);
  assert.equal(display.hasPreviousPrimary, false);
  assert.equal(display.rows[0].isPrimary, true);
});


test("numeric imported phone type codes stay out of display without altering editor values", () => {
  assert.equal(phoneTypeLabel("3"), undefined);
  assert.equal(phoneTypeLabel("3 / Home / Work"), "Home / Work");
  assert.equal(phoneTypeLabel("Mobile"), "Mobile");
  const rows = currentPhoneMethods({ phoneMethods: [{ value: "9415550101", type: "3" }] }).rows;
  assert.equal(rows[0].type, "3");
});
