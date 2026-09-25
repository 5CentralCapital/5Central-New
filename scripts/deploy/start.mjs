/**
 * Production entry point shared by every host.
 *
 * One build (`npm run build`) produces both bundles. RENT_OPS_PROCESS_ROLE
 * picks which long-running process this deployment runs:
 *
 *   web     (default) dist/index.js  — HTTP server, needs a port
 *   worker            dist/worker.js — durable jobs (QuickBooks sync, CDC,
 *                                      webhook fetches, outbox, review detection)
 *
 * This lets a second deployment of the same repository (for example a Replit
 * Reserved VM "background worker", or Render's worker service) run the worker
 * with the same build and run command, selected only by an environment value.
 * An unknown role fails fast instead of silently starting the web server.
 */
import { pathToFileURL } from "node:url";

export const PROCESS_ENTRY_POINTS = Object.freeze({ web: "../../dist/index.js", worker: "../../dist/worker.js" });

export function entryPointFor(env) {
  const role = (env.RENT_OPS_PROCESS_ROLE ?? "").trim() || "web";
  if (!Object.hasOwn(PROCESS_ENTRY_POINTS, role)) {
    throw new Error(`RENT_OPS_PROCESS_ROLE must be "web" or "worker" (got an unrecognized value)`);
  }
  return { role, specifier: PROCESS_ENTRY_POINTS[role] };
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  let selected;
  try {
    selected = entryPointFor(process.env);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: error.message }));
    process.exit(2);
  }
  console.log(JSON.stringify({ level: "info", message: "starting 5Central Ops process", role: selected.role }));
  await import(selected.specifier);
}
