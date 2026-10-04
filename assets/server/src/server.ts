import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { openBrowser } from './auth.js';
import type { Config } from './config.js';
import { BlackboardClient } from './blackboard-client.js';
import { BlackboardService } from './blackboard-service.js';
import { BlackboardError } from './errors.js';
import { registerTools } from './tools/register.js';

export function createServer(service: BlackboardService): McpServer {
  const server = new McpServer({ name: 'blackboard-course-mcp', version: '1.0.0' });
  registerTools(server, service);
  return server;
}

export async function serve(config: Config): Promise<void> {
  const context = await openBrowser(config);
  const client = new BlackboardClient(context.request, config.baseUrl);
  try {
    try { await client.getMemberships(true); }
    catch (error) {
      if (!(error instanceof BlackboardError) || error.code !== 'AuthenticationRequired') throw error;
      console.error('AuthenticationRequired: Run: bb-mcp auth login');
    }
    const server = createServer(new BlackboardService(client));
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await server.close();
      await context.close();
    };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
    server.server.onclose = () => { void close(); };
    await server.connect(new StdioServerTransport());
  } catch (error) { await context.close(); throw error; }
}
