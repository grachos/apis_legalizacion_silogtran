import 'dotenv/config';
import { app } from './src/app.js';

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log(`[api] listening on :${port}`));
