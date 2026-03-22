/**
 * Plugin marketplace registry.
 *
 * Aggregates popular Claude plugin/MCP server catalogs and provides
 * a unified search & listing interface.
 */

export interface PluginEntry {
  /** Unique identifier (org/name). */
  id: string
  /** Human-readable display name. */
  name: string
  /** Short description. */
  description: string
  /** Installation method. */
  install: PluginInstallMethod
  /** Source marketplace. */
  source: string
  /** Tags / categories. */
  tags: string[]
}

export type PluginInstallMethod =
  | { type: 'npm'; package: string }
  | { type: 'git'; url: string }
  | { type: 'npx'; command: string }

export interface Marketplace {
  name: string
  url: string
  plugins: PluginEntry[]
}

// ---------------------------------------------------------------------------
// Helper to reduce boilerplate when defining plugin entries.
// ---------------------------------------------------------------------------
function npx(
  id: string,
  name: string,
  description: string,
  command: string,
  source: string,
  tags: string[]
): PluginEntry {
  return { id, name, description, install: { type: 'npx', command }, source, tags }
}

function npm(
  id: string,
  name: string,
  description: string,
  pkg: string,
  source: string,
  tags: string[]
): PluginEntry {
  return { id, name, description, install: { type: 'npm', package: pkg }, source, tags }
}

function git(
  id: string,
  name: string,
  description: string,
  url: string,
  source: string,
  tags: string[]
): PluginEntry {
  return { id, name, description, install: { type: 'git', url }, source, tags }
}

// ---------------------------------------------------------------------------
// Marketplace sources
// ---------------------------------------------------------------------------

const SRC_OFFICIAL = 'MCP Official'
const SRC_COMMUNITY = 'Community Popular'
const SRC_DEVTOOLS = 'Developer Tools'
const SRC_DATA = 'Data & Databases'
const SRC_PRODUCTIVITY = 'Productivity & Communication'
const SRC_CLOUD = 'Cloud & Infrastructure'
const SRC_WEB = 'Web & Browser'
const SRC_AI = 'AI & ML'

/**
 * Built-in catalog of popular Claude/MCP plugins from well-known sources.
 * Curated from the official MCP servers repo, awesome-mcp-servers,
 * mcpservers.org, PulseMCP, and popular open-source projects.
 */
const MARKETPLACES: Marketplace[] = [
  // ── Official / Reference servers ──────────────────────────────────────
  {
    name: SRC_OFFICIAL,
    url: 'https://github.com/modelcontextprotocol/servers',
    plugins: [
      npx('official/filesystem', 'Filesystem', 'Read, write, and manage files on the local filesystem', '@anthropic-ai/mcp-server-filesystem', SRC_OFFICIAL, ['files', 'io', 'core']),
      npx('official/git', 'Git', 'Git operations — clone, commit, diff, log, and branch management', '@anthropic-ai/mcp-server-git', SRC_OFFICIAL, ['git', 'vcs', 'devtools']),
      npx('official/github', 'GitHub', 'Interact with GitHub repos, issues, PRs, and more', '@anthropic-ai/mcp-server-github', SRC_OFFICIAL, ['github', 'git', 'devtools']),
      npx('official/gitlab', 'GitLab', 'GitLab API — project management, MRs, and CI pipelines', '@anthropic-ai/mcp-server-gitlab', SRC_OFFICIAL, ['gitlab', 'git', 'devtools']),
      npx('official/postgres', 'PostgreSQL', 'Read-only queries and schema inspection for PostgreSQL', '@anthropic-ai/mcp-server-postgres', SRC_OFFICIAL, ['database', 'sql', 'postgres']),
      npx('official/sqlite', 'SQLite', 'Query and manage SQLite databases', '@anthropic-ai/mcp-server-sqlite', SRC_OFFICIAL, ['database', 'sql', 'sqlite']),
      npx('official/memory', 'Memory', 'Persistent memory using a knowledge graph', '@anthropic-ai/mcp-server-memory', SRC_OFFICIAL, ['memory', 'knowledge', 'core']),
      npx('official/fetch', 'Fetch', 'Fetch and process content from URLs', '@anthropic-ai/mcp-server-fetch', SRC_OFFICIAL, ['http', 'web', 'fetch']),
      npx('official/brave-search', 'Brave Search', 'Web search powered by the Brave Search API', '@anthropic-ai/mcp-server-brave-search', SRC_OFFICIAL, ['search', 'web']),
      npx('official/google-maps', 'Google Maps', 'Location search, directions, and place details via Google Maps', '@anthropic-ai/mcp-server-google-maps', SRC_OFFICIAL, ['maps', 'location', 'google']),
      npx('official/puppeteer', 'Puppeteer', 'Browser automation and web scraping via Puppeteer', '@anthropic-ai/mcp-server-puppeteer', SRC_OFFICIAL, ['browser', 'web', 'scraping']),
      npx('official/slack', 'Slack', 'Channel management and messaging capabilities for Slack', '@anthropic-ai/mcp-server-slack', SRC_OFFICIAL, ['slack', 'messaging', 'communication']),
      npx('official/google-drive', 'Google Drive', 'File access and search capabilities for Google Drive', '@anthropic-ai/mcp-server-google-drive', SRC_OFFICIAL, ['google', 'drive', 'files']),
      npx('official/sentry', 'Sentry', 'Retrieve and analyze issues from Sentry.io', '@anthropic-ai/mcp-server-sentry', SRC_OFFICIAL, ['sentry', 'monitoring', 'errors']),
      npx('official/sequential-thinking', 'Sequential Thinking', 'Dynamic and reflective problem-solving through thought sequences', '@anthropic-ai/mcp-server-sequential-thinking', SRC_OFFICIAL, ['reasoning', 'thinking', 'core']),
      npx('official/time', 'Time', 'Time and timezone conversion capabilities', '@anthropic-ai/mcp-server-time', SRC_OFFICIAL, ['time', 'timezone', 'utility']),
      npx('official/everart', 'EverArt', 'AI image generation using various models', '@anthropic-ai/mcp-server-everart', SRC_OFFICIAL, ['image', 'ai', 'generation']),
      npx('official/everything', 'Everything', 'Reference / test server with prompts, resources, and tools', '@anthropic-ai/mcp-server-everything', SRC_OFFICIAL, ['testing', 'reference', 'core'])
    ]
  },

  // ── Developer Tools ───────────────────────────────────────────────────
  {
    name: SRC_DEVTOOLS,
    url: 'https://github.com/punkpeye/awesome-mcp-servers',
    plugins: [
      npm('devtools/playwright', 'Playwright', 'Browser automation and testing with Playwright', 'playwright-mcp-server', SRC_DEVTOOLS, ['browser', 'testing', 'automation']),
      npm('devtools/docker', 'Docker', 'Manage Docker containers, images, volumes, and networks', 'docker-mcp-server', SRC_DEVTOOLS, ['docker', 'containers', 'devops']),
      npm('devtools/kubernetes', 'Kubernetes', 'Manage Kubernetes clusters, pods, and deployments', 'kubernetes-mcp-server', SRC_DEVTOOLS, ['kubernetes', 'k8s', 'devops']),
      npm('devtools/openapi', 'OpenAPI', 'Generate MCP tools from any OpenAPI/Swagger spec', 'openapi-mcp-server', SRC_DEVTOOLS, ['openapi', 'api', 'swagger']),
      npm('devtools/graphql', 'GraphQL', 'Query any GraphQL endpoint with introspection support', 'graphql-mcp-server', SRC_DEVTOOLS, ['graphql', 'api']),
      npm('devtools/postman', 'Postman', 'Run Postman collections and test API endpoints', 'postman-mcp-server', SRC_DEVTOOLS, ['postman', 'api', 'testing']),
      npm('devtools/npm-registry', 'npm Registry', 'Search npm packages, view metadata, and compare versions', 'npm-registry-mcp-server', SRC_DEVTOOLS, ['npm', 'packages', 'registry']),
      npm('devtools/eslint', 'ESLint', 'Run ESLint analysis and auto-fix code issues', 'eslint-mcp-server', SRC_DEVTOOLS, ['eslint', 'linting', 'code-quality']),
      npm('devtools/prettier', 'Prettier', 'Format code using Prettier with project configuration', 'prettier-mcp-server', SRC_DEVTOOLS, ['prettier', 'formatting', 'code-quality']),
      npm('devtools/jest', 'Jest', 'Run Jest tests and view results inline', 'jest-mcp-server', SRC_DEVTOOLS, ['jest', 'testing', 'javascript']),
      npm('devtools/selenium', 'Selenium', 'Web browser automation via Selenium WebDriver', 'selenium-mcp-server', SRC_DEVTOOLS, ['selenium', 'browser', 'testing']),
      git('devtools/xcode', 'Xcode', 'Build, run, and test iOS/macOS apps on simulators and devices', 'https://github.com/anthropics/xcode-mcp-server', SRC_DEVTOOLS, ['xcode', 'ios', 'macos', 'mobile']),
      npm('devtools/circleci', 'CircleCI', 'Trigger and monitor CircleCI pipelines and workflows', 'circleci-mcp-server', SRC_DEVTOOLS, ['circleci', 'ci-cd', 'devops']),
      npm('devtools/github-actions', 'GitHub Actions', 'Manage and monitor GitHub Actions workflows', 'github-actions-mcp-server', SRC_DEVTOOLS, ['github', 'ci-cd', 'devops']),
      npm('devtools/terraform', 'Terraform', 'Plan and apply Terraform infrastructure changes', 'terraform-mcp-server', SRC_DEVTOOLS, ['terraform', 'iac', 'devops']),
      npm('devtools/pandoc', 'Pandoc', 'Document format conversion — Markdown, HTML, PDF, DOCX, and more', 'pandoc-mcp-server', SRC_DEVTOOLS, ['pandoc', 'documents', 'conversion'])
    ]
  },

  // ── Data & Databases ──────────────────────────────────────────────────
  {
    name: SRC_DATA,
    url: 'https://github.com/punkpeye/awesome-mcp-servers',
    plugins: [
      npm('data/mysql', 'MySQL', 'Query and manage MySQL databases', 'mysql-mcp-server', SRC_DATA, ['database', 'sql', 'mysql']),
      npm('data/mongodb', 'MongoDB', 'Query, insert, and manage MongoDB collections', 'mcp-mongo-server', SRC_DATA, ['database', 'nosql', 'mongodb']),
      npm('data/redis', 'Redis', 'Interact with Redis key-value stores', 'redis-mcp-server', SRC_DATA, ['redis', 'database', 'cache']),
      npm('data/duckdb', 'DuckDB', 'Analytical queries with DuckDB and schema inspection', 'mcp-server-duckdb', SRC_DATA, ['database', 'analytics', 'duckdb']),
      npm('data/bigquery', 'BigQuery', 'Inspect schemas and execute queries on Google BigQuery', 'bigquery-mcp-server', SRC_DATA, ['database', 'analytics', 'google', 'bigquery']),
      npm('data/supabase', 'Supabase', 'Database, auth, edge functions, and storage via Supabase', 'supabase-mcp-server', SRC_DATA, ['supabase', 'database', 'auth', 'baas']),
      npm('data/pinecone', 'Pinecone', 'Vector search and RAG with Pinecone', 'pinecone-mcp-server', SRC_DATA, ['pinecone', 'vector', 'rag', 'embeddings']),
      npm('data/chromadb', 'ChromaDB', 'Vector database operations with ChromaDB', 'chromadb-mcp-server', SRC_DATA, ['chromadb', 'vector', 'embeddings']),
      npm('data/elasticsearch', 'Elasticsearch', 'Full-text search and analytics with Elasticsearch', 'elasticsearch-mcp-server', SRC_DATA, ['elasticsearch', 'search', 'analytics']),
      npm('data/snowflake', 'Snowflake', 'Query and explore Snowflake data warehouse', 'snowflake-mcp-server', SRC_DATA, ['snowflake', 'database', 'warehouse']),
      npm('data/clickhouse', 'ClickHouse', 'Analytical queries with ClickHouse OLAP database', 'clickhouse-mcp-server', SRC_DATA, ['clickhouse', 'database', 'analytics']),
      npm('data/tidb', 'TiDB', 'Interact with the TiDB distributed SQL database platform', 'tidb-mcp-server', SRC_DATA, ['tidb', 'database', 'sql']),
      npm('data/neo4j', 'Neo4j', 'Graph database queries and management with Neo4j', 'neo4j-mcp-server', SRC_DATA, ['neo4j', 'graph', 'database']),
      npm('data/dynamodb', 'DynamoDB', 'Read and write items in AWS DynamoDB tables', 'dynamodb-mcp-server', SRC_DATA, ['dynamodb', 'aws', 'database', 'nosql']),
      npm('data/firebase', 'Firebase', 'Firestore, Auth, and Storage via Firebase', 'firebase-mcp-server', SRC_DATA, ['firebase', 'google', 'database', 'baas'])
    ]
  },

  // ── Productivity & Communication ──────────────────────────────────────
  {
    name: SRC_PRODUCTIVITY,
    url: 'https://mcpservers.org',
    plugins: [
      npm('productivity/notion', 'Notion', 'Read and manage Notion pages, databases, and blocks', 'notion-mcp-server', SRC_PRODUCTIVITY, ['notion', 'productivity', 'notes']),
      npm('productivity/linear', 'Linear', 'Manage Linear issues, projects, and teams', 'linear-mcp-server', SRC_PRODUCTIVITY, ['linear', 'project-management', 'issues']),
      npm('productivity/jira', 'Jira', 'Manage Jira issues, sprints, and projects', 'jira-mcp-server', SRC_PRODUCTIVITY, ['jira', 'project-management', 'atlassian']),
      npm('productivity/confluence', 'Confluence', 'Read and manage Confluence pages and spaces', 'confluence-mcp-server', SRC_PRODUCTIVITY, ['confluence', 'docs', 'atlassian']),
      npm('productivity/todoist', 'Todoist', 'Search, add, and update Todoist tasks, projects, and sections', 'todoist-mcp-server', SRC_PRODUCTIVITY, ['todoist', 'tasks', 'productivity']),
      npm('productivity/asana', 'Asana', 'Manage Asana tasks, projects, and workspaces', 'asana-mcp-server', SRC_PRODUCTIVITY, ['asana', 'project-management', 'tasks']),
      npm('productivity/trello', 'Trello', 'Manage Trello boards, lists, and cards', 'trello-mcp-server', SRC_PRODUCTIVITY, ['trello', 'boards', 'project-management']),
      npm('productivity/obsidian', 'Obsidian', 'File operations, search, and metadata in Obsidian vaults', 'obsidian-mcp-server', SRC_PRODUCTIVITY, ['obsidian', 'notes', 'knowledge']),
      npm('productivity/discord', 'Discord', 'Send messages, manage channels, and access Discord servers', 'discord-mcp-server', SRC_PRODUCTIVITY, ['discord', 'messaging', 'communication']),
      npm('productivity/telegram', 'Telegram', 'Telegram API integration for messages and dialogs', 'telegram-mcp-server', SRC_PRODUCTIVITY, ['telegram', 'messaging', 'communication']),
      npm('productivity/email', 'Email', 'Unified email across Gmail, Outlook, iCloud, and IMAP/SMTP', 'email-mcp-server', SRC_PRODUCTIVITY, ['email', 'gmail', 'outlook', 'communication']),
      npm('productivity/google-calendar', 'Google Calendar', 'Create, read, update, and delete Google Calendar events', 'google-calendar-mcp-server', SRC_PRODUCTIVITY, ['google', 'calendar', 'scheduling']),
      npm('productivity/google-sheets', 'Google Sheets', 'Read, write, and manage Google Sheets spreadsheets', 'google-sheets-mcp-server', SRC_PRODUCTIVITY, ['google', 'sheets', 'spreadsheets']),
      npm('productivity/airtable', 'Airtable', 'Read and manage Airtable bases, tables, and records', 'airtable-mcp-server', SRC_PRODUCTIVITY, ['airtable', 'database', 'spreadsheets']),
      npm('productivity/microsoft-teams', 'Microsoft Teams', 'Send messages and manage Teams channels and chats', 'teams-mcp-server', SRC_PRODUCTIVITY, ['teams', 'microsoft', 'communication']),
      npm('productivity/zoom', 'Zoom', 'Manage Zoom meetings, recordings, and participants', 'zoom-mcp-server', SRC_PRODUCTIVITY, ['zoom', 'meetings', 'video']),
      npm('productivity/taskade', 'Taskade', 'Tasks, projects, workflows, and AI agents in real-time', 'taskade-mcp-server', SRC_PRODUCTIVITY, ['taskade', 'tasks', 'workflows']),
      npm('productivity/xero', 'Xero', 'Interact with accounting data using the Xero API', 'xero-mcp-server', SRC_PRODUCTIVITY, ['xero', 'accounting', 'finance'])
    ]
  },

  // ── Cloud & Infrastructure ────────────────────────────────────────────
  {
    name: SRC_CLOUD,
    url: 'https://github.com/punkpeye/awesome-mcp-servers',
    plugins: [
      npm('cloud/aws', 'AWS', 'Interact with AWS services — S3, Lambda, EC2, and more', 'aws-mcp-server', SRC_CLOUD, ['aws', 'cloud', 'infrastructure']),
      npm('cloud/gcp', 'Google Cloud', 'Manage GCP resources — Compute, Storage, BigQuery, and more', 'gcp-mcp-server', SRC_CLOUD, ['gcp', 'google', 'cloud']),
      npm('cloud/azure', 'Azure', 'Manage Azure resources and services', 'azure-mcp-server', SRC_CLOUD, ['azure', 'microsoft', 'cloud']),
      npm('cloud/cloudflare', 'Cloudflare', 'Manage Cloudflare Workers, DNS, and security settings', 'cloudflare-mcp-server', SRC_CLOUD, ['cloudflare', 'cdn', 'dns']),
      npm('cloud/vercel', 'Vercel', 'Manage Vercel deployments, domains, and environment variables', 'vercel-mcp-server', SRC_CLOUD, ['vercel', 'deployment', 'hosting']),
      npm('cloud/netlify', 'Netlify', 'Manage Netlify sites, deploys, and functions', 'netlify-mcp-server', SRC_CLOUD, ['netlify', 'deployment', 'hosting']),
      npm('cloud/digitalocean', 'DigitalOcean', 'Manage droplets, databases, and Kubernetes on DigitalOcean', 'digitalocean-mcp-server', SRC_CLOUD, ['digitalocean', 'cloud', 'hosting']),
      npm('cloud/fly-io', 'Fly.io', 'Deploy and manage applications on Fly.io', 'fly-mcp-server', SRC_CLOUD, ['fly', 'deployment', 'hosting']),
      npm('cloud/railway', 'Railway', 'Manage Railway projects, deployments, and services', 'railway-mcp-server', SRC_CLOUD, ['railway', 'deployment', 'hosting']),
      npm('cloud/heroku', 'Heroku', 'Manage Heroku apps, dynos, and add-ons', 'heroku-mcp-server', SRC_CLOUD, ['heroku', 'deployment', 'hosting'])
    ]
  },

  // ── Web, Browser & Search ─────────────────────────────────────────────
  {
    name: SRC_WEB,
    url: 'https://mcpservers.org',
    plugins: [
      npm('web/browserbase', 'Browserbase', 'Control cloud browsers for web interaction and data extraction', 'browserbase-mcp-server', SRC_WEB, ['browser', 'cloud', 'scraping']),
      npm('web/firecrawl', 'Firecrawl', 'Web scraping and crawling with structured data extraction', 'firecrawl-mcp-server', SRC_WEB, ['scraping', 'crawling', 'web']),
      npm('web/tavily', 'Tavily Search', 'AI-optimized web search with Tavily', 'tavily-mcp-server', SRC_WEB, ['search', 'web', 'ai']),
      npm('web/serper', 'Serper', 'Google search results via the Serper API', 'serper-mcp-server', SRC_WEB, ['search', 'google', 'web']),
      npm('web/exa', 'Exa Search', 'Semantic search powered by Exa neural search engine', 'exa-mcp-server', SRC_WEB, ['search', 'semantic', 'web']),
      npm('web/archive', 'Wayback Machine', 'Access historical snapshots from the Internet Archive', 'wayback-mcp-server', SRC_WEB, ['archive', 'web', 'history']),
      npm('web/youtube', 'YouTube', 'Extract video info, transcripts, and manage YouTube content', 'youtube-mcp-server', SRC_WEB, ['youtube', 'video', 'media']),
      npm('web/twitter', 'X / Twitter', 'Post tweets, search, and interact with the X/Twitter API', 'twitter-mcp-server', SRC_WEB, ['twitter', 'x', 'social-media']),
      npm('web/reddit', 'Reddit', 'Browse subreddits, posts, and comments on Reddit', 'reddit-mcp-server', SRC_WEB, ['reddit', 'social-media', 'forum']),
      npm('web/hackernews', 'Hacker News', 'Browse and search Hacker News stories and comments', 'hackernews-mcp-server', SRC_WEB, ['hackernews', 'news', 'tech']),
      npm('web/spotify', 'Spotify', 'Control Spotify playback and browse music catalog', 'spotify-mcp-server', SRC_WEB, ['spotify', 'music', 'media']),
      npm('web/rss', 'RSS', 'Fetch and parse RSS/Atom feeds from any source', 'rss-mcp-server', SRC_WEB, ['rss', 'feeds', 'news'])
    ]
  },

  // ── AI & ML ───────────────────────────────────────────────────────────
  {
    name: SRC_AI,
    url: 'https://github.com/punkpeye/awesome-mcp-servers',
    plugins: [
      npm('ai/openai', 'OpenAI', 'Access GPT models, DALL-E, and Whisper via OpenAI API', 'openai-mcp-server', SRC_AI, ['openai', 'gpt', 'ai']),
      npm('ai/huggingface', 'Hugging Face', 'Run inference and browse models on Hugging Face', 'huggingface-mcp-server', SRC_AI, ['huggingface', 'models', 'inference']),
      npm('ai/replicate', 'Replicate', 'Run ML models on Replicate with simple API calls', 'replicate-mcp-server', SRC_AI, ['replicate', 'models', 'inference']),
      npm('ai/stability', 'Stability AI', 'Generate images with Stable Diffusion models', 'stability-mcp-server', SRC_AI, ['stability', 'image', 'generation']),
      npm('ai/langchain', 'LangChain', 'Build LLM-powered chains and agents via LangChain', 'langchain-mcp-server', SRC_AI, ['langchain', 'chains', 'agents']),
      npm('ai/context7', 'Context7', 'Up-to-date, version-specific library documentation in your session', 'context7-mcp-server', SRC_AI, ['docs', 'libraries', 'context']),
      npm('ai/deepseek', 'DeepSeek', 'Chat, reasoning, and function calling with DeepSeek AI', 'deepseek-mcp-server', SRC_AI, ['deepseek', 'reasoning', 'ai']),
      npm('ai/arize-phoenix', 'Arize Phoenix', 'LLM observability — inspect traces, manage prompts, run experiments', 'arize-phoenix-mcp-server', SRC_AI, ['observability', 'tracing', 'llm']),
      npm('ai/zenml', 'ZenML', 'Interact with MLOps and LLMOps pipelines via ZenML', 'zenml-mcp-server', SRC_AI, ['zenml', 'mlops', 'pipelines'])
    ]
  },

  // ── Payments, Commerce & SaaS ─────────────────────────────────────────
  {
    name: 'Payments & SaaS',
    url: 'https://www.pulsemcp.com/servers',
    plugins: [
      npm('saas/stripe', 'Stripe', 'Manage Stripe payments, customers, and subscriptions', 'stripe-mcp-server', 'Payments & SaaS', ['stripe', 'payments', 'billing']),
      npm('saas/twilio', 'Twilio', 'Send SMS, make calls, and manage Twilio resources', 'twilio-mcp-server', 'Payments & SaaS', ['twilio', 'sms', 'communication']),
      npm('saas/shopify', 'Shopify', 'Manage Shopify stores, products, orders, and inventory', 'shopify-mcp-server', 'Payments & SaaS', ['shopify', 'ecommerce', 'store']),
      npm('saas/sendgrid', 'SendGrid', 'Send transactional emails and manage templates via SendGrid', 'sendgrid-mcp-server', 'Payments & SaaS', ['sendgrid', 'email', 'marketing']),
      npm('saas/intercom', 'Intercom', 'Manage Intercom conversations, users, and help articles', 'intercom-mcp-server', 'Payments & SaaS', ['intercom', 'support', 'crm']),
      npm('saas/salesforce', 'Salesforce', 'Query and manage Salesforce objects, reports, and workflows', 'salesforce-mcp-server', 'Payments & SaaS', ['salesforce', 'crm', 'sales']),
      npm('saas/hubspot', 'HubSpot', 'Manage HubSpot contacts, deals, tickets, and marketing', 'hubspot-mcp-server', 'Payments & SaaS', ['hubspot', 'crm', 'marketing']),
      npm('saas/zapier', 'Zapier', 'Connect to 8,000+ apps instantly via Zapier automations', 'zapier-mcp-server', 'Payments & SaaS', ['zapier', 'automation', 'integration']),
      npm('saas/datadog', 'Datadog', 'Query metrics, logs, and traces from Datadog', 'datadog-mcp-server', 'Payments & SaaS', ['datadog', 'monitoring', 'observability']),
      npm('saas/pagerduty', 'PagerDuty', 'Manage incidents, schedules, and on-call rotations', 'pagerduty-mcp-server', 'Payments & SaaS', ['pagerduty', 'incidents', 'on-call']),
      npm('saas/figma', 'Figma', 'Access layout data, components, and design tokens from Figma', 'figma-mcp-server', 'Payments & SaaS', ['figma', 'design', 'ui'])
    ]
  }
]

/** Returns all registered marketplaces. */
export function getMarketplaces(): Marketplace[] {
  return MARKETPLACES
}

/** Returns all plugins across all marketplaces. */
export function getAllPlugins(): PluginEntry[] {
  return MARKETPLACES.flatMap((m) => m.plugins)
}

/** Search plugins by name, description, or tags. Case-insensitive. */
export function searchPlugins(query: string): PluginEntry[] {
  const q = query.toLowerCase()
  return getAllPlugins().filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      p.tags.some((t) => t.includes(q))
  )
}

/** Find a single plugin by exact id match. */
export function findPlugin(id: string): PluginEntry | undefined {
  return getAllPlugins().find((p) => p.id === id || p.name.toLowerCase() === id.toLowerCase())
}
