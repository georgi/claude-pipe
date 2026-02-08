export interface SummaryPromptTemplateConfig {
  enabled: boolean
  template: string
}

const SUMMARY_PATTERN = /\b(summarize|summary)\b/i
const FILE_PATTERN = /\b(file|files|workspace|repo|repository|project)\b/i

/**
 * Applies workspace summary template to summary-like requests.
 */
export function applySummaryTemplate(
  input: string,
  config: SummaryPromptTemplateConfig,
  workspace: string
): string {
  if (!config.enabled) return input

  const likelySummaryRequest = SUMMARY_PATTERN.test(input) && FILE_PATTERN.test(input)
  if (!likelySummaryRequest) return input

  return config.template
    .replaceAll('{{workspace}}', workspace)
    .replaceAll('{{request}}', input)
}
