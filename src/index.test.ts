import type { ExtensionAPI, ToolDefinition } from '@oh-my-pi/pi-coding-agent';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import antigravity from './index.ts';

interface RegisteredCommandOptions {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

function createMockExtensionAPI() {
	let label = '';
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, RegisteredCommandOptions>();

	const api = {
		zod: z,
		setLabel(next: string) {
			label = next;
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: RegisteredCommandOptions) {
			commands.set(name, command);
		},
		sendMessage() {
			return;
		}
	} as unknown as ExtensionAPI;

	return {
		api,
		getLabel: () => label,
		getTool: (name: string) => tools.get(name),
		getCommand: (name: string) => commands.get(name)
	};
}

describe(
	'antigravity extension registration',
	() => {
		test(
			'registers label, agy tool, and agy command',
			() => {
				const mock = createMockExtensionAPI();
				antigravity(mock.api);

				expect(mock.getLabel())
					.toBe('Antigravity');

				const tool = mock.getTool('agy');
				expect(tool)
					.toBeDefined();
				expect(tool?.name)
					.toBe('agy');

				const command = mock.getCommand('agy');
				expect(command)
					.toBeDefined();
				expect(command?.description)
					.toContain('/agy');
			}
		);

		test(
			'validates tool parameters with zod schema',
			() => {
				const mock = createMockExtensionAPI();
				antigravity(mock.api);

				const tool = mock.getTool('agy');
				const schema = tool?.parameters as unknown as z.ZodObject<z.ZodRawShape>;

				expect(schema)
					.toBeDefined();

				const valid = schema.safeParse({
					prompt: 'Do something',
					model: 'gemini-3.8-flash-high',
					plan: true
				});

				expect(valid.success)
					.toBe(true);

				const invalid = schema.safeParse({});

				expect(invalid.success)
					.toBe(false);
			}
		);

		test(
			'handles /agy without prompt by notifying usage',
			async () => {
				const mock = createMockExtensionAPI();
				antigravity(mock.api);

				const command = mock.getCommand('agy');
				const notifications: string[] = [];

				const mockContext = {
					cwd: '/test',
					ui: {
						notify(msg: string) {
							notifications.push(msg);
						},
						setWidget() {
							return;
						}
					}
				};

				await command?.handler('', mockContext as never);

				expect(notifications.length)
					.toBe(1);
				expect(notifications[0])
					.toContain('Usage: /agy');
			}
		);

		test(
			'handles /agy --stop by stopping active runs and notifying',
			async () => {
				const mock = createMockExtensionAPI();
				antigravity(mock.api);

				const command = mock.getCommand('agy');
				const notifications: string[] = [];

				const mockContext = {
					cwd: '/test',
					ui: {
						notify(msg: string) {
							notifications.push(msg);
						},
						setWidget() {
							return;
						}
					}
				};

				await command?.handler('--stop', mockContext as never);

				expect(notifications.length)
					.toBe(1);
				expect(notifications[0])
					.toContain('agy: stopped 0 run(s)');
			}
		);
	}
);
