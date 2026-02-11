# Codex CLI App Server Migration Guide

This guide migrates Claude-specific JSON/HTTP integration loops to Codex CLI `app-server` JSON-RPC over stdio (newline-delimited JSON).

## 1) Core Message Mapping

`Claude -> Codex` mapping used in this repo:

- `session create` -> `thread/start`
- `session resume` -> `thread/resume`
- `turn start` -> `turn/start`
- `message send` -> `turn/start.input[]` with `{ type: "text", text, text_elements: [] }`
- `tool invocation` -> `item/started` and `item/completed` notifications with `item.type` (`commandExecution`, `fileChange`, `mcpToolCall`, ...)
- `apply diff` -> `fileChange` item + `item/fileChange/requestApproval` server request
- `approval request` -> server requests:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
  - `item/tool/requestUserInput`
- `workspace context injection` -> `thread/start.cwd` and `turn/start.input` preamble text

## 2) JSON-RPC Loop

Transport contract:

- Process: `codex app-server`
- Input: one JSON-RPC message per line on `stdin`
- Output: one JSON-RPC message per line on `stdout`
- Parse three shapes:
  - response: `{"id":..., "result":...}` or `{"id":..., "error":...}`
  - notification: `{"method":"...", "params":...}` (no `id`)
  - server request: `{"id":..., "method":"...", "params":...}` (must respond)

## 3) Authentication Differences

- Claude integration usually depends on Claude CLI/session setup.
- Codex integration uses Codex local session or API key environment variable.
- In this repo, set:
  - `CLAUDEPIPE_LLM_PROVIDER=codex`
  - optional `CLAUDEPIPE_CODEX_API_KEY_ENV_VAR` (defaults to `OPENAI_API_KEY`)
  - optional `CLAUDEPIPE_CODEX_COMMAND`, `CLAUDEPIPE_CODEX_ARGS`

## 4) Streaming / Error Semantics

- Claude stream-json emits turn/tool/result frames.
- Codex app-server emits JSON-RPC notifications:
  - token deltas: `item/agentMessage/delta`
  - progress: `item/started`, `item/completed`, `item/mcpToolCall/progress`, `item/commandExecution/outputDelta`
  - terminal status: `turn/completed`
- JSON-RPC request failures come via `error` object (`code`, `message`).

## 5) Patch Pattern (Minimal Diff)

```diff
- const response = await claudeHttp.send({ sessionId, prompt, workspace })
- onClaudeStream(frame => handleFrame(frame))
+ const rpc = spawn(codexBin, ["app-server"])
+ await rpcRequest("initialize", {...})
+ const thread = sessionId
+   ? await rpcRequest("thread/resume", { threadId: sessionId, cwd: workspace })
+   : await rpcRequest("thread/start", { cwd: workspace, experimentalRawEvents: false })
+ await rpcRequest("turn/start", {
+   threadId: thread.thread.id,
+   input: [{ type: "text", text: `Workspace: ${workspace}\\n\\n${prompt}`, text_elements: [] }]
+ })
+ onRpcMessage(msg => {
+   if (isResponse(msg)) resolvePending(msg)
+   else if (isServerRequest(msg)) respondApproval(msg)
+   else if (isNotification(msg)) handleCodexEvent(msg)
+ })
```

## 6) Example Snippets

### Node.js (stdio JSON-RPC)

```js
import { spawn } from "node:child_process";

const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
let id = 0;
const pending = new Map();

const request = (method, params) => {
  const reqId = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }) + "\n");
  return new Promise((resolve, reject) => pending.set(reqId, { resolve, reject }));
};

child.stdout.on("data", (buf) => {
  for (const line of buf.toString().split("\n").filter(Boolean)) {
    const msg = JSON.parse(line);
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const slot = pending.get(msg.id);
      if (!slot) continue;
      pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message));
      else slot.resolve(msg.result);
      continue;
    }
    if ("method" in msg && "id" in msg) {
      if (msg.method === "item/commandExecution/requestApproval") {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { decision: "accept" } }) + "\n");
      }
      continue;
    }
    if (msg.method === "item/agentMessage/delta") process.stdout.write(msg.params.delta);
  }
});

await request("initialize", {
  clientInfo: { name: "my-app", title: null, version: "1.0.0" },
  capabilities: { experimentalApi: false }
});
const thread = await request("thread/start", { cwd: process.cwd(), experimentalRawEvents: false });
await request("turn/start", {
  threadId: thread.thread.id,
  input: [{ type: "text", text: "Add logging to this function", text_elements: [] }]
});
```

### Python

```python
import json
import subprocess

p = subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

def send(msg):
    p.stdin.write(json.dumps(msg) + "\n")
    p.stdin.flush()

req_id = 1
send({"jsonrpc":"2.0","id":req_id,"method":"initialize","params":{
    "clientInfo":{"name":"py-client","title":None,"version":"0.1.0"},
    "capabilities":{"experimentalApi":False}
}})

for raw in p.stdout:
    msg = json.loads(raw)
    if msg.get("method") == "item/agentMessage/delta":
        print(msg["params"]["delta"], end="")
```

### Go

```go
cmd := exec.Command("codex", "app-server")
stdin, _ := cmd.StdinPipe()
stdout, _ := cmd.StdoutPipe()
_ = cmd.Start()

enc := json.NewEncoder(stdin)
dec := json.NewDecoder(bufio.NewReader(stdout))

_ = enc.Encode(map[string]any{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": map[string]any{
    "clientInfo": map[string]any{"name":"go-client","title":nil,"version":"0.1.0"},
    "capabilities": map[string]any{"experimentalApi": false},
  },
})

for {
  var msg map[string]any
  if err := dec.Decode(&msg); err != nil { break }
  if method, ok := msg["method"].(string); ok && method == "item/agentMessage/delta" {
    params := msg["params"].(map[string]any)
    fmt.Print(params["delta"].(string))
  }
}
```

## 7) Test Harness Strategy

- Unit tests:
  - JSON-RPC framing (`\n` terminated writes)
  - parser classification (response vs notification vs server request)
  - server-request approval response shape
- Integration tests:
  - spawn a fake app-server subprocess
  - run prompt (`"add logging to this function"`)
  - assert:
    - thread id persisted
    - `item/agentMessage/delta` streamed into final response text
    - `fileChange` item notifications generate structured progress updates
