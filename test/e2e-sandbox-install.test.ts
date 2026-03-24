/**
 * E2E test: npm pack + install sandbox verification.
 *
 * Uses pi-test-harness verifySandboxInstall() when available so the published
 * package shape stays compatible with Pi package installs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

async function tryImport<T>(specifier: string): Promise<T | undefined> {
	try {
		return (await import(specifier)) as T;
	} catch {
		return undefined;
	}
}

const harness = await tryImport<any>("@marcfargas/pi-test-harness");
const available = !!harness;
const PACKAGE_DIR = path.resolve(".");

describe(
	"sandbox install",
	{ skip: !available ? "pi-test-harness not available" : undefined },
	() => {
		const { verifySandboxInstall } = harness;

		it("loads morph-compaction after npm pack+install", { timeout: 120_000 }, async () => {
			const result = await verifySandboxInstall({
				packageDir: PACKAGE_DIR,
				expect: {
					extensions: 1,
				},
			});

			assert.deepEqual(result.loaded.extensionErrors, []);
			assert.equal(result.loaded.extensions, 1);
		});
	},
);
