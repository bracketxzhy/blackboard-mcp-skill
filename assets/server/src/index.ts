// stdout belongs exclusively to MCP. Route dependency console output to stderr too.
console.log = console.error.bind(console);
console.info = console.error.bind(console);

try {
  process.loadEnvFile('.env');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

try {
  const { serve } = await import('./server.js');
  const { loadConfig } = await import('./config.js');
  await serve(loadConfig());
} catch (error) {
  const { normalizeError } = await import('./errors.js');
  const failure = normalizeError(error);
  console.error(`${failure.code}: ${failure.message}`);
  process.exitCode = 1;
}
