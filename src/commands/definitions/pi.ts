import type { ChannelName } from '../../core/types.js'
import type { CommandDefinition, CommandResult } from '../types.js'

/**
 * /pi_ask <prompt>
 * Sends a prompt directly to Pi (convenience wrapper).
 */
export function piAskCommand(
  runTurn: (
    conversationKey: string,
    prompt: string,
    channel: ChannelName,
    chatId: string
  ) => Promise<string>
): CommandDefinition {
  return {
    name: 'pi_ask',
    category: 'pi',
    description: 'Send a prompt to Pi',
    usage: '/pi_ask <prompt>',
    aliases: ['ask'],
    permission: 'user',
    async execute(ctx): Promise<CommandResult> {
      if (!ctx.rawArgs) {
        return { content: 'Usage: /pi_ask <prompt>', error: true }
      }
      const reply = await runTurn(ctx.conversationKey, ctx.rawArgs, ctx.channel, ctx.chatId)
      return { content: reply }
    }
  }
}

/**
 * /pi_model [model_name]
 * Shows or switches the active model.
 */
export function piModelCommand(
  getModel: () => string,
  setModel?: (model: string) => void
): CommandDefinition {
  return {
    name: 'pi_model',
    category: 'pi',
    description: 'Show or switch the active Pi model',
    usage: '/pi_model [model_name]',
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
