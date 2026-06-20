import { z } from 'zod'

const channelSchema = z.object({
  enabled: z.boolean(),
  token: z.string(),
  allowFrom: z.array(z.string())
})

const discordChannelSchema = channelSchema.extend({
  // Optional allowlist of Discord channel IDs. Empty/omitted means allow all channels.
  allowChannels: z.array(z.string()).optional()
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
   */
  harness: z.enum(['pi', 'claude']).default('pi'),
  /**
   * When true, run the agent in a locked-down sandbox: filesystem-mutating and
   * command-execution tools are blocked and sensitive paths are unreadable,
   * across both the Pi and Claude harnesses. Defaults to false (full tool
   * access) to match the personal-assistant model described in the README.
   */
  sandbox: z.boolean().default(false),
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
  personality: z
    .object({
      name: z.string(),
      traits: z.string()
    })
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
  sessionStorePath: z.string(),
  maxToolIterations: z.number().int().positive().default(20),
  /**
   * Per-sender inbound rate limit. Guards against a single user (or a stuck
   * client) flooding the agent with turns. Defaults on with a generous window.
   */
  rateLimit: z
    .object({
      enabled: z.boolean().default(true),
      maxMessages: z.number().int().positive().default(15),
      windowMs: z.number().int().positive().default(10_000)
    })
    .default({
      enabled: true,
      maxMessages: 15,
      windowMs: 10_000
    }),
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
