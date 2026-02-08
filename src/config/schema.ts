import { z } from 'zod'

const channelSchema = z.object({
  enabled: z.boolean(),
  token: z.string(),
  allowFrom: z.array(z.string())
})

/**
 * Runtime configuration schema for Microclaw.
 */
export const configSchema = z.object({
  model: z.literal('claude-sonnet-4-5').default('claude-sonnet-4-5'),
  workspace: z.string(),
  channels: z.object({
    telegram: channelSchema,
    discord: channelSchema
  }),
  tools: z.object({
    execTimeoutSec: z.number().int().positive(),
    webSearchApiKey: z.string().optional()
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
  sessionStorePath: z.string(),
  maxToolIterations: z.number().int().positive().default(20)
})

export type MicroclawConfig = z.infer<typeof configSchema>
