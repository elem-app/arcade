import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["__tests__/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
        },
      },
    ],
  },
});
