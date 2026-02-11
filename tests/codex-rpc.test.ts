import { describe, expect, it } from 'vitest'

import {
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcServerRequest
} from '../src/core/codex-rpc.js'

describe('codex json-rpc guards', () => {
  it('classifies responses, notifications, and server requests', () => {
    const response = { jsonrpc: '2.0', id: 1, result: { ok: true } }
    const notification = { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 't1' } }
    const serverRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 't1', turnId: 'u1', itemId: 'i1' }
    }

    expect(isJsonRpcResponse(response)).toBe(true)
    expect(isJsonRpcNotification(response)).toBe(false)
    expect(isJsonRpcServerRequest(response)).toBe(false)

    expect(isJsonRpcNotification(notification)).toBe(true)
    expect(isJsonRpcResponse(notification)).toBe(false)
    expect(isJsonRpcServerRequest(notification)).toBe(false)

    expect(isJsonRpcServerRequest(serverRequest)).toBe(true)
    expect(isJsonRpcResponse(serverRequest)).toBe(false)
    expect(isJsonRpcNotification(serverRequest)).toBe(false)
  })
})
