import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

export interface Config {
  baseUrl: string;
  profileDir: string;
  timezone: 'Asia/Shanghai';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const base = new URL(z.url().parse(env['BLACKBOARD_BASE_URL'] ?? 'https://pibb.scu.edu.cn'));
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('BLACKBOARD_BASE_URL must be an HTTPS origin without credentials, path or query.');
  }
  z.literal('Asia/Shanghai').parse(env['BLACKBOARD_TIMEZONE'] ?? 'Asia/Shanghai');
  const appData = env['LOCALAPPDATA'] ?? join(homedir(), '.local', 'share');
  const profileDir = resolve(env['BLACKBOARD_PROFILE_DIR'] ?? join(appData, 'blackboard-course-workflow', base.hostname, 'browser-profile'));
  const dailyProfiles = [join(appData, 'Microsoft', 'Edge', 'User Data'), join(appData, 'Google', 'Chrome', 'User Data')];
  if (dailyProfiles.some(path => profileDir.toLowerCase() === resolve(path).toLowerCase() || profileDir.toLowerCase().startsWith(resolve(path).toLowerCase() + '\\'))) {
    throw new Error('BLACKBOARD_PROFILE_DIR must not use your daily browser profile.');
  }
  return { baseUrl: base.origin, profileDir, timezone: 'Asia/Shanghai' };
}
