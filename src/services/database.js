import pg from 'pg';
import { flowEventForMessage } from './whatsappFlowEvents.js';

const { Pool } = pg;

// Mirrors the conversations.current_intent check constraint (migration 003).
const CONVERSATION_INTENTS = new Set(['faq', 'triage', 'scheduling', 'human_handoff', 'unknown']);

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

  async function findPersistedMessageIdByInfobipId(infobipMessageId) {
    if (typeof infobipMessageId !== 'string' || infobipMessageId.trim() === '') {
      throw new TypeError('infobipMessageId is required.');
    }

    const result = await resolvedPool.query({
      text: 'select id from messages where infobip_message_id = $1',
      values: [infobipMessageId],
    });
    return result.rows[0]?.id ?? null;
  }

  async function recordFlowEventsWith(executor, message, conversationId) {
    for (const event of flowEventForMessage(message)) {
      await executor.query({
        text: `
          insert into whatsapp_flow_events (
            message_id, conversation_id, event_type, step_key, source, occurred_at
          )
          values ($1, $2, $3, $4, $5, coalesce($6, now()))
          on conflict (message_id, event_type) do nothing
        `,
        values: [
          message.id,
          conversationId,
          event.eventType,
          event.stepKey,
          event.source,
          event.occurredAt,
        ],
      });
    }
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
          and (
            status_updated_at is null or
            ($4 is not null and status_updated_at <= $4)
          )
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
          to_regclass('reporting.daily_whatsapp_flow_metrics') is not null as flow_reporting_view_exists,
          to_regclass('reporting.daily_human_response_metrics') is not null as human_response_reporting_view_exists,
          to_regclass('public.appointment_requests') is not null as appointment_requests_exists,
          to_regclass('public.appointments') is not null as appointments_exists,
          to_regclass('public.appointment_events') is not null as appointment_events_exists,
          to_regclass('reporting.daily_appointment_event_metrics') is not null as appointment_event_reporting_view_exists,
          to_regclass('reporting.appointment_request_status_metrics') is not null as appointment_request_reporting_view_exists,
          to_regclass('reporting.scheduled_appointment_metrics') is not null as scheduled_appointment_reporting_view_exists,
          to_regclass('reporting.appointment_slot_capacity_metrics') is not null as appointment_slot_capacity_reporting_view_exists,
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
      schema?.flow_reporting_view_exists !== true ||
      schema?.human_response_reporting_view_exists !== true ||
      schema?.appointment_requests_exists !== true ||
      schema?.appointments_exists !== true ||
      schema?.appointment_events_exists !== true ||
      schema?.appointment_event_reporting_view_exists !== true ||
      schema?.appointment_request_reporting_view_exists !== true ||
      schema?.scheduled_appointment_reporting_view_exists !== true ||
      schema?.appointment_slot_capacity_reporting_view_exists !== true ||
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
      if (persistedMessage !== null) {
        await recordFlowEventsWith(client, { ...message, ...persistedMessage }, conversation.id);
      }
      await client.query('commit');

      return { contact: persistedContact, conversation, message: persistedMessage };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function persistOutboundMessage({
    infobipMessageId,
    waId,
    body,
    messageType = 'text',
    status = 'accepted',
    createdAt = null,
    conversationIntent = null,
    botStepKey = null,
  }) {
    if (!infobipMessageId) {
      throw new TypeError('infobipMessageId is required.');
    }

    if (conversationIntent !== null && !CONVERSATION_INTENTS.has(conversationIntent)) {
      throw new TypeError('conversationIntent is not a known conversation intent.');
    }

    if (!waId) {
      throw new TypeError('waId is required.');
    }

    if (typeof body !== 'string' || body.trim() === '') {
      throw new TypeError('body is required.');
    }

    const client = await resolvedPool.connect();

    try {
      await client.query('begin');
      const contact = await upsertContactWith(client, {
        waId,
        lastMessageAt: createdAt,
      });
      const conversation = await findOrCreateOpenConversationWith(client, {
        waId,
        lastMessageAt: createdAt,
      });

      if (conversationIntent !== null) {
        await client.query({
          text: 'update conversations set current_intent = $2 where id = $1',
          values: [conversation.id, conversationIntent],
        });
        conversation.current_intent = conversationIntent;
      }

      const message = await insertMessageWith(client, {
        infobipMessageId,
        waId,
        conversationId: conversation.id,
        direction: 'out',
        sentVia: 'api',
        body,
        messageType,
        status,
        createdAt,
      });
      if (message !== null) {
        await recordFlowEventsWith(client, {
          ...message, direction: 'out', sentVia: 'api', messageType, botStepKey,
        }, conversation.id);
      }
      await client.query('commit');

      return { contact, conversation, message };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  // What the FAQ bot needs to decide whether to stay silent for a contact:
  // the type of its own latest message and whether the clinic team replied
  // from the WhatsApp Business App, both within the last `windowHours`.
  async function getFaqBotContext(waId, { windowHours }) {
    if (!waId) {
      throw new TypeError('waId is required.');
    }

    const result = await resolvedPool.query({
      text: `
        select
          (
            select message_type
            from messages
            where wa_id = $1
              and direction = 'out'
              and sent_via = 'api'
              and message_type in ('faq_menu', 'faq_answer', 'faq_handoff')
              and created_at > now() - make_interval(hours => $2)
            order by created_at desc
            limit 1
          ) as last_bot_message_type,
          exists (
            select 1
            from messages
            where wa_id = $1
              and direction = 'out'
              and sent_via = 'business_app'
              and created_at > now() - make_interval(hours => $2)
          ) as team_replied_recently
      `,
      values: [waId, windowHours],
    });
    const row = result.rows[0];

    return {
      lastBotMessageType: row?.last_bot_message_type ?? null,
      teamRepliedRecently: row?.team_replied_recently === true,
    };
  }

  async function listAppointmentProfessionals(serviceCode = null) {
    const { rows } = await resolvedPool.query({
      text: `select s.service_code as "serviceCode", s.name as "serviceName",
          p.professional_code as "professionalCode", p.display_name as "professionalName"
        from appointment_service_professionals sp
        join appointment_services s using (service_code)
        join appointment_professionals p using (professional_code)
        where ($1::text is null or s.service_code = $1)
        order by s.name, p.display_name`,
      values: [serviceCode],
    });
    return rows;
  }

  async function listAvailableAppointmentSlots({ serviceCode, professionalCode, date = null }) {
    const { rows } = await resolvedPool.query({
      text: `select to_char(grid.slot_date, 'YYYY-MM-DD') as date, left(grid.slot_time::text, 5) as time,
          (grid.slot_date + grid.slot_time) at time zone 'America/Bahia' as "startsAt",
          (grid.slot_date + grid.slot_time + make_interval(mins => grid.duration_minutes))
            at time zone 'America/Bahia' as "endsAt"
        from reporting.appointment_slot_capacity_metrics grid
        join appointment_service_professionals sp on sp.service_code = grid.service_code
          and sp.professional_code = $2
        where grid.service_code = $1
          and (grid.professional_code = $2 or grid.professional_code is null)
          and grid.remaining_capacity > 0
          and ((grid.slot_date + grid.slot_time) at time zone 'America/Bahia') > now()
          and grid.slot_date <= (now() at time zone 'America/Bahia')::date + 21
          and ($3::date is null or grid.slot_date = $3)
        order by grid.slot_date, grid.slot_time`,
      values: [serviceCode, professionalCode, date],
    });
    return rows;
  }

  async function createAppointmentRequest({
    contactWaId, sourceMessageId, serviceCode, professionalCode, startsAt, endsAt, occurredAt = null,
  }) {
    if (!contactWaId || !sourceMessageId || !serviceCode || !professionalCode || !startsAt || !endsAt) {
      throw new TypeError('contactWaId, sourceMessageId, serviceCode, professionalCode, startsAt, and endsAt are required.');
    }

    const client = await resolvedPool.connect();
    try {
      await client.query('begin');
      // Repeated selections from different WhatsApp messages must not create
      // two pending requests that the clinic cannot confirm unambiguously.
      await client.query({
        text: 'select pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        values: [contactWaId, 'appointment_request'],
      });
      const existingRequest = await client.query({
        text: `select id, contact_wa_id, status, created_at
          from appointment_requests where source_message_id = $1
            or (contact_wa_id = $2 and service_code = $3 and preferred_professional_code = $4
              and preferred_starts_at = $5 and preferred_ends_at = $6 and status = 'requested')
          order by (source_message_id = $1) desc, created_at
          limit 1`,
        values: [sourceMessageId, contactWaId, serviceCode, professionalCode, startsAt, endsAt],
      });
      if (existingRequest.rows.length > 0) {
        await client.query('commit');
        return existingRequest.rows[0];
      }

      const available = await client.query({
        text: `select 1 from reporting.appointment_slot_capacity_metrics grid
          join appointment_service_professionals sp on sp.service_code = grid.service_code
            and sp.professional_code = $2
          where grid.service_code = $1
            and (grid.professional_code = $2 or grid.professional_code is null)
            and slot_date = ($3::timestamptz at time zone 'America/Bahia')::date
            and slot_time = ($3::timestamptz at time zone 'America/Bahia')::time
            and $4::timestamptz = $3::timestamptz + make_interval(mins => grid.duration_minutes)
            and $3::timestamptz > now()
            and remaining_capacity > 0
          limit 1`,
        values: [serviceCode, professionalCode, startsAt, endsAt],
      });
      if (available.rows.length === 0) {
        await client.query('commit');
        return { unavailable: true };
      }

      const request = await client.query({
        text: `insert into appointment_requests (
            contact_wa_id, source_message_id, service_code, preferred_professional_code,
            preferred_starts_at, preferred_ends_at, created_at
          ) values ($1, $2, $3, $4, $5, $6, coalesce($7, now()))
          on conflict (source_message_id) do nothing
          returning id, contact_wa_id, status, created_at`,
        values: [contactWaId, sourceMessageId, serviceCode, professionalCode, startsAt, endsAt, occurredAt],
      });
      const row = request.rows[0] ?? null;
      if (row !== null) {
        await client.query({
          text: `insert into appointment_events (
              appointment_request_id, source_message_id, event_type, actor_kind,
              resulting_starts_at, resulting_ends_at, occurred_at
            ) values ($1, $2, 'requested', 'patient_structured_whatsapp', $3, $4, coalesce($5, now()))`,
          values: [row.id, sourceMessageId, startsAt, endsAt, occurredAt],
        });
      }
      await client.query('commit');
      return row;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function confirmSinglePendingAppointmentRequest({ contactWaId, sourceMessageId, startsAt, endsAt, occurredAt = null }) {
    if (!contactWaId || !sourceMessageId || !startsAt || !endsAt) {
      throw new TypeError('contactWaId, sourceMessageId, startsAt, and endsAt are required.');
    }
    const client = await resolvedPool.connect();
    try {
      await client.query('begin');
      if (await hasAppointmentSourceEvent(client, sourceMessageId)) {
        await client.query('commit');
        return null;
      }
      const pending = await client.query({
        text: `select id, service_code, preferred_professional_code
          from appointment_requests where contact_wa_id = $1 and status = 'requested'
          order by created_at asc for update`,
        values: [contactWaId],
      });
      if (pending.rows.length !== 1) {
        await client.query('commit');
        return null;
      }
      const requestId = pending.rows[0].id;
      const appointment = await client.query({
        text: `insert into appointments (
            appointment_request_id, contact_wa_id, service_code, professional_code,
            starts_at, ends_at, status
          ) values ($1, $2, $3, $4, $5, $6, 'confirmed')
          returning id, appointment_request_id, service_code, professional_code, starts_at, ends_at, status`,
        values: [requestId, contactWaId, pending.rows[0].service_code, pending.rows[0].preferred_professional_code, startsAt, endsAt],
      });
      const row = appointment.rows[0];
      await client.query({ text: "update appointment_requests set status = 'confirmed' where id = $1", values: [requestId] });
      await client.query({
        text: `insert into appointment_events (
          appointment_request_id, appointment_id, source_message_id, event_type, actor_kind,
          resulting_starts_at, resulting_ends_at, occurred_at
        ) values ($1, $2, $3, 'confirmed', 'clinic_whatsapp_business_account', $4, $5, coalesce($6, now()))`,
        values: [requestId, row.id, sourceMessageId, startsAt, endsAt, occurredAt],
      });
      await client.query('commit');
      return row;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function findConfirmedAppointmentWith(client, { contactWaId, startsAt, endsAt, requireEnded = false }) {
    const result = await client.query({
      text: `select a.id, a.appointment_request_id, a.starts_at, a.ends_at, a.status
        from appointments a
        where a.contact_wa_id = $1 and a.status = 'confirmed'
          and a.starts_at = $2 and a.ends_at = $3
          and a.attendance_status is null
          and ($4 = false or a.ends_at <= now())
        for update`,
      values: [contactWaId, startsAt, endsAt, requireEnded],
    });
    return result.rows.length === 1 ? result.rows[0] : null;
  }

  async function hasAppointmentSourceEvent(client, sourceMessageId) {
    const result = await client.query({
      text: 'select 1 from appointment_events where source_message_id = $1',
      values: [sourceMessageId],
    });
    return result.rows.length > 0;
  }

  async function cancelConfirmedAppointment({ contactWaId, sourceMessageId, startsAt, endsAt, occurredAt = null }) {
    if (!contactWaId || !sourceMessageId || !startsAt || !endsAt) {
      throw new TypeError('contactWaId, sourceMessageId, startsAt, and endsAt are required.');
    }
    const client = await resolvedPool.connect();
    try {
      await client.query('begin');
      if (await hasAppointmentSourceEvent(client, sourceMessageId)) {
        await client.query('commit');
        return null;
      }
      const appointment = await findConfirmedAppointmentWith(client, { contactWaId, startsAt, endsAt });
      if (appointment === null) {
        await client.query('commit');
        return null;
      }
      await client.query({
        text: "update appointments set status = 'cancelled', updated_at = coalesce($2, now()) where id = $1",
        values: [appointment.id, occurredAt],
      });
      await client.query({
        text: "update appointment_requests set status = 'cancelled' where id = $1",
        values: [appointment.appointment_request_id],
      });
      await client.query({
        text: `insert into appointment_events (
          appointment_request_id, appointment_id, source_message_id, event_type, actor_kind,
          previous_starts_at, previous_ends_at, resulting_starts_at, resulting_ends_at, occurred_at
        ) values ($1, $2, $3, 'cancelled', 'clinic_whatsapp_business_account', $4, $5, null, null, coalesce($6, now()))`,
        values: [appointment.appointment_request_id, appointment.id, sourceMessageId, startsAt, endsAt, occurredAt],
      });
      await client.query('commit');
      return { ...appointment, status: 'cancelled' };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function rescheduleConfirmedAppointment({
    contactWaId, sourceMessageId, previousStartsAt, previousEndsAt,
    resultingStartsAt, resultingEndsAt, occurredAt = null,
  }) {
    if (!contactWaId || !sourceMessageId || !previousStartsAt || !previousEndsAt || !resultingStartsAt || !resultingEndsAt) {
      throw new TypeError('contactWaId, sourceMessageId, and both appointment slots are required.');
    }
    const client = await resolvedPool.connect();
    try {
      await client.query('begin');
      if (await hasAppointmentSourceEvent(client, sourceMessageId)) {
        await client.query('commit');
        return null;
      }
      const appointment = await findConfirmedAppointmentWith(client, {
        contactWaId, startsAt: previousStartsAt, endsAt: previousEndsAt,
      });
      if (appointment === null) {
        await client.query('commit');
        return null;
      }
      const updated = await client.query({
        text: `update appointments set starts_at = $2, ends_at = $3, updated_at = coalesce($4, now())
          where id = $1 returning id, appointment_request_id, starts_at, ends_at, status`,
        values: [appointment.id, resultingStartsAt, resultingEndsAt, occurredAt],
      });
      const row = updated.rows[0];
      await client.query({
        text: `insert into appointment_events (
          appointment_request_id, appointment_id, source_message_id, event_type, actor_kind,
          previous_starts_at, previous_ends_at, resulting_starts_at, resulting_ends_at, occurred_at
        ) values ($1, $2, $3, 'rescheduled', 'clinic_whatsapp_business_account', $4, $5, $6, $7, coalesce($8, now()))`,
        values: [appointment.appointment_request_id, appointment.id, sourceMessageId,
          previousStartsAt, previousEndsAt, resultingStartsAt, resultingEndsAt, occurredAt],
      });
      await client.query('commit');
      return row;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function recordAppointmentAttendance({
    contactWaId, sourceMessageId, startsAt, endsAt, occurredAt = null,
  }) {
    if (!contactWaId || !sourceMessageId || !startsAt || !endsAt) {
      throw new TypeError('contactWaId, sourceMessageId, startsAt, and endsAt are required.');
    }
    const client = await resolvedPool.connect();
    try {
      await client.query('begin');
      if (await hasAppointmentSourceEvent(client, sourceMessageId)) {
        await client.query('commit');
        return null;
      }
      const appointment = await findConfirmedAppointmentWith(client, { contactWaId, startsAt, endsAt, requireEnded: true });
      if (appointment === null) {
        await client.query('commit');
        return null;
      }
      const updated = await client.query({
        text: "update appointments set attendance_status = 'attended', updated_at = coalesce($2, now()) where id = $1 returning id, appointment_request_id, starts_at, ends_at, status, attendance_status",
        values: [appointment.id, occurredAt],
      });
      await client.query({
        text: `insert into appointment_events (
          appointment_request_id, appointment_id, source_message_id, event_type, actor_kind,
          previous_starts_at, previous_ends_at, resulting_starts_at, resulting_ends_at, attendance_status, occurred_at
        ) values ($1, $2, $3, 'attendance_recorded', 'clinic_whatsapp_business_account', $4, $5, $4, $5, $6, coalesce($7, now()))`,
        values: [appointment.appointment_request_id, appointment.id, sourceMessageId,
          startsAt, endsAt, 'attended', occurredAt],
      });
      await client.query('commit');
      return updated.rows[0];
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    cancelConfirmedAppointment,
    confirmSinglePendingAppointmentRequest,
    createAppointmentRequest,
    findPersistedMessageIdByInfobipId,
    getFaqBotContext,
    insertMessage,
    listAppointmentProfessionals,
    listAvailableAppointmentSlots,
    persistOutboundMessage,
    persistWebhookMessage,
    ping,
    // Usado pelo bot (src/services/bot/index.js) para os repositórios dele.
    pool: resolvedPool,
    recordAppointmentAttendance,
    recordDeliveryStatus,
    rescheduleConfirmedAppointment,
    upsertContact,
    verifySchema,
  };
}

export { createDatabase };
