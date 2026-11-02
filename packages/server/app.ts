// Vercel's Express detector requires a direct framework import in the entrypoint.
import 'express';
import { createNayaroServer } from './src/server';
import { loadEnvironment, serverOptionsFromEnvironment } from './scripts/env';

loadEnvironment();

// Migrate once before deployment rather than racing schema changes across
// concurrently starting instances.
const handle = await createNayaroServer({
  ...serverOptionsFromEnvironment(),
  apiBasePath: '/api',
  applyMigrations: false,
});

// Vercel intercepts this listener (including during vercel dev) and owns its port.
handle.httpServer.listen(handle.config.port, handle.config.host);

// Export the HTTP server so Vercel can also dispatch WebSocket upgrades.
export default handle.httpServer;
