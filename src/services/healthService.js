function getHealth() {
  return { status: 'ok' };
}

async function getReadiness({ database } = {}) {
  if (database === undefined) {
    return { status: 'not_ready', database: 'not_configured' };
  }

  try {
    await database.verifySchema();
    return { status: 'ready', database: 'schema_ready' };
  } catch {
    return { status: 'not_ready', database: 'unavailable' };
  }
}

export { getHealth, getReadiness };
