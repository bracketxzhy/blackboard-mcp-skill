#!/usr/bin/env node
console.log = console.error.bind(console);
console.info = console.error.bind(console);

try {
  process.loadEnvFile('.env');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

try {
  const { loadConfig } = await import('../src/config.js');
  const { login, authStatus, doctor } = await import('../src/auth.js');
  const { serve } = await import('../src/server.js');
  const config = loadConfig();
  const args = process.argv.slice(2).join(' ');
  switch (args) {
    case 'auth login': await login(config); break;
    case 'auth status': await authStatus(config); break;
    case 'doctor': await doctor(config); break;
    case 'serve': await serve(config); break;
    default: console.error('Usage: bb-mcp auth login | auth status | doctor | serve'); process.exitCode = 2;
  }
} catch (error) {
  const { normalizeError } = await import('../src/errors.js');
  const failure = normalizeError(error);
  console.error(`${failure.code}: ${failure.message}`);
  process.exitCode = 1;
}
