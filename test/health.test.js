import assert from 'node:assert/strict';
import test from 'node:test';
import app, { app as namedApp, createApp } from '../src/app.js';

async function withServer(serverApp, callback) {
  const server = serverApp.listen(0);

  try {
    await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

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

test('GET /health/ready keeps the API unavailable for webhooks without a database', async () => {
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health/ready`);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: 'not_ready',
      database: 'not_configured',
    });
  });
});

test('GET /health/ready confirms database connectivity without exposing connection details', async () => {
  const appWithDatabase = createApp({
    database: { ping: async () => undefined },
  });

  await withServer(appWithDatabase, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health/ready`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ready',
      database: 'connected',
    });
  });
});

test('GET /health/ready hides a database failure behind a stable response', async () => {
  const appWithUnavailableDatabase = createApp({
    database: { ping: async () => { throw new Error('connection string leaked'); } },
  });

  await withServer(appWithUnavailableDatabase, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health/ready`);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: 'not_ready',
      database: 'unavailable',
    });
  });
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
