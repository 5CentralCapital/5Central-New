console.error("Direct schema push/application is disabled. Use npm run company:migrations:verify, render reviewed SQL with npm run rent-ops:migration:render:all, and apply through the existing target-bound migration workflow. This command makes no database connection.");
process.exitCode = 1;
