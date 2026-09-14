import { describe, expect, test } from 'bun:test';
import type { AgyResult, AgyRun, AgyStep, AgyToolInfo, EventStreamState } from './internals.ts';
import {
	DEFAULT_TIMEOUT_SECONDS,
	consumeStdout,
	formatHeader,
	formatReport,
	formatStep,
	parseCommandArgs,
	resolveAgyBinary,
	resolveTimeoutSeconds,
	summarizeStep,
	truncate
} from './internals.ts';

describe(
	'parseCommandArgs',
	() => {
		test(
			'parses empty arguments',
			() => {
				const result = parseCommandArgs('');

				expect(result.prompt)
					.toBe('');
				expect(result.plan)
					.toBe(false);
				expect(result.stop)
					.toBe(false);
				expect(result.fresh)
					.toBe(false);
				expect(result.model)
					.toBeUndefined();
				expect(result.conversation)
					.toBeUndefined();
			}
		);

		test(
			'parses flags and preserves prompt verbatim',
			() => {
				const input = '--plan --model gemini-3.8-flash-high --resume conv-123 Run all unit tests';
				const result = parseCommandArgs(input);

				expect(result.plan)
					.toBe(true);
				expect(result.model)
					.toBe('gemini-3.8-flash-high');
				expect(result.conversation)
					.toBe('conv-123');
				expect(result.prompt)
					.toBe('Run all unit tests');
			}
		);

		test(
			'parses stop flag',
			() => {
				const result = parseCommandArgs('--stop');

				expect(result.stop)
					.toBe(true);
				expect(result.prompt)
					.toBe('');
			}
		);

		test(
			'parses fresh flag',
			() => {
				const result = parseCommandArgs('--new refactor this');

				expect(result.fresh)
					.toBe(true);
				expect(result.prompt)
					.toBe('refactor this');
			}
		);
	}
);

describe(
	'truncate',
	() => {
		test(
			'returns text untouched when within limit',
			() => {
				expect(truncate('hello world', 20))
					.toBe('hello world');
			}
		);

		test(
			'collapses whitespace and appends ellipsis when exceeding limit',
			() => {
				expect(truncate('hello    world    extra', 10))
					.toBe('hello wor…');
			}
		);
	}
);

describe(
	'summarizeStep',
	() => {
		test(
			'returns undefined when no info provided',
			() => {
				expect(summarizeStep())
					.toBeUndefined();
			}
		);

		test(
			'prioritizes CommandLine over other parameters',
			() => {
				const info: AgyToolInfo = {
					name: 'run_command',
					parameters: {
						CommandLine: 'git status -sb',
						DirectoryPath: '/path/to/repo'
					}
				};

				expect(summarizeStep(info))
					.toBe('git status -sb');
			}
		);

		test(
			'truncates base name of TargetFile or AbsolutePath',
			() => {
				const info: AgyToolInfo = {
					name: 'write_to_file',
					parameters: {
						TargetFile: '/Users/test/workspace/project/src/deeply/nested/file.ts'
					}
				};

				expect(summarizeStep(info))
					.toBe('file.ts');
			}
		);
	}
);

describe(
	'formatStep',
	() => {
		test(
			'formats step with detail',
			() => {
				const step: AgyStep = {
					index: 2,
					tool: 'run_command',
					detail: 'npm test',
					elapsedSeconds: 5
				};

				expect(formatStep(step))
					.toBe('agy: step 2 · 5s · run_command · npm test');
			}
		);

		test(
			'formats step without detail',
			() => {
				const step: AgyStep = {
					index: 1,
					tool: 'list_dir',
					elapsedSeconds: 2
				};

				expect(formatStep(step))
					.toBe('agy: step 1 · 2s · list_dir');
			}
		);
	}
);

describe(
	'formatHeader and formatReport',
	() => {
		const dummyResult: AgyResult = {
			conversation_id: 'conv-xyz',
			status: 'SUCCESS',
			response: 'All done.',
			duration_seconds: 12.345,
			num_turns: 3,
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				thinking_tokens: 10,
				cache_read_tokens: 20,
				total_tokens: 180
			}
		};

		test(
			'formats header accurately',
			() => {
				expect(formatHeader(dummyResult))
					.toBe('status: SUCCESS · conversation: conv-xyz · turns: 3 · duration: 12.3s · tokens: 180');
			}
		);

		test(
			'formats report without timeout warning on normal run',
			() => {
				const run: AgyRun = {
					exitCode: 0,
					stderr: '',
					aborted: false,
					timedOut: false,
					result: dummyResult
				};

				const report = formatReport(run, dummyResult);

				expect(report)
					.toContain('status: SUCCESS · conversation: conv-xyz');
				expect(report)
					.toContain('All done.');
				expect(report)
					.not
					.toContain('WARNING: agy hit');
			}
		);

		test(
			'formats report with timeout warning when timed out',
			() => {
				const run: AgyRun = {
					exitCode: 0,
					stderr: 'print timeout after 900s',
					aborted: false,
					timedOut: true,
					result: dummyResult
				};

				const report = formatReport(run, dummyResult);

				expect(report)
					.toContain('WARNING: agy hit the 900s print timeout');
				expect(report)
					.toContain('Resume it with conversation conv-xyz.');
			}
		);
	}
);

describe(
	'resolveTimeoutSeconds',
	() => {
		test(
			'returns default when not set or empty',
			() => {
				expect(resolveTimeoutSeconds({}))
					.toBe(DEFAULT_TIMEOUT_SECONDS);
			}
		);

		test(
			'parses valid integer',
			() => {
				expect(resolveTimeoutSeconds({ PI_AGY_TIMEOUT: '300' }))
					.toBe(300);
			}
		);

		test(
			'falls back to default on invalid or non-positive value',
			() => {
				expect(resolveTimeoutSeconds({ PI_AGY_TIMEOUT: 'abc' }))
					.toBe(DEFAULT_TIMEOUT_SECONDS);
				expect(resolveTimeoutSeconds({ PI_AGY_TIMEOUT: '-10' }))
					.toBe(DEFAULT_TIMEOUT_SECONDS);
				expect(resolveTimeoutSeconds({ PI_AGY_TIMEOUT: '0' }))
					.toBe(DEFAULT_TIMEOUT_SECONDS);
			}
		);
	}
);

describe(
	'resolveAgyBinary',
	() => {
		test(
			'uses PI_AGY_BIN environment variable when present',
			() => {
				const binary = resolveAgyBinary({
					env: { PI_AGY_BIN: '/custom/bin/agy' }
				});

				expect(binary)
					.toBe('/custom/bin/agy');
			}
		);

		test(
			'probes windows candidates on win32 platform',
			() => {
				const probed: string[] = [];
				const which = (name: string) => {
					probed.push(name);
					if (name === 'agy.cmd') {
						return 'C:\\bin\\agy.cmd';
					}

					return null;
				};

				const binary = resolveAgyBinary({
					platform: 'win32',
					which
				});

				expect(binary)
					.toBe('C:\\bin\\agy.cmd');
				expect(probed[0])
					.toBe('agy.cmd');
			}
		);

		test(
			'falls back to agy when resolution fails',
			() => {
				const binary = resolveAgyBinary({
					platform: 'linux',
					which: () => null
				});

				expect(binary)
					.toBe('agy');
			}
		);
	}
);

describe(
	'consumeStdout',
	() => {
		const resultPayload: AgyResult = {
			conversation_id: 'conv-123',
			status: 'SUCCESS',
			response: 'Completed successfully 🚀',
			duration_seconds: 5.5,
			num_turns: 2,
			usage: {
				input_tokens: 10,
				output_tokens: 20,
				thinking_tokens: 5,
				cache_read_tokens: 0,
				total_tokens: 35
			}
		};

		const resultEventJson = JSON.stringify({
			event: 'result',
			result: resultPayload
		});

		const createStreamState = (): EventStreamState => {
			return {
				startedAt: Date.now(),
				options: {
					prompt: 'test prompt',
					cwd: '/tmp'
				},
				steps: 0
			};
		};

		const createStream = (chunks: (Uint8Array | string)[]): ReadableStream<Uint8Array> => {
			const encoder = new TextEncoder();

			return new ReadableStream({
				start(controller) {
					for (const chunk of chunks) {
						if (typeof chunk === 'string') {
							controller.enqueue(encoder.encode(chunk));
						} else {
							controller.enqueue(chunk);
						}
					}

					controller.close();
				}
			});
		};

		test(
			'processes final result event with a trailing newline',
			async () => {
				const state = createStreamState();
				const stream = createStream([`${resultEventJson}\n`]);

				await consumeStdout(stream, state);

				expect(state.result)
					.toEqual(resultPayload);
			}
		);

		test(
			'processes final result event without a trailing newline',
			async () => {
				const state = createStreamState();
				const stream = createStream([resultEventJson]);

				await consumeStdout(stream, state);

				expect(state.result)
					.toEqual(resultPayload);
			}
		);

		test(
			'processes one JSON event split across multiple chunks',
			async () => {
				const state = createStreamState();
				const bytes = new TextEncoder().encode(`${resultEventJson}\n`);
				const splitIndex = bytes.findIndex((byte, index) => index > 0 && (byte & 0xc0) === 0x80);

				expect(splitIndex)
					.toBeGreaterThan(0);

				const chunk1 = bytes.subarray(0, splitIndex);
				const chunk2 = bytes.subarray(splitIndex);
				const stream = createStream([chunk1, chunk2]);

				await consumeStdout(stream, state);

				expect(state.result)
					.toEqual(resultPayload);
			}
		);

		test(
			'processes one JSON event split across multiple chunks without a trailing newline',
			async () => {
				const state = createStreamState();
				const bytes = new TextEncoder().encode(resultEventJson);
				const splitIndex = bytes.findIndex((byte, index) => index > 0 && (byte & 0xc0) === 0x80);

				expect(splitIndex)
					.toBeGreaterThan(0);

				const chunk1 = bytes.subarray(0, splitIndex);
				const chunk2 = bytes.subarray(splitIndex);
				const stream = createStream([chunk1, chunk2]);

				await consumeStdout(stream, state);

				expect(state.result)
					.toEqual(resultPayload);
			}
		);
	}
);
