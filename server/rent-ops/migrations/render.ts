import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { renderRentOpsMigrationSqlForVersion, rentOpsMigrationChecksumForVersion, rentOpsMigrationDefinitions } from "../persistence";

const requestedTargets = process.argv.slice(2).filter(Boolean).map((path) => resolve(path));
const target = requestedTargets[0] ?? resolve("dist/migrations/001_rent_ops.sql");

async function main(): Promise<void> {
  const outputDirectory = dirname(target);
  await mkdir(outputDirectory, { recursive: true });
  const definitions = rentOpsMigrationDefinitions();
  const outputs = definitions.map((definition, index) => requestedTargets[index] ?? join(outputDirectory, definition.fileName));
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];
    await writeFile(outputs[index], renderRentOpsMigrationSqlForVersion(definition.version), "utf8");
  }
  // Preserve the caller's requested v1 path for existing deployment scripts;
  // v2 is emitted alongside it as an immutable ordered sibling.
  if (resolve(target) !== resolve(outputs[0])) await writeFile(target, renderRentOpsMigrationSqlForVersion(1), "utf8");
  console.log(JSON.stringify({ outputs, checksums: Object.fromEntries(definitions.map((definition) => [definition.version, rentOpsMigrationChecksumForVersion(definition.version)])) }, null, 2));
}

void main();
