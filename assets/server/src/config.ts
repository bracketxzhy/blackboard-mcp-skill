import { join, resolve, relative, sep, isAbsolute } from 'node:path';
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
  const configHome = env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  const dailyProfiles = [
    join(appData, 'Microsoft', 'Edge', 'User Data'), join(appData, 'Google', 'Chrome', 'User Data'),
    join(configHome, 'microsoft-edge'), join(configHome, 'google-chrome'),
    join(homedir(), 'Library', 'Application Support', 'Microsoft Edge'),
    join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  ];
  if (dailyProfiles.some(path => {
    const child = relative(resolve(path), profileDir);
    return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep));
  })) {
    throw new Error('BLACKBOARD_PROFILE_DIR must not use your daily browser profile.');
  }
  return { baseUrl: base.origin, profileDir, timezone: 'Asia/Shanghai' };
}
