import type { ChannelName } from '../../core/types.js'
import type { CommandDefinition, CommandResult } from '../types.js'

/**
 * /claude_ask <prompt>
 * Sends a prompt directly to Claude (convenience wrapper).
 */
export function claudeAskCommand(
  runTurn: (conversationKey: string, prompt: string, channel: ChannelName, chatId: string) => Promise<string>
): CommandDefinition {
  return {
    name: 'claude_ask',
    category: 'claude',
    description: 'Send a prompt to Claude',
    usage: '/claude_ask <prompt>',
    aliases: ['ask'],
    permission: 'user',
    async execute(ctx): Promise<CommandResult> {
      if (!ctx.rawArgs) {
        return { content: 'Usage: /claude_ask <prompt>', error: true }
      }
      const reply = await runTurn(ctx.conversationKey, ctx.rawArgs, ctx.channel, ctx.chatId)
      return { content: reply }
    }
  }
}

/**
 * /claude_model [model_name]
 * Shows or switches the active model.
 */
export function claudeModelCommand(
  getModel: () => string,
  setModel?: (model: string) => void
): CommandDefinition {
  return {
    name: 'claude_model',
    category: 'claude',
    description: 'Show or switch the active Claude model',
    usage: '/claude_model [model_name]',
    aliases: ['model'],
    permission: 'admin',
    async execute(ctx): Promise<CommandResult> {
      if (ctx.args.length === 0 || !ctx.args[0]) {
        return { content: `Current model: ${getModel()}` }
      }
      if (!setModel) {
        return { content: 'Model switching is not supported in this configuration.', error: true }
      }
      const newModel = ctx.args[0]
      setModel(newModel)
      return { content: `Model switched to: ${newModel}` }
    }
  }
}
