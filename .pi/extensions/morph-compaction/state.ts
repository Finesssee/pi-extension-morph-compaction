import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CompactionMode = "morph" | "pi";

export type MorphCompactionConfig = {
	mode: CompactionMode;
	compressionRatio: number;
	timeoutMs: number;
	includeMarkers: boolean;
};

export type MorphUsageState = {
	inputTokens?: number;
	outputTokens?: number;
	compressionRatio?: number;
	processingTimeMs?: number;
};

export type MorphCompactionState = {
	effectiveMode: CompactionMode;
	lastBackend?: "morph" | "pi";
	lastAttemptAt?: number;
	lastSuccessAt?: number;
	lastE2eDurationMs?: number;
	lastFallbackReason?: string;
	lastQuery?: string;
	lastMorphUsage?: MorphUsageState;
	lastError?: string;
};

export const DEFAULT_CONFIG: MorphCompactionConfig = {
	mode: "morph",
	compressionRatio: 0.4,
	timeoutMs: 10_000,
	includeMarkers: true,
};

let cachedEnvValues: Record<string, string> | undefined;
let cachedEnvPath: string | undefined;

function resolveHome(): string {
	const candidates = [process.env.REAL_HOME, process.env.HOME, homedir()]
		.map((value) => value?.trim())
		.filter((value): value is string => !!value);
	return candidates[0] ?? "/home/fsos";
}

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function readJsonFile<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function writeJsonFile(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function getAgentStateDir(): string {
	return join(resolveHome(), ".pi", "agent");
}

export function getWorkspaceEnvPath(): string {
	return join(resolveHome(), ".env");
}

export function getConfigPath(): string {
	return join(getAgentStateDir(), "morph-compaction.json");
}

export function getStatePath(): string {
	return join(getAgentStateDir(), "morph-compaction-state.json");
}

function normalizeMode(value: unknown): CompactionMode | undefined {
	return value === "morph" || value === "pi" ? value : undefined;
}

function clampCompressionRatio(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONFIG.compressionRatio;
	return Math.min(1, Math.max(0.05, value));
}

function normalizeTimeoutMs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONFIG.timeoutMs;
	return Math.min(120_000, Math.max(1_000, Math.round(value)));
}

export function readConfig(): MorphCompactionConfig {
	const raw = readJsonFile<Partial<MorphCompactionConfig>>(getConfigPath());
	return {
		mode: normalizeMode(raw?.mode) ?? DEFAULT_CONFIG.mode,
		compressionRatio: clampCompressionRatio(raw?.compressionRatio),
		timeoutMs: normalizeTimeoutMs(raw?.timeoutMs),
		includeMarkers: typeof raw?.includeMarkers === "boolean" ? raw.includeMarkers : DEFAULT_CONFIG.includeMarkers,
	};
}

export function writeConfig(next: MorphCompactionConfig): void {
	ensureDir(getAgentStateDir());
	writeJsonFile(getConfigPath(), next);
}

export function ensureConfig(): MorphCompactionConfig {
	const config = readConfig();
	if (!existsSync(getConfigPath())) {
		writeConfig(config);
	}
	return config;
}

export function readState(): MorphCompactionState {
	return readJsonFile<MorphCompactionState>(getStatePath()) ?? { effectiveMode: DEFAULT_CONFIG.mode };
}

export function writeState(next: MorphCompactionState): void {
	ensureDir(getAgentStateDir());
	writeJsonFile(getStatePath(), next);
}

export function resolveConfiguredMode(flagValue: boolean | string | undefined): CompactionMode {
	const fromFlag = normalizeMode(flagValue);
	if (fromFlag) return fromFlag;
	const fromEnv = normalizeMode(process.env.PI_COMPACTION_PROVIDER);
	if (fromEnv) return fromEnv;
	const fromDotEnv = normalizeMode(readEnvValue("PI_COMPACTION_PROVIDER"));
	if (fromDotEnv) return fromDotEnv;
	return ensureConfig().mode;
}

function parseDotEnv(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const equalsIndex = line.indexOf("=");
		if (equalsIndex <= 0) continue;
		const key = line.slice(0, equalsIndex).trim();
		let value = line.slice(equalsIndex + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
}

function readDotEnv(): Record<string, string> {
	const path = getWorkspaceEnvPath();
	if (cachedEnvValues && cachedEnvPath === path) return cachedEnvValues;
	try {
		cachedEnvValues = parseDotEnv(readFileSync(path, "utf-8"));
		cachedEnvPath = path;
		return cachedEnvValues;
	} catch {
		cachedEnvValues = {};
		cachedEnvPath = path;
		return cachedEnvValues;
	}
}

export function readEnvValue(name: string): string | undefined {
	const processValue = process.env[name]?.trim();
	if (processValue) return processValue;
	const envValue = readDotEnv()[name]?.trim();
	return envValue || undefined;
}

export function getMorphApiKey(): string | undefined {
	return readEnvValue("MORPH_API_KEY");
}

export function getMorphApiKeyPresence(): boolean {
	return !!getMorphApiKey();
}
