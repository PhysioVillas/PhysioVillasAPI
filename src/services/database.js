import pg from 'pg';

const { Pool } = pg;

function requireConnectionString(connectionString) {
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new TypeError('DATABASE_URL is required.');
  }

  return connectionString.trim();
}

function createDatabase({ connectionString, pool } = {}) {
  const resolvedPool = pool ?? new Pool({
    connectionString: requireConnectionString(connectionString),
  });

  async function upsertContactWith(executor, {
    waId,
    profileName = null,
    lastMessageAt = null,
  }) {
    if (!waId) {
      throw new TypeError('waId is required.');
    }

    const result = await executor.query({
      text: `
        insert into contacts (wa_id, profile_name, last_message_at)
        values ($1, $2, $3)
        on conflict (wa_id) do update
        set
          profile_name = coalesce(excluded.profile_name, contacts.profile_name),
          last_message_at = case
            when excluded.last_message_at is null then contacts.last_message_at
            when contacts.last_message_at is null then excluded.last_message_at
            else greatest(contacts.last_message_at, excluded.last_message_at)
          end
        returning wa_id, profile_name, last_message_at
      `,
      values: [waId, profileName, lastMessageAt],
    });

    return result.rows[0];
  }

  async function upsertContact(contact) {
    return upsertContactWith(resolvedPool, contact);
  }

  async function insertMessageWith(executor, {
    infobipMessageId = null,
    waId = null,
    direction,
    sentVia = null,
    body = null,
    messageType = null,
    status = null,
    errorCode = null,
    createdAt = null,
  }) {
    if (direction !== 'in' && direction !== 'out') {
      throw new TypeError("direction must be 'in' or 'out'.");
    }

    if (sentVia !== null && sentVia !== 'api' && sentVia !== 'business_app') {
      throw new TypeError("sentVia must be 'api', 'business_app', or null.");
    }

    const result = await executor.query({
      text: `
        insert into messages (
          infobip_message_id,
          wa_id,
          direction,
          sent_via,
          body,
          message_type,
          status,
          error_code,
          created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, now()))
        on conflict (infobip_message_id) do nothing
        returning id, infobip_message_id, wa_id, direction, sent_via, body,
          message_type, status, error_code, created_at
      `,
      values: [
        infobipMessageId,
        waId,
        direction,
        sentVia,
        body,
        messageType,
        status,
        errorCode,
        createdAt,
      ],
    });

    return result.rows[0] ?? null;
  }

  async function insertMessage(message) {
    return insertMessageWith(resolvedPool, message);
  }

  async function persistWebhookMessage({ contact, message }) {
    const client = await resolvedPool.connect();

    try {
      await client.query('begin');
      const persistedContact = await upsertContactWith(client, contact);
      const persistedMessage = await insertMessageWith(client, message);
      await client.query('commit');

      return { contact: persistedContact, message: persistedMessage };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  return { insertMessage, persistWebhookMessage, upsertContact };
}

export { createDatabase };
