import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureRentOpsSchema,
  RENT_OPS_REQUIRED_TABLES,
  rentOpsMigrationChecksumForVersion,
  renderRentOpsMigrationSqlForVersion,
  splitRentOpsSqlStatements,
} from "../persistence";

const V9_TABLES = [
  "rent_ops_prospects",
  "rent_ops_application_history",
  "rent_ops_application_interests",
  "rent_ops_application_participants",
  "rent_ops_application_requirement_occurrences",
  "rent_ops_application_template_definitions",
  "rent_ops_application_template_sections",
  "rent_ops_application_template_fields",
  "rent_ops_application_answer_occurrences",
  "rent_ops_application_history_documents",
  "rent_ops_application_history_activities",
  "rent_ops_application_history_blockers",
  "rent_ops_application_history_aggregates",
] as const;

test("v9 migration is rendered from one source and covers the complete immutable history inventory", () => {
  const rendered = renderRentOpsMigrationSqlForVersion(9);
  const statements = splitRentOpsSqlStatements(rendered);

  assert.ok(statements.length >= 50);
  assert.equal(rendered.includes("__RENT_OPS_V9_CHECKSUM__"), false);
  assert.match(rendered, new RegExp(`version = 9 AND checksum_sha256 = '${rentOpsMigrationChecksumForVersion(9)}'`));
  for (const table of V9_TABLES) {
    assert.ok(RENT_OPS_REQUIRED_TABLES.includes(table), `required-table inventory missing ${table}`);
    assert.match(rendered, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  // Occurrences without a resolved application/prospect are retained for the
  // aggregate and must not be rejected by a SQL parent-required check.
  assert.doesNotMatch(rendered, /application_(?:interests|participants|requirements|answers)_parent_check/);
  assert.match(rendered, /rent_ops_application_interests_prospect_link_check/);
  assert.match(rendered, /rent_ops_application_requirements_document_fk/);
  assert.match(rendered, /rent_ops_application_template_fields.*REFERENCES rent_ops_application_template_sections/s);
  assert.match(rendered, /rent_ops_application_answers_restricted_value_check/);
  assert.match(rendered, /availability IN \('metadata','unavailable'\)/);
  assert.doesNotMatch(rendered, /rent_ops_application_history_documents.*availability IN \([^)]*'verified'/s);

  const triggerNames: Record<(typeof V9_TABLES)[number], string> = {
    rent_ops_prospects: "rent_ops_prospects_immutable_guard",
    rent_ops_application_history: "rent_ops_application_history_immutable_guard",
    rent_ops_application_interests: "rent_ops_application_interests_immutable_guard",
    rent_ops_application_participants: "rent_ops_application_participants_immutable_guard",
    rent_ops_application_requirement_occurrences: "rent_ops_application_requirements_immutable_guard",
    rent_ops_application_template_definitions: "rent_ops_application_templates_immutable_guard",
    rent_ops_application_template_sections: "rent_ops_application_template_sections_immutable_guard",
    rent_ops_application_template_fields: "rent_ops_application_template_fields_immutable_guard",
    rent_ops_application_answer_occurrences: "rent_ops_application_answers_immutable_guard",
    rent_ops_application_history_documents: "rent_ops_application_history_documents_immutable_guard",
    rent_ops_application_history_activities: "rent_ops_application_history_activities_immutable_guard",
    rent_ops_application_history_blockers: "rent_ops_application_history_blockers_immutable_guard",
    rent_ops_application_history_aggregates: "rent_ops_application_history_aggregates_immutable_guard",
  };
  for (const table of V9_TABLES) {
    const triggerName = triggerNames[table];
    assert.match(rendered, new RegExp(triggerName));
    assert.match(rendered, new RegExp(`BEFORE UPDATE OR DELETE ON ${table}`));
  }

  // Guarded ALTER statements are still one executable procedural statement;
  // this catches accidental duplicate constraint additions before a real
  // PostgreSQL migration run can fail halfway through the transaction.
  const constraintNames = Array.from(rendered.matchAll(/\b(?:CONSTRAINT|ADD CONSTRAINT)\s+([a-z0-9_]+)/gi), (match) => match[1]);
  assert.equal(constraintNames.length, new Set(constraintNames).size);
});

test("v9 migration source leaves v1-v8 checksums untouched", () => {
  assert.equal(rentOpsMigrationChecksumForVersion(1), "11565d4cb4dc92e06f9e24a6e0dc2ab5c583ec1d4787d262712c71d158a8700b");
  assert.equal(rentOpsMigrationChecksumForVersion(8), "6d38f29b6f05946e8d22cc3273c3dee9cd2f4f05288ae7ede9cb052eb11c2fca");
});

test("v9 is sent through the real transactional migration executor without duplicate procedural constraints", async () => {
  const executed: string[] = [];
  const result = await ensureRentOpsSchema({
    apply: true,
    executor: async (statement) => {
      executed.push(statement);
      if (!statement.startsWith("DO $$")) return;
      // PostgreSQL receives each DO block as one statement.  Inspect the
      // executable ALTER clauses rather than only the source text so a
      // duplicate ADD CONSTRAINT in a guarded branch cannot slip through.
      const addedConstraintNames = Array.from(
        statement.matchAll(/ALTER TABLE\s+\S+\s+ADD CONSTRAINT\s+([a-z0-9_]+)/gi),
        (match) => match[1],
      );
      assert.equal(addedConstraintNames.length, new Set(addedConstraintNames).size);
      if (statement.includes("rent_ops_applications_prospect_fk")) {
        assert.equal(addedConstraintNames.filter((name) => name === "rent_ops_applications_prospect_fk").length, 1);
      }
      assert.match(statement, /END;?\s*\$\$\s*$/s);
    },
  });

  assert.equal(result.mode, "applied");
  assert.equal(executed[0], "BEGIN");
  assert.equal(executed.at(-1), "COMMIT");
  assert.equal(executed.filter((statement) => statement.includes("rent_ops_prospects")).length > 0, true);
  assert.equal(executed.some((statement) => statement.includes("rent_ops_application_history")), true);
  assert.equal(executed.some((statement) => statement.includes("rent_ops_application_history_aggregates")), true);
});
