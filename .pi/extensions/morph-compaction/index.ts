import { Text } from "@mariozechner/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactEvent,
} from "@mariozechner/pi-coding-agent";
import { attemptMorphCompaction, buildFallbackReason } from "./morph-client.ts";
import {
	type CompactionMode,
	type MorphCompactionState,
	ensureConfig,
	getConfigPath,
	getMorphApiKeyPresence,
	readConfig,
	readState,
	resolveConfiguredMode,
	writeConfig,
	writeState,
} from "./state.ts";

const CUSTOM_TYPE = "morph-compaction";
const STATUS_KEY = "morph-compaction";
const FLAG_NAME = "compaction-provider";
let activeCompactionStartAt: number | undefined;
let activeCompactionBackend: "morph" | "pi" | undefined;

function emitText(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, text: string): void {
	if (!ctx.hasUI) {
		console.log(text);
		return;
	}
	pi.sendMessage({
		customType: CUSTOM_TYPE,
		content: text,
		display: true,
		details: { kind: "status" },
	});
}

function effectiveMode(pi: ExtensionAPI): CompactionMode {
	return resolveConfiguredMode(pi.getFlag(FLAG_NAME));
}

function updateStatus(ctx: ExtensionContext): void {
	const mode = effectiveModeFromState();
	ctx.ui.setStatus(STATUS_KEY, buildFooterStatus(mode, readState()));
}

function effectiveModeFromState(): CompactionMode {
	const state = readState();
	return state.effectiveMode === "pi" ? "pi" : "morph";
}

function buildFooterStatus(mode: CompactionMode, state: MorphCompactionState): string {
	if (mode === "pi") return "compact:pi";
	if (state.lastBackend === "pi" && state.lastFallbackReason) return "compact:morph->pi";
	return "compact:morph";
}

function persistState(next: MorphCompactionState): MorphCompactionState {
	writeState(next);
	return next;
}

function buildStatusText(): string {
	const config = ensureConfig();
	const state = readState();
	const mode = effectiveModeFromState();
	const lines = [
		`Mode: ${config.mode}`,
		`Effective mode: ${mode}`,
		`Config file: ${getConfigPath()}`,
		`Morph API key: ${getMorphApiKeyPresence() ? "present" : "missing"}`,
		`Compression ratio: ${config.compressionRatio}`,
		`Timeout: ${config.timeoutMs} ms`,
		`Include markers: ${config.includeMarkers ? "yes" : "no"}`,
	];
	if (state.lastBackend) {
		lines.push(`Last backend: ${state.lastBackend}`);
	}
	if (state.lastAttemptAt) {
		lines.push(`Last attempt: ${new Date(state.lastAttemptAt).toISOString()}`);
	}
	if (state.lastSuccessAt) {
		lines.push(`Last success: ${new Date(state.lastSuccessAt).toISOString()}`);
	}
	if (state.lastE2eDurationMs !== undefined) {
		lines.push(`Last end-to-end latency: ${state.lastE2eDurationMs} ms`);
	}
	if (state.lastQuery) {
		lines.push(`Last query: ${state.lastQuery}`);
	}
	if (state.lastFallbackReason) {
		lines.push(`Last fallback: ${state.lastFallbackReason}`);
	}
	if (state.lastError) {
		lines.push(`Last error: ${state.lastError}`);
	}
	if (state.lastMorphUsage) {
		const usage = state.lastMorphUsage;
		const parts = [
			usage.inputTokens !== undefined ? `input ${usage.inputTokens}` : undefined,
			usage.outputTokens !== undefined ? `output ${usage.outputTokens}` : undefined,
			usage.compressionRatio !== undefined ? `ratio ${usage.compressionRatio}` : undefined,
			usage.processingTimeMs !== undefined ? `${usage.processingTimeMs} ms` : undefined,
		].filter(Boolean);
		if (parts.length > 0) {
			lines.push(`Last Morph usage: ${parts.join(" · ")}`);
		}
		if (state.lastE2eDurationMs !== undefined && usage.processingTimeMs !== undefined) {
			const overheadMs = Math.max(0, state.lastE2eDurationMs - usage.processingTimeMs);
			lines.push(`Last non-engine overhead: ${overheadMs} ms`);
		}
	}
	const advisory = buildFallbackReason(config, getMorphApiKeyPresence());
	if (advisory) {
		lines.push(`Advisory: ${advisory}`);
	}
	return lines.join("\n");
}

function parseModeArg(args: string | undefined): CompactionMode | "status" | undefined {
	const value = args?.trim().toLowerCase();
	if (!value || value === "status") return "status";
	if (value === "morph" || value === "pi") return value;
	return undefined;
}

function setMode(mode: CompactionMode, pi: ExtensionAPI): string {
	const current = readConfig();
	const next = { ...current, mode };
	writeConfig(next);
	const state = readState();
	persistState({
		...state,
		effectiveMode: resolveConfiguredMode(pi.getFlag(FLAG_NAME)),
	});
	return `Morph compaction mode set to ${mode}.`;
}

function buildUsageText(): string {
	return [
		"Usage:",
		"/compactor",
		"/compactor status",
		"/compactor morph",
		"/compactor pi",
	].join("\n");
}

async function handleBeforeCompact(pi: ExtensionAPI, event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<SessionBeforeCompactResult | void> {
	const config = readConfig();
	const currentMode = effectiveMode(pi);
	const attemptAt = Date.now();
	activeCompactionStartAt = attemptAt;
	activeCompactionBackend = undefined;
	const attempt = await attemptMorphCompaction(event, { ...config, mode: currentMode });
	if (attempt.kind === "cancel") {
		activeCompactionStartAt = undefined;
		activeCompactionBackend = undefined;
		persistState({
			...readState(),
			effectiveMode: currentMode,
			lastAttemptAt: attemptAt,
		});
		updateStatus(ctx);
		return { cancel: true };
	}
	if (attempt.kind === "fallback") {
		activeCompactionBackend = "pi";
		persistState({
			...readState(),
			effectiveMode: currentMode,
			lastBackend: "pi",
			lastAttemptAt: attemptAt,
			lastFallbackReason: attempt.reason,
			lastQuery: attempt.query,
			lastError: attempt.error,
		});
		updateStatus(ctx);
		return undefined;
	}
	activeCompactionBackend = "morph";
	persistState({
		...readState(),
		effectiveMode: currentMode,
		lastBackend: "morph",
		lastAttemptAt: attemptAt,
		lastSuccessAt: Date.now(),
		lastFallbackReason: undefined,
		lastQuery: attempt.query,
		lastMorphUsage: attempt.usage,
		lastError: undefined,
	});
	updateStatus(ctx);
	return { compaction: attempt.compaction };
}

function syncEffectiveMode(pi: ExtensionAPI): void {
	const state = readState();
	const nextMode = effectiveMode(pi);
	if (state.effectiveMode === nextMode) return;
	persistState({
		...state,
		effectiveMode: nextMode,
	});
}

export default function morphCompaction(pi: ExtensionAPI) {
	ensureConfig();
	syncEffectiveMode(pi);

	pi.registerFlag(FLAG_NAME, {
		description: "Choose the session compaction provider: morph or pi",
		type: "string",
	});

	pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
		const title = theme.fg("accent", theme.bold("Compactor"));
		const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
		return new Text(`${title}\n\n${body}`, 0, 0);
	});

	pi.registerCommand("compactor", {
		description: "Show or change the active compaction provider. Use `/compactor morph` or `/compactor pi`.",
		handler: async (args, ctx) => {
			const parsed = parseModeArg(args);
			if (!parsed) {
				emitText(pi, ctx, buildUsageText());
				return;
			}
			if (parsed === "status") {
				emitText(pi, ctx, buildStatusText());
				updateStatus(ctx);
				return;
			}
			const text = `${setMode(parsed, pi)}\n\n${buildStatusText()}`;
			emitText(pi, ctx, text);
			updateStatus(ctx);
		},
	});

	pi.on("session_before_compact", async (event, ctx) => handleBeforeCompact(pi, event, ctx));

	pi.on("session_start", async (_event, ctx) => {
		syncEffectiveMode(pi);
		updateStatus(ctx);
	});

	pi.on("session_compact", async (event: SessionCompactEvent, ctx) => {
		const state = readState();
		const completedAt = Date.now();
		const e2eDurationMs = activeCompactionStartAt !== undefined ? completedAt - activeCompactionStartAt : undefined;
		const backend = event.fromExtension ? "morph" : activeCompactionBackend ?? "pi";
		activeCompactionStartAt = undefined;
		activeCompactionBackend = undefined;
		if (event.fromExtension) {
			persistState({
				...state,
				lastBackend: backend,
				lastE2eDurationMs: e2eDurationMs,
			});
		} else {
			persistState({
				...state,
				lastBackend: backend,
				lastE2eDurationMs: e2eDurationMs,
			});
		}
		updateStatus(ctx);
	});
}
