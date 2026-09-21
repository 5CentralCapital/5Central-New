import { runPerformanceCli } from "./cli.ts";

const exitCode = await runPerformanceCli("report");
if (exitCode !== 0) process.exitCode = exitCode;
