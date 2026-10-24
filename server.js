import 'dotenv/config';
import { app } from './src/app.js';

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => console.log(`[api] listening on :${port}`));
// Long year sweeps: disable Node's default 5-min request timeout.
server.requestTimeout = 0;
server.headersTimeout = 120_000;
server.keepAliveTimeout = 65_000;
