import { z } from 'zod'

const channelSchema = z.object({
  enabled: z.boolean(),
  token: z.string(),
  allowFrom: z.array(z.string())
})

const discordChannelSchema = channelSchema.extend({
  // Optional allowlist of Discord channel IDs. Empty/omitted means allow all channels.
  // Thread messages are matched against the thread's parent channel too.
  allowChannels: z.array(z.string()).optional(),
  // Automatically open a Discord thread per conversation so every session gets
  // its own thread (and therefore its own agent session). Defaults to enabled.
  useThreads: z.boolean().optional(),
  // Discord only accepts these four auto-archive durations (minutes).
  threadAutoArchiveMinutes: z
    .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
    .optional()
})

const cliChannelSchema = z.object({
  enabled: z.boolean().default(false),
  allowFrom: z.array(z.string()).default([])
})

/**
 * Runtime configuration schema for Pi Pipe.
 */
export const configSchema = z.object({
  /**
   * Which agent harness drives conversations:
   * - `pi`     — the Pi Coding Agent SDK (multi-provider; default).
   * - `claude` — the Claude Agent SDK (Anthropic models only).
   * - `codex`  — the OpenAI Codex SDK (OpenAI models only).
   */
  harness: z.enum(['pi', 'claude', 'codex']).default('pi'),
  model: z.string(),
  workspace: z.string(),
  channels: z.object({
    telegram: channelSchema,
    discord: discordChannelSchema,
    cli: cliChannelSchema.optional()
  }),
  summaryPrompt: z
    .object({
      enabled: z.boolean().default(true),
      template: z
        .string()
        .default(
          'Workspace: {{workspace}}\n' +
            'Request: {{request}}\n' +
            'Provide a concise summary with key files and actionable insights.'
        )
    })
    .default({
      enabled: true,
      template:
        'Workspace: {{workspace}}\n' +
        'Request: {{request}}\n' +
        'Provide a concise summary with key files and actionable insights.'
    }),
  transcriptLog: z
    .object({
      enabled: z.boolean().default(false),
      path: z.string(),
      maxBytes: z.number().int().positive().optional(),
      maxFiles: z.number().int().positive().optional()
    })
    .default({
      enabled: false,
      path: `${process.cwd()}/data/transcript.jsonl`,
      maxBytes: 1_000_000,
      maxFiles: 3
    }),
  /**
   * Codex-harness knobs. Ignored by every other harness.
   *
   * The defaults match how the Pi and Claude harnesses already run — full
   * workspace access and no interactive approvals — because a chat bot has
   * nobody at a terminal to answer an approval prompt, and a blocked turn
   * would just hang. Tighten `sandboxMode` if you want Codex fenced in.
   */
  codex: z
    .object({
      sandboxMode: z
        .enum(['read-only', 'workspace-write', 'danger-full-access'])
        .default('danger-full-access'),
      approvalPolicy: z.enum(['never', 'on-request', 'on-failure', 'untrusted']).default('never'),
      webSearch: z.boolean().default(true),
      // Codex refuses to run outside a git repository unless this is set.
      skipGitRepoCheck: z.boolean().default(true),
      reasoningEffort: z
        .enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'])
        .optional()
    })
    .default({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      webSearch: true,
      skipGitRepoCheck: true
    }),
  personality: z
    .object({
      name: z.string(),
      traits: z.string()
    })
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
  sessionStorePath: z.string(),
  maxToolIterations: z.number().int().positive().default(20),
  heartbeat: z
    .object({
      enabled: z.boolean().default(true),
      intervalMinutes: z.number().int().positive().default(30),
      defaultChatId: z.string().optional(),
      defaultChannel: z.enum(['telegram', 'discord', 'cli']).optional()
    })
    .default({
      enabled: true,
      intervalMinutes: 30
    }),
  memory: z
    .object({
      enabled: z.boolean().default(true),
      dbPath: z.string().default('data/memory.sqlite'),
      dailyLogPath: z.string().default('data/logs')
    })
    .default({
      enabled: true,
      dbPath: 'data/memory.sqlite',
      dailyLogPath: 'data/logs'
    })
})

export type PiPipeConfig = z.infer<typeof configSchema>
