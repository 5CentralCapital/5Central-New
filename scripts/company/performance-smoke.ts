import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { createCompanyDemoApp } from '../../server/company/demo';
import { SYNTHETIC_COMPANY as company } from '../../server/company/testing/synthetic-database';

const directory = resolve(process.env.ROPS_EVIDENCE_DIR ?? '/tmp/rops-project-performance');
await mkdir(directory, { recursive: true });
const demo = await createCompanyDemoApp();
const listener = demo.app.listen(0, '127.0.0.1');
await new Promise<void>(done => listener.once('listening', done));
const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/company/${company.organizationId}`;
try {
  const projectIds = Array.from({ length: 200 }, () => randomUUID());
  await demo.database.db.query(`INSERT INTO company_projects (id,organization_id,legal_entity_id,property_id,name,status,currency)
    SELECT id::uuid,$1,$2,$3,'Synthetic project ' || ordinal,'active','USD'
    FROM jsonb_array_elements_text($4::jsonb) WITH ORDINALITY AS fixture(id,ordinal)`,
    [company.organizationId, company.entityId, company.propertyId, JSON.stringify(projectIds)]);
  const rows = projectIds.flatMap(projectId => Array.from({ length: 20 }, (_, i) => ({ id: randomUUID(), projectId, description: `Synthetic item ${i + 1}` })));
  await demo.database.db.query(`INSERT INTO company_project_scope_items (id,organization_id,project_id,description,quantity,rate_cents,estimated_cents)
    SELECT id::uuid,$1,"projectId"::uuid,description,2.5,10001,25003 FROM jsonb_to_recordset($2::jsonb) AS f(id text,"projectId" text,description text)`, [company.organizationId, JSON.stringify(rows)]);
  await demo.database.db.query(`INSERT INTO company_project_tasks (id,organization_id,project_id,title,status)
    SELECT id::uuid,$1,"projectId"::uuid,description,'not_started' FROM jsonb_to_recordset($2::jsonb) AS f(id text,"projectId" text,description text)`, [company.organizationId, JSON.stringify(rows)]);
  await demo.database.db.query(`INSERT INTO company_project_draft_costs (id,organization_id,project_id,description,amount_cents,currency,incurred_on)
    SELECT id::uuid,$1,"projectId"::uuid,description,12001,'USD','2026-01-01' FROM jsonb_to_recordset($2::jsonb) AS f(id text,"projectId" text,description text)`, [company.organizationId, JSON.stringify(rows)]);
  const observations: { run: number; operation: string; durationMs: number; responseBytes: number }[] = [];
  for (let run = 1; run <= 3; run++) {
    for (let sample = 0; sample < 100; sample++) {
      for (const [operation, path] of [['project_list', '/projects?limit=50'], ['project_detail', `/projects/${projectIds[sample % projectIds.length]}`]]) {
        const start = performance.now(); const response = await fetch(`${origin}${path}`); const text = await response.text();
        assert.equal(response.status, 200, text);
        observations.push({ run, operation, durationMs: performance.now() - start, responseBytes: Buffer.byteLength(text) });
      }
    }
  }
  const summaries = ['project_list','project_detail'].map(operation => {
    const durations = observations.filter(row => row.operation === operation).map(row => row.durationMs).sort((a,b)=>a-b);
    return { operation, samples: durations.length, p50Ms: durations[Math.ceil(durations.length * .5)-1], p95Ms: durations[Math.ceil(durations.length * .95)-1], maxMs: durations.at(-1), diagnosticBudgetMs: 1000 };
  });
  const report = { mode: 'diagnostic', releaseReady: false, environment: 'localhost / in-memory PGlite / synthetic data',
    dataset: { projects: 200, scopeItems: 4000, tasks: 4000, draftCosts: 4000 }, runs: 3, summaries, observations };
  await writeFile(resolve(directory, 'project-api-performance.json'), JSON.stringify(report, null, 2));
  for (const summary of summaries) assert.ok(summary.p95Ms <= summary.diagnosticBudgetMs, `${summary.operation} exceeds local regression budget`);
  console.log(JSON.stringify({ mode: report.mode, releaseReady: false, summaries, evidence: directory }));
} finally {
  await new Promise<void>((done,reject) => listener.close(error=>error?reject(error):done()));
  await demo.close();
}
