import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./test-e2e",
	timeout: 60_000,
	fullyParallel: true,
	globalSetup: "./test-e2e/global-setup.ts",
	use: {
		screenshot: "only-on-failure",
	},
});
