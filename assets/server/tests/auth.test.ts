import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { response } from './helpers.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const browser = vi.hoisted(() => ({ launchPersistentContext: vi.fn(), get: vi.fn(), goto: vi.fn(), close: vi.fn(), evaluate: vi.fn(async () => 'Fixture Edge UA'), isClosed: vi.fn(() => false) }));
vi.mock('playwright', () => ({ chromium: { launchPersistentContext: browser.launchPersistentContext } }));

import { authStatus, login, openBrowser } from '../src/auth.js';

const config = loadConfig({ LOCALAPPDATA: process.cwd() + '/work/test-appdata' });

beforeEach(async () => {
  vi.clearAllMocks();
  await mkdir(config.profileDir, { recursive: true });
  await writeFile(join(config.profileDir, 'mcp-session.json'), JSON.stringify({ userAgent: 'Fixture Edge UA' }));
  browser.launchPersistentContext.mockResolvedValue({ request: { get: browser.get }, pages: () => [{ goto: browser.goto, isClosed: browser.isClosed, evaluate: browser.evaluate }], close: browser.close });
  browser.get.mockResolvedValue(response({ results: [] }));
});

describe('Dedicated Playwright session', () => {
  it('rejects Linux and macOS daily profiles while permitting adjacent dedicated paths', () => {
    expect(() => loadConfig({ BLACKBOARD_PROFILE_DIR: join(homedir(), '.config', 'microsoft-edge', 'Default') })).toThrow();
    expect(() => loadConfig({ BLACKBOARD_PROFILE_DIR: join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default') })).toThrow();
    expect(() => loadConfig({ XDG_CONFIG_HOME: '/dedicated/config', BLACKBOARD_PROFILE_DIR: '/dedicated/config/microsoft-edge/Profile 1' })).toThrow();
    expect(loadConfig({ XDG_CONFIG_HOME: '/dedicated/config', BLACKBOARD_PROFILE_DIR: '/dedicated/config/microsoft-edge-mcp' }).profileDir).toContain('microsoft-edge-mcp');
  });
  it('verifies login after reopening with the same UA and blank restored pages', async () => {
    await login(config);
    expect(browser.launchPersistentContext).toHaveBeenCalledWith(config.profileDir, expect.objectContaining({ channel: 'msedge', headless: false, args: ['--restore-last-session'] }));
    expect(browser.goto).toHaveBeenCalledWith('https://pibb.scu.edu.cn', expect.anything());
    expect(browser.get).toHaveBeenCalledWith('https://pibb.scu.edu.cn/learn/api/public/v1/users/me/courses', expect.objectContaining({ maxRedirects: 10 }));
    expect(browser.goto).toHaveBeenLastCalledWith('about:blank', { waitUntil: 'load' });
    expect(browser.launchPersistentContext).toHaveBeenLastCalledWith(config.profileDir, expect.objectContaining({ headless: true, userAgent: 'Fixture Edge UA' }));
    expect(browser.close).toHaveBeenCalledTimes(2);
  });
  it('status returns AuthenticationRequired on 401 and always closes the profile', async () => {
    browser.get.mockResolvedValue(response({}, 401));
    await expect(authStatus(config)).rejects.toMatchObject({ code: 'AuthenticationRequired', message: 'Run: bb-mcp auth login' });
    expect(browser.launchPersistentContext).toHaveBeenCalledWith(config.profileDir, expect.objectContaining({ headless: true }));
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
  it('reports browser errors without leaking launch details', async () => {
    browser.launchPersistentContext.mockRejectedValue(new Error('SECRET COOKIE'));
    await expect(openBrowser(config)).rejects.toMatchObject({ code: 'BrowserUnavailable' });
  });
  it('does not report successful login if the restarted session returns 401', async () => {
    browser.get.mockResolvedValueOnce(response({ results: [] })).mockResolvedValueOnce(response({}, 401));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(login(config)).rejects.toMatchObject({ code: 'AuthenticationRequired' });
      expect(log.mock.calls.flat().join(' ')).not.toContain('Blackboard authentication successful.');
    } finally { log.mockRestore(); }
  });
  it('rejects missing or malformed session metadata without attempting authentication', async () => {
    const missing = { ...config, profileDir: process.cwd() + '/work/metadata-not-present' };
    await expect(openBrowser(missing)).rejects.toMatchObject({ code: 'AuthenticationRequired' });
    await writeFile(join(config.profileDir, 'mcp-session.json'), JSON.stringify({ userAgent: 'bad\r\nheader' }));
    await expect(openBrowser(config)).rejects.toMatchObject({ code: 'AuthenticationRequired' });
    expect(browser.launchPersistentContext).not.toHaveBeenCalled();
  });
  it('rejects daily profiles and unsafe base URL configuration', () => {
    expect(() => loadConfig({ LOCALAPPDATA: 'C:/appdata', BLACKBOARD_PROFILE_DIR: 'C:/appdata/Microsoft/Edge/User Data/Default' })).toThrow('daily browser');
    for (const BLACKBOARD_BASE_URL of ['http://pibb.scu.edu.cn', 'https://user:secret@pibb.scu.edu.cn', 'https://pibb.scu.edu.cn/arbitrary']) expect(() => loadConfig({ BLACKBOARD_BASE_URL })).toThrow();
    expect(() => loadConfig({ BLACKBOARD_TIMEZONE: 'UTC' })).toThrow();
  });
});
