import assert from 'node:assert/strict';
import test from 'node:test';
import app, { app as namedApp } from '../src/app.js';

test('Express app has a default export compatible with Vercel', () => {
  assert.equal(app, namedApp);
});

test('GET /health returns the health contract', async (t) => {
  const server = app.listen(0);

  t.after(() => server.close());

  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('unknown routes return a stable JSON error contract', async (t) => {
  const server = app.listen(0);

  t.after(() => server.close());

  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/not-a-route`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found.',
    },
  });
});

test('OpenAPI specification and interactive documentation are available locally', async (t) => {
  const server = app.listen(0);

  t.after(() => server.close());

  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const specification = await fetch(`http://127.0.0.1:${port}/docs.json`);
  const documentation = await fetch(`http://127.0.0.1:${port}/docs`);

  assert.equal(specification.status, 200);
  assert.equal((await specification.json()).openapi, '3.1.0');
  assert.equal(documentation.status, 200);
  assert.match(await documentation.text(), /swagger-ui-bundle\.js/i);
});
