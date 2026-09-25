import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  emptyRentOpsSnapshot,
  type RentOpsLedgerTransaction,
  type RentOpsPaymentAllocation,
  type RentOpsSnapshot,
} from "../../shared/rent-ops-contracts.ts";
import { syntheticRentOpsSnapshot } from "../../server/rent-ops/fixtures/synthetic.ts";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../../server/rent-ops/repositories/postgres.ts";
import { RentOpsService } from "../../server/rent-ops/services/service.ts";
import { presentTenantHome } from "../../server/rent-ops/tenant-portal/presentation.ts";
import type { TenantIdentity } from "../../shared/tenant-portal-contracts.ts";

const UNITS = 200;
const START_YEAR = 2019;
const MONTHS = 84;
const AS_OF_DATE = "2025-12-31";
const FILTERS = { propertyScope: "active" as const, asOfDate: AS_OF_DATE, month: "2025-12" };
const DEFAULT_WAVES = 3;
const DEFAULT_REPORT_PATH = "docs/company/audit2-memory-measurements.json";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../..");

type Scenario = "cached" | "uncached";
type ReadSet = "mixed" | "dashboard" | "portal";

interface FixtureCounts {
  properties: number;
  units: number;
  people: number;
  tenancies: number;
  leaseTerms: number;
  recurringSchedules: number;
  ledgerTransactions: number;
  paymentAllocations: number;
  monthsPerUnit: number;
}

interface MeasurementResult {
  scenario: Scenario;
  readSet: ReadSet;
  waves: number;
  counts: FixtureCounts;
  fixtureBytes: number;
  fixtureReadMs: number;
  fixtureReadRssMiB: number;
  scenarioStartRssMiB: number;
  peakRssMiB: number;
  peakDeltaMiB: number;
  totalScenarioMs: number;
  coldWaveMs: number;
  warmWaveMs: number[];
  waveP50Ms: number;
  waveP95Ms: number;
  loaderCalls: { report: number; operational: number };
}

const counts: FixtureCounts = {
  properties: 1,
  units: UNITS,
  people: UNITS,
  tenancies: UNITS,
  leaseTerms: UNITS,
  recurringSchedules: UNITS,
  ledgerTransactions: UNITS * MONTHS * 2,
  paymentAllocations: UNITS * MONTHS,
  monthsPerUnit: MONTHS,
};

const monthAt = (index: number): string => {
  const year = START_YEAR + Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
};

function buildSyntheticSnapshot(): RentOpsSnapshot {
  const source = syntheticRentOpsSnapshot();
  const property = structuredClone(source.properties[0]);
  property.id = "synthetic-property-200";
  property.name = "Synthetic 200 Unit Portfolio";
  property.slug = "synthetic-200-unit-portfolio";
  const chargeDefinition = structuredClone(source.chargeDefinitions.find(row => row.category === "base_rent")!);
  chargeDefinition.id = "synthetic-charge-definition-base-rent";
  const chargeTemplate = structuredClone(source.ledgerTransactions.find(row => row.kind === "charge" && row.category === "base_rent")!);
  const paymentTemplate = structuredClone(source.ledgerTransactions.find(row => row.kind === "payment" && row.payer === "tenant")!);
  const allocationTemplate = structuredClone(source.paymentAllocations[0]);
  const unitTemplate = structuredClone(source.units[0]);
  const personTemplate = structuredClone(source.people[0]);
  const tenancyTemplate = structuredClone(source.tenancies[0]);
  const leaseTemplate = structuredClone(source.leaseTerms[0]);
  const householdTemplate = structuredClone(source.householdMemberships[0]);
  const scheduleTemplate = structuredClone(source.recurringSchedules[0]);
  const depositTemplate = structuredClone(source.securityDeposits[0]);

  const snapshot = emptyRentOpsSnapshot();
  snapshot.properties = [property];
  snapshot.chargeDefinitions = [chargeDefinition];
  for (let index = 0; index < UNITS; index++) {
    const suffix = String(index).padStart(3, "0");
    const unitId = `synthetic-unit-${suffix}`;
    const personId = `synthetic-person-${suffix}`;
    const tenancyId = `synthetic-tenancy-${suffix}`;
    const leaseId = `synthetic-lease-${suffix}`;
    const scheduleId = `synthetic-schedule-${suffix}`;
    const unit = { ...structuredClone(unitTemplate), id: unitId, propertyId: property.id, unitNumber: `${index + 1}`, marketRentCents: 120000, defaultDepositCents: 120000 };
    const person = { ...structuredClone(personTemplate), id: personId, firstName: "Synthetic", lastName: `Resident ${suffix}`, email: `resident-${suffix}@synthetic.example.test` };
    const tenancy = { ...structuredClone(tenancyTemplate), id: tenancyId, propertyId: property.id, unitId, primaryPersonId: personId, status: "current" as const, actualMoveInOn: `${START_YEAR}-01-01` };
    const lease = { ...structuredClone(leaseTemplate), id: leaseId, tenancyId, contractStartOn: `${START_YEAR}-01-01`, contractEndOn: AS_OF_DATE, monthToMonth: false };
    const household = { ...structuredClone(householdTemplate), id: `synthetic-household-${suffix}`, tenancyId, personId };
    const schedule = { ...structuredClone(scheduleTemplate), id: scheduleId, scopeId: personId, chargeDefinitionId: chargeDefinition.id, tenancyId, personId, propertyId: property.id, unitId, amountCents: 120000, effectiveFrom: `${START_YEAR}-01-01`, lineageRootId: scheduleId };
    const deposit = { ...structuredClone(depositTemplate), id: `synthetic-deposit-${suffix}`, propertyId: property.id, unitId, tenancyId, personId, amountHeldCents: 120000, receivedOn: `${START_YEAR}-01-01` };
    snapshot.units.push(unit);
    snapshot.people.push(person);
    snapshot.tenancies.push(tenancy);
    snapshot.leaseTerms.push(lease);
    snapshot.householdMemberships.push(household);
    snapshot.recurringSchedules.push(schedule);
    snapshot.securityDeposits.push(deposit);

    for (let monthIndex = 0; monthIndex < MONTHS; monthIndex++) {
      const month = monthAt(monthIndex);
      const chargeId = `synthetic-charge-${suffix}-${month}`;
      const paymentId = `synthetic-payment-${suffix}-${month}`;
      const charge: RentOpsLedgerTransaction = {
        ...structuredClone(chargeTemplate),
        id: chargeId,
        propertyId: property.id,
        unitId,
        tenancyId,
        personId,
        amountCents: 120000,
        postedOn: `${month}-01`,
        dueOn: `${month}-01`,
        description: `${month} base rent`,
        chargeDefinitionId: chargeDefinition.id,
        chargeDefinitionLinkKnowledge: "manual",
      };
      const payment: RentOpsLedgerTransaction = {
        ...structuredClone(paymentTemplate),
        id: paymentId,
        propertyId: property.id,
        unitId,
        tenancyId,
        personId,
        amountCents: 120000,
        postedOn: `${month}-03`,
        description: `${month} tenant payment`,
      };
      const allocation: RentOpsPaymentAllocation = {
        ...structuredClone(allocationTemplate),
        id: `synthetic-allocation-${suffix}-${month}`,
        paymentTransactionId: paymentId,
        chargeTransactionId: chargeId,
        amountCents: 120000,
        allocatedOn: `${month}-03`,
      };
      snapshot.ledgerTransactions.push(charge, payment);
      snapshot.paymentAllocations.push(allocation);
    }
  }
  return snapshot;
}

const rssMiB = (): number => process.memoryUsage().rss / 1024 / 1024;
const rounded = (value: number): number => Number(value.toFixed(2));

async function measure(fixturePath: string, scenario: Scenario, readSet: ReadSet, waves: number): Promise<MeasurementResult> {
  const fixtureReadStart = performance.now();
  const serialized = readFileSync(fixturePath, "utf8");
  const fixtureReadMs = performance.now() - fixtureReadStart;
  if (typeof global.gc === "function") global.gc();
  const scenarioStartRss = rssMiB();
  const loaderCalls = { report: 0, operational: 0 };
  const client: RentOpsQueryExecutor = { query: async () => ({ rows: [] }) };
  if (scenario === "cached") client.readCacheVersion = () => 1;
  const repository = new PostgresRentOpsRepository(client);
  const repositoryAny = repository as unknown as {
    loadReportSnapshot: () => Promise<RentOpsSnapshot>;
    loadOperationalSnapshot: () => Promise<RentOpsSnapshot>;
  };
  repositoryAny.loadReportSnapshot = async () => {
    await new Promise<void>(resolveNext => setImmediate(resolveNext));
    loaderCalls.report++;
    return JSON.parse(serialized) as RentOpsSnapshot;
  };
  repositoryAny.loadOperationalSnapshot = async () => {
    await new Promise<void>(resolveNext => setImmediate(resolveNext));
    loaderCalls.operational++;
    return JSON.parse(serialized) as RentOpsSnapshot;
  };
  const service = new RentOpsService(repository, () => new Date("2025-12-31T17:00:00.000Z"));
  const identity: TenantIdentity = {
    id: "synthetic-account-000",
    email: "resident-000@synthetic.example.test",
    personId: "synthetic-person-000",
    tenancyId: "synthetic-tenancy-000",
    status: "active",
  };
  const portalRead = async () => {
    const snapshot = repository.getOperationalSnapshot ? await repository.getOperationalSnapshot() : await repository.getSnapshot();
    const home = presentTenantHome(snapshot, identity, AS_OF_DATE);
    assert.ok(home, "synthetic tenant portal binding did not resolve");
    assert.equal(home.balance.asOfDate, AS_OF_DATE);
    return home;
  };
  const readWave = async (): Promise<number> => {
    const started = performance.now();
    if (readSet === "dashboard") {
      await Promise.all([service.dashboard(FILTERS), service.dashboard(FILTERS)]);
    } else if (readSet === "portal") {
      await Promise.all([portalRead(), portalRead()]);
    } else {
      await Promise.all([service.dashboard(FILTERS), service.dashboard(FILTERS), portalRead(), portalRead()]);
    }
    return performance.now() - started;
  };

  let peakRss = scenarioStartRss;
  const sample = () => { peakRss = Math.max(peakRss, rssMiB()); };
  const sampler = setInterval(sample, 2);
  const waveMs: number[] = [];
  const scenarioStart = performance.now();
  try {
    for (let index = 0; index < waves; index++) {
      waveMs.push(await readWave());
      sample();
    }
  } finally {
    clearInterval(sampler);
    sample();
  }
  const sorted = [...waveMs].sort((left, right) => left - right);
  const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    scenario,
    readSet,
    waves,
    counts,
    fixtureBytes: Buffer.byteLength(serialized),
    fixtureReadMs: rounded(fixtureReadMs),
    fixtureReadRssMiB: rounded(scenarioStartRss),
    scenarioStartRssMiB: rounded(scenarioStartRss),
    peakRssMiB: rounded(peakRss),
    peakDeltaMiB: rounded(peakRss - scenarioStartRss),
    totalScenarioMs: rounded(performance.now() - scenarioStart),
    coldWaveMs: rounded(waveMs[0]),
    warmWaveMs: waveMs.slice(1).map(rounded),
    waveP50Ms: rounded(percentile(0.5)),
    waveP95Ms: rounded(percentile(0.95)),
    loaderCalls,
  };
}

function parseScenario(value: string | undefined): Scenario {
  if (value !== "cached" && value !== "uncached") throw new Error(`Expected cached or uncached scenario, got ${value ?? "missing"}`);
  return value;
}

function parseReadSet(value: string | undefined): ReadSet {
  if (value !== "mixed" && value !== "dashboard" && value !== "portal") throw new Error(`Expected mixed, dashboard, or portal read set, got ${value ?? "missing"}`);
  return value;
}

function parseWaves(value: string | undefined): number {
  const waves = Number(value ?? DEFAULT_WAVES);
  if (!Number.isSafeInteger(waves) || waves < 1 || waves > 10) throw new Error("Waves must be an integer from 1 through 10");
  return waves;
}

function childArgs(mode: "generate" | "measure", fixturePath: string, scenario?: Scenario): string[] {
  return ["--expose-gc", "--import", "tsx/esm", SCRIPT_PATH, `--${mode}`, "--fixture", fixturePath,
    ...(scenario ? ["--scenario", scenario] : [])];
}

function runChild(args: string[], env: NodeJS.ProcessEnv): string {
  const child = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(`Memory probe child failed (${child.status}): ${child.stderr || child.stdout}`);
  const output = child.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!output) throw new Error(`Memory probe child returned no JSON: ${child.stderr}`);
  return output;
}

function currentCommit(): string {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

function writeReport(path: string, generated: { bytes: number; counts: FixtureCounts }, results: MeasurementResult[]): void {
  const cached = results.find(result => result.scenario === "cached")!;
  const uncached = results.find(result => result.scenario === "uncached")!;
  const maxPeakRssMiB = Math.max(...results.map(result => result.peakRssMiB));
  const report = {
    schema: "r-ops.audit2-memory-measurements.v1",
    purpose: "Synthetic launch memory gate for the f5743cc read cache; no production data or provider calls.",
    measuredAt: "2026-09-23",
    sourceCommit: currentCommit(),
    workload: {
      runner: "single Node process per scenario with --test-concurrency=1 equivalent; reads inside each wave use Promise.all",
      readSet: "mixed",
      concurrentDashboardReadsPerWave: 2,
      concurrentTenantPortalReadsPerWave: 2,
      waves: DEFAULT_WAVES,
      cacheTtlMs: 2000,
      starterMemoryMiB: 512,
      nodeExposeGc: true,
    },
    syntheticFixture: {
      source: "server/rent-ops/fixtures/synthetic.ts templates expanded in this harness",
      externalFixtureBytes: generated.bytes,
      counts: generated.counts,
      dateRange: "2019-01 through 2025-12 inclusive (84 month-end periods)",
    },
    results,
    comparison: {
      cachedMedianWaveMs: cached.waveP50Ms,
      uncachedMedianWaveMs: uncached.waveP50Ms,
      medianLatencyReductionPercent: rounded((1 - cached.waveP50Ms / uncached.waveP50Ms) * 100),
      cachedMaxPeakRssMiB: cached.peakRssMiB,
      uncachedMaxPeakRssMiB: uncached.peakRssMiB,
      maxMeasuredPeakRssMiB: maxPeakRssMiB,
      starterGate: "not-cleared",
      reason: "Peak RSS is measured inside the child benchmark only and excludes the web host, Postgres, and session overhead; the 512 MiB launch gate therefore has no safe headroom claim.",
    },
    limits: [
      "The loader parses the external synthetic JSON fixture in place of a live Postgres wire response and row decoder.",
      "The RentOpsService projections, tenant portal projection, Postgres repository cache, TTL, and version path are real code.",
      "No browser, provider, credentials, live database, or real tenant data were used.",
      "This probe measures a three-wave mixed burst; it does not establish production capacity or host-level RSS safety.",
    ],
  };
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--measure") {
    const fixtureIndex = argv.indexOf("--fixture");
    const scenarioIndex = argv.indexOf("--scenario");
    const fixturePath = fixtureIndex >= 0 ? argv[fixtureIndex + 1] : undefined;
    if (!fixturePath) throw new Error("--measure requires --fixture <path>");
    const scenario = parseScenario(scenarioIndex >= 0 ? argv[scenarioIndex + 1] : undefined);
    const result = await measure(fixturePath, scenario, "mixed", DEFAULT_WAVES);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (argv[0] === "--generate") {
    const fixtureIndex = argv.indexOf("--fixture");
    const fixturePath = fixtureIndex >= 0 ? argv[fixtureIndex + 1] : undefined;
    if (!fixturePath) throw new Error("--generate requires --fixture <path>");
    const serialized = JSON.stringify(buildSyntheticSnapshot());
    writeFileSync(fixturePath, serialized, "utf8");
    process.stdout.write(`${JSON.stringify({ bytes: Buffer.byteLength(serialized), counts })}\n`);
    return;
  }

  const reportIndex = argv.indexOf("--out");
  const reportPath = resolve(REPO_ROOT, reportIndex >= 0 ? argv[reportIndex + 1] : DEFAULT_REPORT_PATH);
  const tempRoot = mkdtempSync(join(tmpdir(), "r-ops-audit2-memory-"));
  const fixturePath = join(tempRoot, "synthetic-fixture.json");
  try {
    const generated = JSON.parse(runChild(childArgs("generate", fixturePath), {})) as { bytes: number; counts: FixtureCounts };
    const results = (["cached", "uncached"] as const).map(scenario => JSON.parse(
      runChild(childArgs("measure", fixturePath, scenario), { MEMORY_GATE_SCENARIO: scenario, MEMORY_GATE_READ_SET: "mixed" }),
    ) as MeasurementResult);
    writeReport(reportPath, generated, results);
    process.stdout.write(`${JSON.stringify({ report: reportPath, sourceCommit: currentCommit(), maxPeakRssMiB: Math.max(...results.map(result => result.peakRssMiB)) })}\n`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
