import { z } from 'zod'

const channelSchema = z.object({
  enabled: z.boolean(),
  token: z.string(),
  allowFrom: z.array(z.string()),
  webhookSecret: z.string().default('')
})

const cliChannelSchema = z.object({
  enabled: z.boolean().default(false),
  allowFrom: z.array(z.string()).default([])
})

/**
 * Webhook server configuration for receiving updates via HTTP instead of polling/gateway.
 */
export const webhookSchema = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().int().positive().default(3000),
    host: z.string().default('0.0.0.0'),
    url: z.string().default('')
  })
  .default({
    enabled: false,
    port: 3000,
    host: '0.0.0.0',
    url: ''
  })

/**
 * Runtime configuration schema for Claude Pipe.
 */
export const configSchema = z.object({
  llmProvider: z.enum(['claude', 'codex']).default('claude'),
  model: z.string(),
  workspace: z.string(),
  channels: z.object({
    telegram: channelSchema,
    discord: channelSchema,
    cli: cliChannelSchema.optional()
  }),
  webhook: webhookSchema,
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
    })
})

export type ClaudePipeConfig = z.infer<typeof configSchema>
