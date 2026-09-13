import type { ExtensionAPI, ExtensionCommandContext } from '@oh-my-pi/pi-coding-agent';
import type { AgyRun, AgyStep } from './internals.ts';
import { formatReport, formatStep, parseCommandArgs, runAgy, truncate } from './internals.ts';

/**
 * Runs started by the slash command, so `/agy --stop` can reach them.
 * The tool path is not tracked here: the agent loop already hands it the turn's own abort signal.
 */
const activeRuns = new Set<AbortController>();

function stopActiveRuns() {
	const stopped = activeRuns.size;

	for (const controller of activeRuns) {
		controller.abort();
	}

	activeRuns.clear();

	return stopped;
}

interface CommandRunParams {
	prompt: string;
	cwd: string;
	model?: string;
	conversation?: string;
	plan: boolean;
	controller: AbortController;
	ctx: ExtensionCommandContext;
	paint: () => void;
	trace: string[];
}

interface AgyToolParams {
	prompt: string;
	model?: string;
	conversation?: string;
	plan?: boolean;
}

async function executeCommandRun(params: CommandRunParams) {
	return runAgy({
		prompt: params.prompt,
		cwd: params.cwd,
		conversation: params.conversation,
		model: params.model,
		plan: params.plan,
		signal: params.controller.signal,
		onStep: (step: AgyStep) => {
			const line = formatStep(step);
			params.trace.push(line);

			if (params.trace.length > 9) {
				params.trace.shift();
			}

			params.paint();
			params.ctx.ui.notify(line, 'info');
		}
	});
}

function resolveCommandLabel(resumed?: string) {
	if (resumed) {
		return 'agy (resumed)';
	}

	return 'agy';
}

export default function antigravity(pi: ExtensionAPI) {
	const z = pi.zod;

	pi.setLabel('Antigravity');

	pi.registerTool({
		name: 'agy',
		label: 'Antigravity',
		description: [
			'Delegate a self-contained task to the Antigravity CLI (`agy`), which runs its own agent loop with its own tools and file access.',
			'This is a full agent, not a chat completion: it reads, edits, and runs commands in the current workspace on its own, with permission prompts disabled.',
			'Use it to offload work onto the Antigravity subscription instead of spending tokens on the primary model, or for a second opinion from a different model family.',
			'The task must be self-contained — it does not see this conversation. Spell out the files, the goal, and the acceptance criteria.',
			'Pass `conversation` with a previously returned id to continue that same agy session instead of starting fresh.',
			'Set `plan: true` for read-only analysis with no edits.'
		].join(' '),
		parameters: z.object({
			prompt: z.string()
				.describe('Self-contained task description, including files, goal, and acceptance criteria.'),
			model: z.string()
				.optional()
				.describe('Model id from `agy models`, e.g. gemini-3.1-pro-high, gemini-3.8-flash-high, claude-opus-4-6-thinking, gpt-oss-120b-medium.'),
			conversation: z.string()
				.optional()
				.describe('Conversation id from a prior agy call, to continue that session.'),
			plan: z.boolean()
				.optional()
				.describe('Run in plan mode: analysis only, no edits.')
		}),
		async execute(_id, rawParams, signal, onUpdate) {
			if (signal?.aborted) {
				return { content: [{ type: 'text' as const, text: 'Cancelled' }] };
			}

			const params = rawParams as AgyToolParams;

			const run = await runAgy({
				prompt: params.prompt,
				cwd: process.cwd(),
				model: params.model,
				conversation: params.conversation,
				plan: params.plan,
				signal,
				onStep: (step: AgyStep) => {
					onUpdate?.({ content: [{ type: 'text' as const, text: formatStep(step) }] });
				}
			});

			if (run.aborted) {
				return { content: [{ type: 'text' as const, text: 'Cancelled' }] };
			}

			if (!run.result) {
				let detail = run.stderr;
				if (!detail) {
					detail = `agy exited with code ${run.exitCode} and produced no result event`;
				}

				return {
					content: [{ type: 'text' as const, text: detail }],
					isError: true
				};
			}

			return {
				content: [{ type: 'text' as const, text: formatReport(run, run.result) }],
				details: {
					conversationId: run.result.conversation_id,
					status: run.result.status,
					numTurns: run.result.num_turns,
					durationSeconds: run.result.duration_seconds,
					usage: run.result.usage
				},
				isError: run.result.status !== 'SUCCESS' || run.timedOut
			};
		}
	});

	// A slash command reads as conversational, so follow-ups continue the previous thread unless `--new` is passed.
	let lastConversation: string | undefined;

	pi.registerCommand(
		'agy',
		{
			description: 'Delegate a task to the Antigravity CLI: /agy [--plan] [--new] [--model <id>] [--resume <id>] <task>, or /agy --stop',
			handler: async (args, ctx) => {
				const { model, conversation, fresh, plan, stop, prompt } = parseCommandArgs(args);

				if (stop) {
					const stopped = stopActiveRuns();
					ctx.ui.notify(`agy: stopped ${stopped} run(s)`, 'info');

					return;
				}

				if (!prompt) {
					ctx.ui.notify('Usage: /agy [--plan] [--new] [--model <id>] [--resume <id>] <task>, or /agy --stop', 'info');

					return;
				}

				let resumed: string | undefined;
				if (!fresh) {
					resumed = conversation ?? lastConversation;
				}

				const label = resolveCommandLabel(resumed);
				const trace: string[] = [];
				const paint = () => {
					ctx.ui.setWidget('agy', [`${label} · ${truncate(prompt, 72)}`, ...trace], { placement: 'aboveEditor' });
				};

				paint();

				const controller = new AbortController();
				activeRuns.add(controller);

				let run: AgyRun;
				try {
					run = await executeCommandRun({
						prompt,
						cwd: ctx.cwd,
						model,
						conversation: resumed,
						plan,
						controller,
						ctx,
						paint,
						trace
					});
				} finally {
					activeRuns.delete(controller);
					ctx.ui.setWidget('agy', undefined);
				}

				if (run.aborted) {
					ctx.ui.notify('agy: stopped', 'info');

					return;
				}

				if (!run.result) {
					let detail = run.stderr;
					if (!detail) {
						detail = `agy exited with code ${run.exitCode} and produced no result event`;
					}

					ctx.ui.notify(`agy failed: ${detail}`, 'info');

					return;
				}

				lastConversation = run.result.conversation_id;

				pi.sendMessage(
					{
						customType: 'agy',
						content: formatReport(run, run.result),
						display: true,
						attribution: 'user'
					},
					{ triggerTurn: false }
				);

				ctx.ui.notify(`agy: done in ${run.result.duration_seconds.toFixed(1)}s`, 'info');
			}
		}
	);
}
