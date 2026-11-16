import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = await createApp(config);
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`API JAMYSTOCK démarrée sur http://localhost:${port}`);
