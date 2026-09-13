import { basename } from 'node:path';

/**
 * Wall-clock ceiling handed to `agy --print-timeout`.
 * The CLI's own default is 5m, which is short for a real delegated task.
 */
const DEFAULT_TIMEOUT_SECONDS = 900;

interface AgyUsage {
	input_tokens: number;
	output_tokens: number;
	thinking_tokens: number;
	cache_read_tokens: number;
	total_tokens: number;
}

interface AgyResult {
	conversation_id: string;
	status: string;
	response: string;
	duration_seconds: number;
	num_turns: number;
	usage: AgyUsage;
}

interface AgyToolInfo {
	name: string;
	output?: string;

	parameters?: Record<string, unknown>;
}

interface AgyStepUpdate {
	step_index: number;
	state: string;
	step_type: string;
	tool_name?: string;
	tool_info?: AgyToolInfo;
}

interface AgyStep {
	index: number;
	tool: string;
	detail?: string;
	elapsedSeconds: number;
}

interface AgyEvent {
	event: string;
	result?: AgyResult;
	step_update?: AgyStepUpdate;
}

interface AgyRunOptions {
	prompt: string;
	cwd: string;
	model?: string;
	conversation?: string;
	plan?: boolean;
	signal?: AbortSignal;
	onStep?: (step: AgyStep) => void;
}

interface AgyRun {
	result?: AgyResult;
	exitCode: number;
	stderr: string;
	aborted: boolean;
	timedOut: boolean;
}

interface ParsedCommand {
	model?: string;
	conversation?: string;
	fresh: boolean;
	plan: boolean;
	stop: boolean;
	prompt: string;
}

interface BinaryResolutionOptions {
	env?: Record<string, string | undefined>;
	platform?: string;
	which?: (candidate: string) => string | null;
}

interface EventStreamState {
	startedAt: number;
	options: AgyRunOptions;
	steps: number;
	result?: AgyResult;
}

type AgySubprocess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

/** `PI_AGY_TIMEOUT` overrides the print-mode ceiling, in seconds, for workloads that legitimately run long. */
function resolveTimeoutSeconds(env?: Record<string, string | undefined>) {
	const currentEnv = env ?? process.env;
	const raw = currentEnv.PI_AGY_TIMEOUT;
	if (!raw) {
		return DEFAULT_TIMEOUT_SECONDS;
	}

	const parsed = Number.parseInt(raw, 10);
	if (Number.isFinite(parsed) && parsed > 0) {
		return parsed;
	}

	return DEFAULT_TIMEOUT_SECONDS;
}

let cachedBinary: string | undefined;

function getBinaryCandidates(platform: string) {
	if (platform === 'win32') {
		return ['agy.cmd', 'agy.exe', 'agy.bat', 'agy.ps1', 'agy'];
	}

	return ['agy'];
}

function probeCandidates(candidates: string[], whichFn: (name: string) => string | null) {
	for (const candidate of candidates) {
		const resolved = whichFn(candidate);
		if (resolved) {
			return resolved;
		}
	}

	return undefined;
}

function findBinary(env: Record<string, string | undefined>, platform: string, whichFn: (name: string) => string | null) {
	const override = env.PI_AGY_BIN;
	if (override) {
		return override;
	}

	const candidates = getBinaryCandidates(platform);
	const probed = probeCandidates(candidates, whichFn);
	if (probed) {
		return probed;
	}

	return 'agy';
}

/**
 * Resolves the `agy` executable.
 * npm-style installs ship a POSIX shell shim named plain `agy` alongside Windows launchers.
 * Windows cannot execute the former and pops an "open with" dialog for it, so launcher extensions must be probed first there.
 */
function resolveAgyBinary(options?: BinaryResolutionOptions) {
	if (options) {
		const env = options.env ?? process.env;
		const platform = options.platform ?? process.platform;
		const whichFn = options.which ?? Bun.which;

		return findBinary(env, platform, whichFn);
	}

	if (!cachedBinary) {
		cachedBinary = findBinary(process.env, process.platform, Bun.which);
	}

	return cachedBinary;
}

/**
 * The single parameter worth showing per agy tool, in priority order.
 * Captured from a real `--output-format stream-json` run.
 */
const STEP_DETAIL_KEYS = ['CommandLine', 'AbsolutePath', 'TargetFile', 'DirectoryPath'];

function truncate(text: string, limit: number) {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (flat.length <= limit) {
		return flat;
	}

	return `${flat.slice(0, limit - 1)}…`;
}

/** Reduces a step's parameters to one short human-readable detail, so progress says what agy is touching. */
function summarizeStep(info?: AgyToolInfo) {
	const params = info?.parameters;
	if (!params) {
		return undefined;
	}

	for (const key of STEP_DETAIL_KEYS) {
		const value = params[key];
		if (typeof value !== 'string' || value.length === 0) {
			continue;
		}

		if (key === 'CommandLine') {
			return truncate(value, 64);
		}

		return truncate(basename(value), 48);
	}

	return undefined;
}

function formatStep(step: AgyStep) {
	const parts = [`agy: step ${step.index}`, `${step.elapsedSeconds}s`, step.tool];

	if (step.detail) {
		parts.push(step.detail);
	}

	return parts.join(' · ');
}

/** One-line provenance banner so a delegated result is traceable back to its agy conversation. */
function formatHeader(result: AgyResult) {
	return [
		`status: ${result.status}`,
		`conversation: ${result.conversation_id}`,
		`turns: ${result.num_turns}`,
		`duration: ${result.duration_seconds.toFixed(1)}s`,
		`tokens: ${result.usage.total_tokens}`
	].join(' · ');
}

/** Provenance banner, an explicit truncation warning when agy timed out, then the response body. */
function formatReport(run: AgyRun, result: AgyResult) {
	const lines = [formatHeader(result)];

	if (run.timedOut) {
		lines.push(`WARNING: agy hit the ${resolveTimeoutSeconds()}s print timeout and returned partial output. Resume it with conversation ${result.conversation_id}.`);
	}

	lines.push('', result.response);

	return lines.join('\n');
}

/** Strips leading `--stop` / `--plan` / `--new` / `--model <id>` / `--resume <id>` flags, leaving the rest of the line as the prompt verbatim. */
function parseCommandArgs(args: string): ParsedCommand {
	let rest = args.trim();
	let plan = false;
	let stop = false;
	let fresh = false;
	let model: string | undefined;
	let conversation: string | undefined;

	while (rest.length > 0) {
		const planMatch = rest.match(/^--plan(?:\s+|$)/);
		if (planMatch) {
			plan = true;
			rest = rest.slice(planMatch[0].length);
			continue;
		}

		const stopMatch = rest.match(/^--stop(?:\s+|$)/);
		if (stopMatch) {
			stop = true;
			rest = rest.slice(stopMatch[0].length);
			continue;
		}

		const newMatch = rest.match(/^--new(?:\s+|$)/);
		if (newMatch) {
			fresh = true;
			rest = rest.slice(newMatch[0].length);
			continue;
		}

		const modelMatch = rest.match(/^--model\s+(\S+)(?:\s+|$)/);
		if (modelMatch) {
			model = modelMatch[1];
			rest = rest.slice(modelMatch[0].length);
			continue;
		}

		const resumeMatch = rest.match(/^--resume\s+(\S+)(?:\s+|$)/);
		if (resumeMatch) {
			conversation = resumeMatch[1];
			rest = rest.slice(resumeMatch[0].length);
			continue;
		}

		break;
	}

	return { model, conversation, fresh, plan, stop, prompt: rest };
}

function buildAgyArgs(options: AgyRunOptions) {
	const args = [
		'--dangerously-skip-permissions',
		// agy otherwise falls back to ~/.gemini/antigravity-cli/scratch and silently writes outside the workspace.
		'--add-dir', options.cwd,
		'--output-format', 'stream-json',
		'--print-timeout', `${resolveTimeoutSeconds()}s`
	];

	if (options.model) {
		args.push('--model', options.model);
	}

	if (options.plan) {
		args.push('--mode', 'plan');
	}

	if (options.conversation) {
		args.push('--conversation', options.conversation);
	}

	// `-p` swallows the next argv element as its prompt, so the value must be attached to the flag.
	args.push(`-p=${options.prompt}`);

	return args;
}

function parseEvent(line: string): AgyEvent | undefined {
	if (!line.trim()) {
		return undefined;
	}

	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

function handleStepUpdate(step: AgyStepUpdate | undefined, state: EventStreamState) {
	if (!step || step.state !== 'ACTIVE') {
		return;
	}

	state.steps += 1;
	state.options.onStep?.({
		index: state.steps,
		tool: step.tool_name ?? step.step_type,
		detail: summarizeStep(step.tool_info),
		elapsedSeconds: Math.round((Date.now() - state.startedAt) / 1000)
	});
}

function handleEvent(line: string, state: EventStreamState) {
	const event = parseEvent(line);
	if (!event) {
		return;
	}

	if (event.event === 'result' && event.result) {
		state.result = event.result;

		return;
	}

	handleStepUpdate(event.step_update, state);
}

async function consumeStdout(stdout: ReadableStream<Uint8Array>, state: EventStreamState) {
	const decoder = new TextDecoder();
	let buffer = '';

	for await (const chunk of stdout) {
		buffer += decoder.decode(chunk, { stream: true });

		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			handleEvent(line, state);
		}
	}
}

/** Spawns `agy` in print mode and folds its NDJSON event stream into a single result. */
async function runAgy(options: AgyRunOptions): Promise<AgyRun> {
	const args = buildAgyArgs(options);

	let proc: AgySubprocess;
	try {
		proc = Bun.spawn([resolveAgyBinary(), ...args], {
			cwd: options.cwd,
			stdout: 'pipe',
			stderr: 'pipe'
		});
	} catch (error) {
		return {
			exitCode: -1,
			stderr: `could not launch agy: ${error}. Set PI_AGY_BIN to its full path if it is not on PATH.`,
			aborted: false,
			timedOut: false
		};
	}

	const abort = () => proc.kill();

	options.signal?.addEventListener('abort', abort, { once: true });

	// Drained concurrently with stdout: agy blocks if it fills the stderr pipe while we are still reading events.
	const stderrText = new Response(proc.stderr).text();
	const streamState: EventStreamState = {
		startedAt: Date.now(),
		options,
		steps: 0
	};

	try {
		await consumeStdout(proc.stdout, streamState);
	} finally {
		options.signal?.removeEventListener('abort', abort);
	}

	const exitCode = await proc.exited;
	const stderr = (await stderrText).trim();

	return {
		result: streamState.result,
		exitCode,
		stderr,
		aborted: options.signal?.aborted === true,
		// agy reports a print timeout as SUCCESS with a truncated or empty response, and says so only on stderr.
		timedOut: /print timeout after/i.test(stderr)
	};
}

export type {
	AgyEvent,
	AgyResult,
	AgyRun,
	AgyRunOptions,
	AgyStep,
	AgyStepUpdate,
	AgyToolInfo,
	AgyUsage,
	BinaryResolutionOptions,
	ParsedCommand
};

export {
	DEFAULT_TIMEOUT_SECONDS,
	formatHeader,
	formatReport,
	formatStep,
	parseCommandArgs,
	resolveAgyBinary,
	resolveTimeoutSeconds,
	runAgy,
	summarizeStep,
	truncate
};
