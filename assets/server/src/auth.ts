import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import { z } from 'zod';
import type { Config } from './config.js';
import { BlackboardClient } from './blackboard-client.js';
import { BlackboardError, authenticationRequired } from './errors.js';

// Only a browser identity string is saved here, never cookies or credentials.
const sessionMetadataSchema = z.strictObject({ userAgent: z.string().min(1).max(1024).refine(value => !/[\r\n]/u.test(value)) });

async function sessionUserAgent(config: Config): Promise<string> {
  try {
    const input: unknown = JSON.parse(await readFile(join(config.profileDir, 'mcp-session.json'), 'utf8'));
    return sessionMetadataSchema.parse(input).userAgent;
  } catch { throw authenticationRequired(); }
}

export async function openBrowser(config: Config, visible = false): Promise<BrowserContext> {
  await mkdir(config.profileDir, { recursive: true });
  const userAgentOptions = visible ? {} : { userAgent: await sessionUserAgent(config) };
  try {
    return await chromium.launchPersistentContext(config.profileDir, { channel: 'msedge', headless: !visible, acceptDownloads: false, args: ['--restore-last-session'], ...userAgentOptions });
  } catch {
    throw new BlackboardError('BrowserUnavailable', 'Cannot open the dedicated Edge profile. Install Microsoft Edge and close other bb-mcp processes using this profile.');
  }
}

export async function login(config: Config): Promise<void> {
  const context = await openBrowser(config, true);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.error('Complete Blackboard login manually in the Edge window. Waiting up to 10 minutes.');
    const client = new BlackboardClient(context.request, config.baseUrl);
    const deadline = Date.now() + 10 * 60000;
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new BlackboardError('AuthenticationRequired', 'Login window was closed before verification. Run: bb-mcp auth login');
      try {
        await client.getMemberships(true);
        const userAgent = await page.evaluate(() => navigator.userAgent);
        const metadata = sessionMetadataSchema.parse({ userAgent });
        await writeFile(join(config.profileDir, 'mcp-session.json'), JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600 });
        // Session restore must not revisit a login/logout page or run old course-page scripts.
        for (const openPage of context.pages()) await openPage.goto('about:blank', { waitUntil: 'load' });
        break;
      } catch (error) {
        if (!(error instanceof BlackboardError) || error.code !== 'AuthenticationRequired') throw error;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 2000));
    }
    if (Date.now() >= deadline) throw new BlackboardError('AuthenticationRequired', 'Login timed out. Run: bb-mcp auth login');
  } finally { await context.close(); }
  console.error('Checking session after closing and reopening Edge...');
  await authStatus(config);
}

export async function authStatus(config: Config): Promise<void> {
  const context = await openBrowser(config);
  try {
    await new BlackboardClient(context.request, config.baseUrl).getMemberships(true);
    console.error('Blackboard authentication successful.');
  } finally { await context.close(); }
}

export async function doctor(config: Config): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error('Node.js 22.13+ is required.');
  console.error(`Node: ${process.versions.node}`);
  const context = await openBrowser(config);
  try {
    console.error('Playwright / Microsoft Edge: OK');
    console.error(`Dedicated profile: ${config.profileDir}`);
    let response;
    try { response = await context.request.get(config.baseUrl, { timeout: 30000, failOnStatusCode: false }); }
    catch { throw new BlackboardError('BlackboardApiError', 'Blackboard origin is unreachable.'); }
    const status = response.status();
    await response.dispose();
    if (status < 200 || status >= 400) throw new BlackboardError('BlackboardApiError', `Blackboard origin returned HTTP ${status}.`);
    console.error('Blackboard reachable: OK');
    await new BlackboardClient(context.request, config.baseUrl).getMemberships(true);
    console.error('Authenticated session: OK\nREST API /users/me/courses: OK');
  } finally { await context.close(); }
}
