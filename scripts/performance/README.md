# Performance acceptance evidence

`report.ts` and `check.ts` consume a JSON evidence file that follows
`r-ops.performance-evidence.v1` and write the same machine-readable evaluation
shape, `r-ops.performance-evaluation.v1`.

```text
npx tsx scripts/performance/report.ts --input <evidence.json> --out <evaluation.json>
npx tsx scripts/performance/report.ts --input <evidence.json> --out <evaluation.json> --coverage <trusted-coverage-inventory.json>
npx tsx scripts/performance/check.ts --input <evidence.json> --out <evaluation.json> --coverage <trusted-coverage-inventory.json>
```

Both commands fail closed for malformed evidence, missing route/workload
coverage, insufficient samples or independent runs, threshold failures,
unexpected errors, timeouts, correctness failures, and regression failures.
Runtime harness evidence must retain cold/warm, device, network, data-scale,
appearance, and provider-state dimensions as separate fields. Unit-test values
are not accepted as measured app-performance evidence.

Report mode is diagnostic and always marks `releaseReady: false`; it may be
partial when no inventory is supplied. Check mode is release mode and requires
the separately supplied `r-ops.performance-coverage.v1` inventory. It compares
evidence coverage exactly to that inventory and enforces every contract
workload group.

This packet supplies the evaluator and CLI only. The application harnesses,
package scripts, release command integration, and PERF13 workload-tier budgets
remain TODOs owned by the corresponding implementation packets.
