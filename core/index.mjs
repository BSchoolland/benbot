import { startGateway, client } from './gateway.mjs';
import * as sessions from './sessions.mjs';

sessions.reapOrphans();
setInterval(() => sessions.evictIdle().catch((e) => console.error('evictIdle:', e.message)), 60_000).unref();

let stopping = false;
async function shutdown(sig) {
  if (stopping) return; stopping = true;
  console.log(`${sig}: evicting live agents and exiting`);
  await sessions.evictAll();
  client.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

await startGateway();
