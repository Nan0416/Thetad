/**
 * thetad CLI — a pure client of the daemon's HTTP API. It never touches
 * state files: one writer (the daemon), many readers.
 *
 * Usage: npm run cli --workspace @thetad/cli -- <status|health> [--port 7777]
 */
export {};

const args = process.argv.slice(2);
const command = args[0] ?? 'status';
const portFlag = args.indexOf('--port');
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.THETAD_PORT ?? 7777);

const routes: Record<string, string> = {
  health: '/api/health',
  status: '/api/status',
};

const route = routes[command];
if (!route) {
  console.error(`unknown command: ${command}\nusage: thetad <${Object.keys(routes).join('|')}>`);
  process.exit(2);
}

try {
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  console.log(JSON.stringify(await response.json(), null, 2));
} catch {
  console.error(`cannot reach thetad daemon on port ${port} — is it running? (npm start)`);
  process.exit(1);
}
