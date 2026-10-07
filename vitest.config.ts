import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/src/**/*.test.tsx"],
    pool: "threads",
    maxWorkers: 2,
    minWorkers: 1,
  },
});
