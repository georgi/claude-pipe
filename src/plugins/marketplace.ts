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

/**
 * Built-in catalog of popular Claude/MCP plugins from well-known sources.
 * These are curated from the official Anthropic MCP servers repo,
 * community registries, and popular open-source projects.
 */
const MARKETPLACES: Marketplace[] = [
  {
    name: 'Anthropic Official',
    url: 'https://github.com/anthropics/mcp-servers',
    plugins: [
      {
        id: 'anthropic/filesystem',
        name: 'Filesystem',
        description: 'Read, write, and manage files on the local filesystem',
        install: { type: 'npx', command: '@anthropic-ai/mcp-server-filesystem' },
        source: 'Anthropic Official',
        tags: ['files', 'io', 'core']
      },
      {
        id: 'anthropic/github',
        name: 'GitHub',
        description: 'Interact with GitHub repos, issues, PRs, and more',
        install: { type: 'npx', command: '@anthropic-ai/mcp-server-github' },
        source: 'Anthropic Official',
        tags: ['github', 'git', 'devtools']
      },
      {
        id: 'anthropic/git',
        name: 'Git',
        description: 'Git operations — clone, commit, diff, log, and branch management',
        install: { type: 'npx', command: '@anthropic-ai/mcp-server-git' },
        source: 'Anthropic Official',
        tags: ['git', 'vcs', 'devtools']
      },
      {
        id: 'anthropic/postgres',
        name: 'PostgreSQL',
        description: 'Query and manage PostgreSQL databases',
        install: { type: 'npx', command: '@anthropic-ai/mcp-server-postgres' },
        source: 'Anthropic Official',
        tags: ['database', 'sql', 'postgres']
      },
      {
        id: 'anthropic/sqlite',
        name: 'SQLite',
        description: 'Query and manage SQLite databases',
        install: { type: 'npx', command: '@anthropic-ai/mcp-server-sqlite' },
        source: 'Anthropic Official',
        tags: ['database', 'sql', 'sqlite']
      },
      {
        id: 'anthropic/memory',
        name: 'Memory',
        description: 'Persistent memory using a knowledge graph',
        install: { type: 'npx', command: '@anthropic-ai/mcp-server-memory' },
        source: 'Anthropic Official',
        tags: ['memory', 'knowledge', 'core']
      },
      {
        id: 'anthropic/puppeteer',
        name: 'Puppeteer',
        description: 'Browser automation and web scraping via Puppeteer',
        install: { type: 'npx', command: '@anthropic-ai/mcp-server-puppeteer' },
        source: 'Anthropic Official',
        tags: ['browser', 'web', 'scraping']
      },
      {
        id: 'anthropic/brave-search',
        name: 'Brave Search',
        description: 'Web search powered by the Brave Search API',
        install: { type: 'npx', command: '@anthropic-ai/mcp-server-brave-search' },
        source: 'Anthropic Official',
        tags: ['search', 'web']
      },
      {
        id: 'anthropic/google-maps',
        name: 'Google Maps',
        description: 'Location search, directions, and place details via Google Maps',
        install: { type: 'npx', command: '@anthropic-ai/mcp-server-google-maps' },
        source: 'Anthropic Official',
        tags: ['maps', 'location', 'google']
      },
      {
        id: 'anthropic/fetch',
        name: 'Fetch',
        description: 'Fetch and process content from URLs',
        install: { type: 'npx', command: '@anthropic-ai/mcp-server-fetch' },
        source: 'Anthropic Official',
        tags: ['http', 'web', 'fetch']
      }
    ]
  },
  {
    name: 'Community Popular',
    url: 'https://github.com/punkpeye/awesome-mcp-servers',
    plugins: [
      {
        id: 'community/slack',
        name: 'Slack',
        description: 'Send messages, manage channels, and search Slack workspaces',
        install: { type: 'npm', package: '@anthropic-ai/mcp-server-slack' },
        source: 'Community Popular',
        tags: ['slack', 'messaging', 'communication']
      },
      {
        id: 'community/notion',
        name: 'Notion',
        description: 'Read and manage Notion pages, databases, and blocks',
        install: { type: 'npm', package: 'notion-mcp-server' },
        source: 'Community Popular',
        tags: ['notion', 'productivity', 'notes']
      },
      {
        id: 'community/linear',
        name: 'Linear',
        description: 'Manage Linear issues, projects, and teams',
        install: { type: 'npm', package: 'linear-mcp-server' },
        source: 'Community Popular',
        tags: ['linear', 'project-management', 'issues']
      },
      {
        id: 'community/docker',
        name: 'Docker',
        description: 'Manage Docker containers, images, and compose stacks',
        install: { type: 'npm', package: 'docker-mcp-server' },
        source: 'Community Popular',
        tags: ['docker', 'containers', 'devops']
      },
      {
        id: 'community/kubernetes',
        name: 'Kubernetes',
        description: 'Manage Kubernetes clusters, pods, and deployments',
        install: { type: 'npm', package: 'kubernetes-mcp-server' },
        source: 'Community Popular',
        tags: ['kubernetes', 'k8s', 'devops']
      },
      {
        id: 'community/redis',
        name: 'Redis',
        description: 'Interact with Redis key-value stores',
        install: { type: 'npm', package: 'redis-mcp-server' },
        source: 'Community Popular',
        tags: ['redis', 'database', 'cache']
      },
      {
        id: 'community/sentry',
        name: 'Sentry',
        description: 'Query Sentry for errors, issues, and performance data',
        install: { type: 'npm', package: 'sentry-mcp-server' },
        source: 'Community Popular',
        tags: ['sentry', 'monitoring', 'errors']
      },
      {
        id: 'community/aws',
        name: 'AWS',
        description: 'Interact with AWS services — S3, Lambda, EC2, and more',
        install: { type: 'npm', package: 'aws-mcp-server' },
        source: 'Community Popular',
        tags: ['aws', 'cloud', 'infrastructure']
      }
    ]
  },
  {
    name: 'MCP Hub',
    url: 'https://github.com/nicholashibberd/mcp-hub',
    plugins: [
      {
        id: 'mcphub/openapi',
        name: 'OpenAPI',
        description: 'Generate MCP tools from any OpenAPI/Swagger spec',
        install: { type: 'npm', package: 'openapi-mcp-server' },
        source: 'MCP Hub',
        tags: ['openapi', 'api', 'swagger']
      },
      {
        id: 'mcphub/graphql',
        name: 'GraphQL',
        description: 'Query any GraphQL endpoint with introspection support',
        install: { type: 'npm', package: 'graphql-mcp-server' },
        source: 'MCP Hub',
        tags: ['graphql', 'api']
      },
      {
        id: 'mcphub/stripe',
        name: 'Stripe',
        description: 'Manage Stripe payments, customers, and subscriptions',
        install: { type: 'npm', package: 'stripe-mcp-server' },
        source: 'MCP Hub',
        tags: ['stripe', 'payments', 'billing']
      },
      {
        id: 'mcphub/twilio',
        name: 'Twilio',
        description: 'Send SMS, make calls, and manage Twilio resources',
        install: { type: 'npm', package: 'twilio-mcp-server' },
        source: 'MCP Hub',
        tags: ['twilio', 'sms', 'communication']
      },
      {
        id: 'mcphub/jira',
        name: 'Jira',
        description: 'Manage Jira issues, sprints, and projects',
        install: { type: 'npm', package: 'jira-mcp-server' },
        source: 'MCP Hub',
        tags: ['jira', 'project-management', 'atlassian']
      },
      {
        id: 'mcphub/confluence',
        name: 'Confluence',
        description: 'Read and manage Confluence pages and spaces',
        install: { type: 'npm', package: 'confluence-mcp-server' },
        source: 'MCP Hub',
        tags: ['confluence', 'docs', 'atlassian']
      }
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
