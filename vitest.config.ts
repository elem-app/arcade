import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          exclude: ["**/node_modules/**", "benchmarks/**", "__tests__/leak/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "leak",
          include: ["__tests__/leak/**/*.test.ts"],
          pool: "forks",
          execArgv: ["--expose-gc"],
        },
      },
    ],
  },
});
