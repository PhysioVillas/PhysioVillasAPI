function getHealth() {
  return { status: 'ok' };
}

async function getReadiness({ database } = {}) {
  if (database === undefined) {
    return { status: 'not_ready', database: 'not_configured' };
  }

  try {
    await database.ping();
    return { status: 'ready', database: 'connected' };
  } catch {
    return { status: 'not_ready', database: 'unavailable' };
  }
}

export { getHealth, getReadiness };
