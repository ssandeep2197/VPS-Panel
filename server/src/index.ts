import http from 'http';
import { createApp } from './app';
import { assertConfig, config } from './config';
import { disconnectKafka } from './services/kafka';
import { startSiteMonitor } from './services/sites';
import { startMetricsSampler } from './services/system';
import { attachWebSocket } from './ws';

assertConfig();

const server = http.createServer(createApp());
const wss = attachWebSocket(server);
startMetricsSampler();
startSiteMonitor();

server.listen(config.port, config.host, () => {
  console.log(`VPS panel listening on http://${config.host}:${config.port}`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn('Listening on a public interface: make sure HTTPS and a firewall are in front of this port.');
  }
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  for (const client of wss.clients) client.terminate();
  server.close(() => {
    void disconnectKafka().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
