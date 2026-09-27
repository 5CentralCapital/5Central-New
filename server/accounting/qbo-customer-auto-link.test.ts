import { test } from "node:test";
import assert from "node:assert/strict";
import { addressMatches, matchTenanciesToCustomers, nameMatches, type AutoLinkCustomer, type AutoLinkTenancy } from "./qbo-customer-auto-link";

const tenancy = (tenancyId: string, firstName: string, lastName: string, propertyName: string, unitNumber: string, propertyAddress: string | null = null): AutoLinkTenancy => ({ tenancyId, firstName, lastName, propertyName, unitNumber, propertyAddress });
const customer = (objectId: string, names: string[], addresses: string[] = []): AutoLinkCustomer => ({ legalEntityId: "entity", realmId: "1", objectId, names, addresses });

test("name and address must both match", () => {
  const herbert = tenancy("t1", "Herbert", "Bartee", "Sun Cove Apartments", "Lot 7");
  assert.equal(nameMatches(herbert, customer("1", ["Herbert Bartee"])), true);
  assert.equal(nameMatches(herbert, customer("1", ["Lot 7"])), false);
  assert.equal(addressMatches(herbert, customer("1", ["Herbert Bartee"], ["Sun Cove Lot 7"])), true);
  assert.equal(addressMatches(herbert, customer("1", ["Herbert Bartee"], ["Lot 7"])), false, "unit alone is not enough without the property");
  assert.equal(addressMatches(herbert, customer("1", ["Herbert Bartee"], ["Sun Cove Lot 6"])), false);
});

test("a unit that is a street address matches on its own; property street address also counts", () => {
  const jadore = tenancy("t2", "Jadore", "Brown", "Hickory Landing", "613 Plateau Ave");
  assert.equal(addressMatches(jadore, customer("2", ["Jadore Brown"], ["613 Plateau Ave", "Lakeland"])), true);
  const annette = tenancy("t3", "Annette", "Arguelles", "Lucia Apartments", "669 - 4", "669 Avenue D NW");
  assert.equal(addressMatches(annette, customer("3", ["Annette Arguelles"], ["669 Avenue D NW Apt 4"])), true);
  assert.equal(addressMatches(annette, customer("3", ["Annette Arguelles - Lucia 669-4"])), true, "address in the display name counts");
});

test("only unique matches in both directions are linked", () => {
  const a = tenancy("a", "Jose", "Cruz", "Lucia Apartments", "658");
  const b = tenancy("b", "Ismael", "Cruz", "Sun Cove Apartments", "C6");
  const matches = matchTenanciesToCustomers([a, b], [
    customer("10", ["Jose Cruz"], ["Lucia 658"]),
    customer("11", ["Ismael Cruz"], ["Sun Cove C6"]),
  ]);
  assert.deepEqual(matches.map(match => [match.tenancyId, match.customer.objectId]), [["a", "10"], ["b", "11"]]);

  const duplicate = matchTenanciesToCustomers([a], [customer("10", ["Jose Cruz"], ["Lucia 658"]), customer("12", ["Jose Cruz Jr"], ["Lucia Apartments 658"])]);
  assert.deepEqual(duplicate, [], "two candidate customers → no automatic link");

  const same = tenancy("c", "Jose", "Cruz", "Lucia Apartments", "658");
  assert.deepEqual(matchTenanciesToCustomers([a, same], [customer("10", ["Jose Cruz"], ["Lucia 658"])]), [], "one customer for two tenancies → no automatic link");
});

test("a street-named property matches on its house number and street word", () => {
  const tamara = tenancy("t4", "Tamara", "Smith", "3408 E Dr MLK BLVD", "#1", "3408 E Dr MLK Blvd");
  assert.equal(addressMatches(tamara, customer("4", ["Tamara Smith"], ["3408 E Dr Martin Luther King Jr Blvd #1"])), false, "a different spelling of the street is not assumed");
  assert.equal(addressMatches(tamara, customer("4", ["Tamara Smith"], ["3408 MLK Blvd Unit 1"])), true);
  assert.equal(addressMatches(tamara, customer("4", ["Tamara Smith"], ["3408 MLK Blvd Unit 2"])), false, "the unit must match");
});
