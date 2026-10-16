import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          exclude: ["**/node_modules/**", "benchmarks/**", "web/**"],
        },
      },
    ],
  },
});
