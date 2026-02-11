#!/usr/bin/env node
import readline from 'node:readline'

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
})

let threadId = 'thread-fake-1'
let turnId = 'turn-fake-1'

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

for await (const line of rl) {
  if (!line.trim()) continue
  const msg = JSON.parse(line)

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake-codex' } })
    continue
  }

  if (msg.method === 'thread/start') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        thread: { id: threadId, cwd: process.cwd() }
      }
    })
    send({
      jsonrpc: '2.0',
      method: 'thread/started',
      params: { thread: { id: threadId, cwd: process.cwd() } }
    })
    continue
  }

  if (msg.method === 'thread/resume') {
    threadId = msg.params.threadId
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        thread: { id: threadId, cwd: process.cwd() }
      }
    })
    continue
  }

  if (msg.method === 'turn/start') {
    turnId = 'turn-fake-2'
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: turnId, status: 'in_progress', error: null } } })
    send({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { threadId, turn: { id: turnId, status: 'in_progress', error: null } }
    })
    send({
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId,
        turnId,
        item: {
          type: 'fileChange',
          id: 'change-1',
          status: 'in_progress'
        }
      }
    })
    send({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        threadId,
        turnId,
        itemId: 'agent-1',
        delta: 'Added logging to the target function.'
      }
    })
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          type: 'fileChange',
          id: 'change-1',
          status: 'completed'
        }
      }
    })
    send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: turnId, status: 'completed', error: null }
      }
    })
    setTimeout(() => {
      process.exit(0)
    }, 10)
    continue
  }

  if (msg.id && msg.result) {
    continue
  }
}
