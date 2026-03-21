import { convertToLlm, serializeConversation, type CompactionResult, type SessionBeforeCompactEvent, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { getMorphApiKey, type MorphCompactionConfig, type MorphUsageState } from "./state.ts";

type MorphLineRange = {
	start: number;
	end: number;
};

type MorphCompactResponse = {
	output?: string;
	messages?: Array<{
		compacted_line_ranges?: MorphLineRange[];
	}>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		compression_ratio?: number;
		processing_time_ms?: number;
	};
};

type MorphCompactionDetails = {
	backend: "morph";
	version: 1;
	query: string;
	requestedCompressionRatio: number;
	morphUsage?: MorphUsageState;
	compactedLineRanges?: MorphLineRange[];
	readFiles: string[];
	modifiedFiles: string[];
};

export type MorphAttemptResult =
	| {
			kind: "success";
			compaction: CompactionResult<MorphCompactionDetails>;
			query: string;
			usage?: MorphUsageState;
	  }
	| {
			kind: "fallback";
			reason: string;
			query: string;
			error?: string;
	  }
	| {
			kind: "cancel";
	  };

class MorphApiError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "MorphApiError";
		this.status = status;
	}
}

function textFromContent(content: unknown): string | undefined {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed ? trimmed : undefined;
	}
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((item): item is { type?: string; text?: string } => typeof item === "object" && item !== null)
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text.trim())
		.filter(Boolean)
		.join("\n");
	return text || undefined;
}

function extractLatestQuery(branchEntries: SessionEntry[], customInstructions?: string): string {
	const custom = customInstructions?.trim();
	if (custom) return custom;
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index];
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			content?: unknown;
			command?: string;
			output?: string;
		};
		if (message.role === "user") {
			const text = textFromContent(message.content);
			if (text) return text;
		}
		if (message.role === "bashExecution" && message.command) {
			return message.command.trim();
		}
	}
	return "";
}

function buildMorphInput(serializedConversation: string, previousSummary?: string): string {
	const parts: string[] = [];
	const previous = previousSummary?.trim();
	if (previous) {
		parts.push("<keepContext>");
		parts.push("[Previous compacted context]");
		parts.push(previous);
		parts.push("</keepContext>");
	}
	if (serializedConversation.trim()) {
		parts.push(serializedConversation.trim());
	}
	return parts.join("\n\n");
}

function computeFileLists(fileOps: SessionBeforeCompactEvent["preparation"]["fileOps"]): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

function wrapMorphOutput(output: string): string {
	return [
		"Morph Compact verbatim transcript of earlier context.",
		"Surviving lines are exact excerpts from the original serialized conversation.",
		"Irrelevant lines were removed.",
		"",
		"<morph-compacted-history>",
		output.trim(),
		"</morph-compacted-history>",
	].join("\n");
}

function summarizeError(error: unknown): string {
	if (error instanceof MorphApiError) {
		return error.status ? `${error.message} (HTTP ${error.status})` : error.message;
	}
	if (error instanceof Error) return error.message;
	return "Unknown Morph compaction error";
}

function ensureUsableOutput(data: MorphCompactResponse): string {
	const output = data.output?.trim();
	if (!output) {
		throw new MorphApiError("Morph compact returned an empty output");
	}
	return output;
}

async function parseCompactResponse(response: Response): Promise<MorphCompactResponse> {
	let data: MorphCompactResponse | undefined;
	let bodyText = "";
	try {
		bodyText = await response.text();
		data = bodyText ? (JSON.parse(bodyText) as MorphCompactResponse) : undefined;
	} catch {
		throw new MorphApiError(`Morph compact returned invalid JSON${response.status ? ` with status ${response.status}` : ""}`, response.status);
	}
	if (!response.ok) {
		const preview = bodyText.trim().slice(0, 240);
		throw new MorphApiError(`Morph compact request failed${preview ? `: ${preview}` : ""}`, response.status);
	}
	return data ?? {};
}

async function callMorphCompact(
	input: string,
	query: string,
	config: MorphCompactionConfig,
	signal: AbortSignal,
): Promise<MorphCompactResponse> {
	const response = await fetch("https://api.morphllm.com/v1/compact", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getMorphApiKey() ?? ""}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			input,
			query,
			compression_ratio: config.compressionRatio,
			preserve_recent: 0,
			include_markers: config.includeMarkers,
			include_line_ranges: true,
		}),
		signal,
	});
	return parseCompactResponse(response);
}

function buildCombinedSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

export function buildFallbackReason(config: MorphCompactionConfig, hasApiKey: boolean): string | undefined {
	if (config.mode === "pi") return undefined;
	if (!hasApiKey) return "MORPH_API_KEY is missing, so Pi built-in compaction was used";
	return undefined;
}

export async function attemptMorphCompaction(
	event: SessionBeforeCompactEvent,
	config: MorphCompactionConfig,
): Promise<MorphAttemptResult> {
	if (config.mode === "pi") {
		return {
			kind: "fallback",
			reason: "Compaction mode is set to pi",
			query: extractLatestQuery(event.branchEntries, event.customInstructions),
		};
	}
	if (event.signal.aborted) {
		return { kind: "cancel" };
	}
	if (!getMorphApiKey()) {
		return {
			kind: "fallback",
			reason: "MORPH_API_KEY is missing, so Pi built-in compaction was used",
			query: extractLatestQuery(event.branchEntries, event.customInstructions),
		};
	}
	if (event.preparation.isSplitTurn) {
		return {
			kind: "fallback",
			reason: "Split-turn compactions stay on Pi's built-in compactor",
			query: extractLatestQuery(event.branchEntries, event.customInstructions),
		};
	}
	const query = extractLatestQuery(event.branchEntries, event.customInstructions);
	const llmMessages = convertToLlm(event.preparation.messagesToSummarize);
	const serializedConversation = serializeConversation(llmMessages);
	const input = buildMorphInput(serializedConversation, event.preparation.previousSummary);
	if (!input.trim()) {
		return {
			kind: "fallback",
			reason: "There was no usable conversation history to send to Morph compact",
			query,
		};
	}
	try {
		const response = await callMorphCompact(input, query, config, buildCombinedSignal(event.signal, config.timeoutMs));
		const output = ensureUsableOutput(response);
		const { readFiles, modifiedFiles } = computeFileLists(event.preparation.fileOps);
		const usage: MorphUsageState | undefined = response.usage
			? {
					inputTokens: response.usage.input_tokens,
					outputTokens: response.usage.output_tokens,
					compressionRatio: response.usage.compression_ratio,
					processingTimeMs: response.usage.processing_time_ms,
			  }
			: undefined;
		const compactedLineRanges = response.messages?.[0]?.compacted_line_ranges ?? [];
		const summary = `${wrapMorphOutput(output)}${formatFileOperations(readFiles, modifiedFiles)}`;
		return {
			kind: "success",
			query,
			usage,
			compaction: {
				summary,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {
					backend: "morph",
					version: 1,
					query,
					requestedCompressionRatio: config.compressionRatio,
					morphUsage: usage,
					compactedLineRanges,
					readFiles,
					modifiedFiles,
				},
			},
		};
	} catch (error) {
		if (event.signal.aborted || error instanceof DOMException && error.name === "AbortError") {
			return { kind: "cancel" };
		}
		return {
			kind: "fallback",
			reason: "Morph compaction failed, so Pi built-in compaction was used",
			query,
			error: summarizeError(error),
		};
	}
}
