import { createRuntimeApp } from './bootstrap.js';

const { app, config } = createRuntimeApp();

app.listen(config.port, () => {
  console.log(`ChatManager API listening on port ${config.port}`);
});
