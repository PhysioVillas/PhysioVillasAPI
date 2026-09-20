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
    conversationId = null,
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
          conversation_id,
          direction,
          sent_via,
          body,
          message_type,
          status,
          error_code,
          created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, now()))
        on conflict (infobip_message_id) do nothing
        returning id, infobip_message_id, wa_id, conversation_id, direction, sent_via, body,
          message_type, status, error_code, created_at
      `,
      values: [
        infobipMessageId,
        waId,
        conversationId,
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

  async function findOrCreateOpenConversationWith(executor, {
    waId,
    lastMessageAt = null,
  }) {
    if (!waId) {
      throw new TypeError('waId is required.');
    }

    const result = await executor.query({
      text: `
        insert into conversations (wa_id, last_message_at)
        values ($1, $2)
        on conflict (wa_id) where status = 'open' and wa_id is not null do update
        set last_message_at = case
          when excluded.last_message_at is null then conversations.last_message_at
          when conversations.last_message_at is null then excluded.last_message_at
          else greatest(conversations.last_message_at, excluded.last_message_at)
        end
        returning id, wa_id, status, last_message_at
      `,
      values: [waId, lastMessageAt],
    });

    return result.rows[0];
  }

  async function recordDeliveryStatus({
    infobipMessageId,
    status,
    errorCode = null,
    statusUpdatedAt = null,
  }) {
    if (!infobipMessageId) {
      throw new TypeError('infobipMessageId is required.');
    }

    if (!status) {
      throw new TypeError('status is required.');
    }

    const result = await resolvedPool.query({
      text: `
        update messages
        set
          status = $2,
          error_code = $3,
          status_updated_at = coalesce($4, now())
        where infobip_message_id = $1
        returning id, infobip_message_id, status, error_code, status_updated_at
      `,
      values: [infobipMessageId, status, errorCode, statusUpdatedAt],
    });

    return result.rows[0] ?? null;
  }

  async function ping() {
    await resolvedPool.query('select 1');
  }

  async function verifySchema() {
    const result = await resolvedPool.query({
      text: `
        select
          to_regclass('public.contacts') is not null as contacts_exists,
          to_regclass('public.messages') is not null as messages_exists,
          to_regclass('public.conversations') is not null as conversations_exists,
          to_regclass('public.conversations_one_open_per_contact_idx') is not null as conversations_index_exists,
          to_regclass('reporting.daily_message_metrics') is not null as reporting_view_exists,
          exists (
            select 1
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'messages'
              and column_name = 'status_updated_at'
          ) as delivery_status_column_exists
      `,
    });
    const schema = result.rows[0];

    if (
      schema?.contacts_exists !== true ||
      schema?.messages_exists !== true ||
      schema?.conversations_exists !== true ||
      schema?.conversations_index_exists !== true ||
      schema?.reporting_view_exists !== true ||
      schema?.delivery_status_column_exists !== true
    ) {
      throw new Error('ChatManager database schema is incomplete.');
    }
  }

  async function persistWebhookMessage({ contact, message }) {
    const client = await resolvedPool.connect();

    try {
      await client.query('begin');
      const persistedContact = await upsertContactWith(client, contact);
      const conversation = await findOrCreateOpenConversationWith(client, {
        waId: contact.waId,
        lastMessageAt: message.createdAt ?? contact.lastMessageAt,
      });
      const persistedMessage = await insertMessageWith(client, {
        ...message,
        conversationId: conversation.id,
      });
      await client.query('commit');

      return { contact: persistedContact, conversation, message: persistedMessage };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    insertMessage,
    persistWebhookMessage,
    ping,
    recordDeliveryStatus,
    upsertContact,
    verifySchema,
  };
}

export { createDatabase };
