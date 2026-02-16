# Image and Media Attachments

Claude Pipe supports **bidirectional** image and media attachments for both Telegram and Discord channels. Agents can receive attachments from users and send attachments back in responses. This document describes how attachments flow through the system.

## Supported Attachment Types

- **Images**: Photos sent/received via Telegram or Discord
- **Videos**: Video files from either channel
- **Documents**: Files and documents (PDFs, text files, etc.)
- **Audio**: Audio files (in addition to Telegram voice messages which are transcribed)

## Architecture

### Bidirectional Message Flow

```
┌─────────────── Inbound Flow ────────────────┐
User sends message with attachment
    ↓
Channel adapter extracts attachment metadata
    ↓
InboundMessage with attachments array
    ↓
Agent Loop
    ↓
ModelClient receives attachments parameter
    ↓
Agent processes with attachment context
    ↓
Agent generates response (optionally with attachments)
    ↓
OutboundMessage with attachments array
    ↓
Channel adapter sends attachments
    ↓
User receives message with attachments
└─────────────── Outbound Flow ───────────────┘
```

### Attachment Interface

```typescript
interface Attachment {
  type: 'image' | 'video' | 'audio' | 'document' | 'file'
  url?: string          // Remote URL (Discord) or Telegram file URL
  path?: string         // Local file path if downloaded
  mimeType?: string     // Content type
  size?: number         // File size in bytes
  filename?: string     // Original filename
}
```

## Channel-Specific Behavior

### Telegram

**Inbound (Receiving from Users):**

1. The channel adapter detects the attachment type (photo, document, video)
2. It retrieves the file metadata via the Telegram Bot API `getFile` endpoint
3. The attachment is stored with a Telegram file URL in the format:
   ```
   https://api.telegram.org/file/bot<token>/<file_path>
   ```
4. The attachment metadata is added to the `InboundMessage.attachments` array
5. If a caption is provided, it becomes the message content

**Outbound (Sending to Users):**

1. When `OutboundMessage` includes attachments, each is sent via the appropriate API:
   - Images → `sendPhoto`
   - Videos → `sendVideo`
   - Audio → `sendAudio`
   - Documents/Files → `sendDocument`
2. Attachments are sent first, followed by text content
3. Supports both URL-based attachments and local file paths
4. Optional captions can be included with each attachment

### Discord

**Inbound (Receiving from Users):**

1. The channel adapter checks the `message.attachments` collection
2. Discord attachments include direct URLs (note: these URLs expire after ~24 hours)
3. Content type is used to determine the attachment type:
   - `image/*` → `type: 'image'`
   - `video/*` → `type: 'video'`
   - `audio/*` → `type: 'audio'`
   - Others → `type: 'document'`
4. The attachment metadata is added to the `InboundMessage.attachments` array

**Outbound (Sending to Users):**

1. When `OutboundMessage` includes attachments, they are sent via Discord's file attachment API
2. Multiple attachments are sent together with the message
3. Discord accepts both URLs and local file paths as attachment sources
4. Attachments are sent with the first chunk of text if message content is long

## Agent Interface

The `ModelClient` interface defines how agents receive and process attachments:

```typescript
interface ModelClient {
  runTurn(
    conversationKey: string,
    userText: string,
    context: ToolContext,
    attachments?: Attachment[]
  ): Promise<string>
}
```

### Implementation Guidelines

When implementing the `ModelClient` interface to handle attachments:

1. **Describe attachments in text**: Since the Claude CLI currently accepts text arguments, attachments are described to the LLM:
   ```
   [User sent image: photo.jpg (URL: https://...)]
   [User sent document: report.pdf at /tmp/downloads/report.pdf]
   
   {original user message}
   ```

2. **Make files accessible**: For attachments with local paths, ensure they're within or accessible from the workspace directory so the agent can use file tools to read/analyze them.

3. **Handle multiple attachments**: Users can send multiple files in one message. Each attachment should be described separately.

## Usage Examples

### Telegram Photo

User sends a photo with caption "What's in this image?"

```typescript
{
  content: "What's in this image?",
  attachments: [{
    type: 'image',
    url: 'https://api.telegram.org/file/bot.../photo.jpg',
    filename: 'photo.jpg',
    size: 245678
  }]
}
```

Agent receives:
```
[User sent image: photo.jpg (URL: https://api.telegram.org/file/bot.../photo.jpg)]

What's in this image?
```

### Discord File Attachment

User sends a PDF document with message "Review this document"

```typescript
{
  content: "Review this document",
  attachments: [{
    type: 'document',
    url: 'https://cdn.discordapp.com/attachments/.../report.pdf',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    size: 1024567
  }]
}
```

Agent receives:
```
[User sent document: report.pdf (URL: https://cdn.discordapp.com/attachments/.../report.pdf)]

Review this document
```

### Agent Sending Image (Outbound)

Agent generates a response with an image attachment:

```typescript
{
  content: "Here's the chart you requested",
  attachments: [{
    type: 'image',
    url: 'https://example.com/chart.png',
    filename: 'sales_chart.png'
  }]
}
```

Result:
- **Telegram**: Bot sends photo via `sendPhoto`, then text message
- **Discord**: Bot sends message with embedded image

### Agent Sending Multiple Files (Outbound)

Agent sends multiple attachments:

```typescript
{
  content: "Analysis complete. See attached files:",
  attachments: [
    { type: 'document', url: 'https://example.com/report.pdf', filename: 'report.pdf' },
    { type: 'image', url: 'https://example.com/graph.png', filename: 'graph.png' }
  ]
}
```

Result:
- **Telegram**: Bot sends document, then image, then text
- **Discord**: Bot sends all attachments with the message

## Future Enhancements

Potential improvements for attachment handling:

1. **Vision capabilities**: When using vision-capable models, pass image data directly to the LLM instead of just descriptions
2. **Automatic download**: Download attachments to workspace temporary directory for easier agent access
3. **File type detection**: Enhanced MIME type detection and file format validation
4. **Size limits**: Configurable file size limits and rejection of oversized attachments
5. **Caching**: Cache frequently accessed attachments to reduce bandwidth

## Testing

When testing attachment functionality:

1. Send images via Telegram and verify they appear in agent context
2. Send documents via Discord and verify metadata is captured
3. Send messages with multiple attachments
4. Test messages with only attachments (no text)
5. Verify text-only messages still work without regressions
