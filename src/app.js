import { createApp } from './appFactory.js';
import { createRuntimeApp } from './bootstrap.js';

// Vercel detects this default Express export as the function entrypoint.
// Build it through the same environment-aware bootstrap used by src/index.js.
const { app } = createRuntimeApp();

export { app, createApp };
export default app;
