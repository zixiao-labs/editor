import { defineConfig } from "@lightning-js/lightning/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    maxWorkers: 2,
  },
});
