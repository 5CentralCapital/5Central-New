import { runPerformanceCli } from "./cli.ts";

const exitCode = await runPerformanceCli("check");
if (exitCode !== 0) process.exitCode = exitCode;
