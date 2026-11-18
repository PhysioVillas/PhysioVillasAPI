// Disponibilidade e agendamentos do bot sobre clinica_simulada (POC, T10).
//
// Regras (plan.md 6.3):
// - Vagas livres = f_capacidade.vagas - agendamentos ativos ('Agendado' ou
//   'Realizado') no mesmo servico, profissional, data e hora. Ficam de fora
//   feriados (d_calendario.feriado = 'Sim'), horarios ja passados (no fuso da
//   clinica) e datas alem do horizonte.
// - book/reschedule rodam numa transacao com pg_advisory_xact_lock por
//   (servico, profissional, data, hora) e checam a vaga de novo antes do insert.
// - reschedule/cancel so mexem em agendamento 'Agendado' do proprio paciente
//   (senao 'not_found') e com pelo menos minNoticeHours de antecedencia
//   (senao 'too_late').
//
// Armadilhas do schema tratadas aqui:
// - agendamento_chatbot.conversation_id e NOT NULL + UNIQUE + FK para
//   clinica_simulada.conversations: uma conversa sustenta UM agendamento so.
//   A conversa aberta e reaproveitada apenas se ainda nao tiver linha em
//   agendamento_chatbot; senao e fechada ('closed') e outra e aberta. Ha um
//   indice unico parcial "uma conversa aberta por wa_id".
// - agendamento_chatbot.wa_id e NOT NULL + FK para clinica_simulada.contacts:
//   o contato recebe upsert antes. dispatch_id fica nulo (migration 011).
// - audit_log.entity_id e uuid, mas agendamento_id e bigint. O id e gravado
//   como uuid reversivel: lpad(to_hex(id), 32, '0')::uuid
//   (30387 -> 00000000-0000-0000-0000-0000000076b3). Para voltar:
//   ('x' || right(replace(entity_id::text, '-', ''), 16))::bit(64)::bigint.
// - Colunas de dominio de f_agendamentos sao texto livre com acento: os
//   valores abaixo sao exatamente os observados (db/poc/README.md).

export const APPOINTMENT_STATUS = Object.freeze({
  scheduled: 'Agendado',
  done: 'Realizado',
  cancelledInAdvance: 'Cancelado com antecedência',
});

export const PAYMENT_METHODS = Object.freeze([
  'Convênio',
  'Mensalidade',
  'Pacote particular',
  'Particular avulso',
]);

export const FAILURE_REASONS = Object.freeze(['slot_unavailable', 'too_late', 'not_found']);

const CHANNEL = 'Chatbot';
const ACTOR_SCOPE = 'chatbot';
const AUDIT_ENTITY = 'agendamento';
const DEFAULT_TIMEZONE = 'America/Bahia';
const DEFAULT_MIN_NOTICE_HOURS = 24;
const DEFAULT_HORIZON_DAYS = 21;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const ACTIVE_STATUSES_SQL = `('Agendado', 'Realizado')`;

// Turnos observados: Manha 6-11, Tarde 12-17, Noite 18-19.
export function shiftForHour(hour) {
  if (hour < 12) return 'Manhã';
  if (hour < 18) return 'Tarde';
  return 'Noite';
}

function requireDate(value, name) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a YYYY-MM-DD string.`);
  }
  return value;
}

function requireInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return number;
}

function optionalInt(value, name) {
  return value === undefined || value === null ? null : requireInt(value, name);
}

function requireWaId(waId) {
  if (typeof waId !== 'string' || waId.trim() === '') {
    throw new TypeError('waId is required.');
  }
  return waId;
}

function toNumberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function mapAppointment(row) {
  return {
    id: Number(row.agendamento_id),
    patientId: toNumberOrNull(row.paciente_id),
    serviceId: toNumberOrNull(row.servico_id),
    serviceName: row.servico ?? undefined,
    professionalId: toNumberOrNull(row.profissional_id),
    professionalName: row.profissional ?? undefined,
    date: row.data,
    hour: Number(row.hora),
    startsAt: row.starts_at ?? undefined,
    status: row.status,
    paymentMethod: row.forma_pagamento,
    insuranceId: toNumberOrNull(row.convenio_id),
    sessionValue: toNumberOrNull(row.valor_sessao),
    firstVisit: row.primeira_consulta === undefined ? undefined : row.primeira_consulta === 'Sim',
    rescheduledFrom: toNumberOrNull(row.remarcacao_de),
  };
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function slotLockKey({ serviceId, professionalId, date, hour }) {
  return `clinica_simulada:slot:${serviceId}:${professionalId}:${date}:${hour}`;
}

// ---------------------------------------------------------------------------
// SQL. Cada texto comeca com um marcador /* t10:<nome> */ (inofensivo para o
// Postgres) que identifica a consulta nos testes e nos logs de query lenta.
// ---------------------------------------------------------------------------

const SQL = {
  extendSchedule: `/* t10:extend_schedule */
    select clinica_simulada.extend_schedule($1::int) as inserted`,

  // $1 now, $2 tz, $3 servico, $4 profissional|null, $5 from, $6 horizonDays
  availableDays: `/* t10:available_days */
    with l as (
      select ($1::timestamptz at time zone $2) as local_now,
             ($1::timestamptz at time zone $2)::date as today
    )
    select to_char(c.data, 'YYYY-MM-DD') as data,
           sum(greatest(c.vagas - o.ocupados, 0))::int as livres
    from l
    join clinica_simulada.f_capacidade c
      on c.data between greatest($5::date, l.today) and l.today + $6::int
    join clinica_simulada.d_calendario d
      on d.data = c.data and coalesce(d.feriado, 'Não') <> 'Sim'
    cross join lateral (
      select count(*) as ocupados
      from clinica_simulada.f_agendamentos a
      where a.servico_id = c.servico_id
        and a.profissional_id = c.profissional_id
        and a.data = c.data
        and a.hora = c.hora
        and a.status in ${ACTIVE_STATUSES_SQL}
    ) o
    where c.servico_id = $3
      and ($4::bigint is null or c.profissional_id = $4)
      and c.data + make_interval(hours => c.hora::int) > l.local_now
    group by c.data
    having sum(greatest(c.vagas - o.ocupados, 0)) > 0
    order by c.data`,

  // $1 now, $2 tz, $3 servico, $4 profissional|null, $5 data, $6 horizonDays
  availableTimes: `/* t10:available_times */
    with l as (
      select ($1::timestamptz at time zone $2) as local_now,
             ($1::timestamptz at time zone $2)::date as today
    )
    select c.hora, c.profissional_id, p.profissional,
           (c.vagas - o.ocupados)::int as restantes
    from l
    join clinica_simulada.f_capacidade c
      on c.data = $5::date and c.data between l.today and l.today + $6::int
    join clinica_simulada.d_calendario d
      on d.data = c.data and coalesce(d.feriado, 'Não') <> 'Sim'
    join clinica_simulada.d_profissionais p on p.profissional_id = c.profissional_id
    cross join lateral (
      select count(*) as ocupados
      from clinica_simulada.f_agendamentos a
      where a.servico_id = c.servico_id
        and a.profissional_id = c.profissional_id
        and a.data = c.data
        and a.hora = c.hora
        and a.status in ${ACTIVE_STATUSES_SQL}
    ) o
    where c.servico_id = $3
      and ($4::bigint is null or c.profissional_id = $4)
      and c.data + make_interval(hours => c.hora::int) > l.local_now
      and c.vagas - o.ocupados > 0
    order by c.hora, p.profissional, c.profissional_id`,

  // $1 paciente, $2 now, $3 tz
  upcoming: `/* t10:upcoming */
    select a.agendamento_id, a.paciente_id, a.servico_id, s.servico,
           a.profissional_id, p.profissional,
           to_char(a.data, 'YYYY-MM-DD') as data, a.hora, a.status,
           a.forma_pagamento, a.convenio_id, a.valor_sessao, a.primeira_consulta,
           a.remarcacao_de,
           (a.data + make_interval(hours => a.hora::int)) at time zone $3 as starts_at
    from clinica_simulada.f_agendamentos a
    left join clinica_simulada.d_servicos s on s.servico_id = a.servico_id
    left join clinica_simulada.d_profissionais p on p.profissional_id = a.profissional_id
    where a.paciente_id = $1
      and a.status = 'Agendado'
      and a.data >= ($2::timestamptz at time zone $3)::date
      and (a.data + make_interval(hours => a.hora::int)) at time zone $3 > $2::timestamptz
    order by a.data, a.hora, a.agendamento_id`,

  lock: `/* t10:lock */ select pg_advisory_xact_lock(hashtextextended($1, 0))`,

  // $1 servico, $2 profissional, $3 data, $4 hora, $5 now, $6 tz
  slotCheck: `/* t10:slot_check */
    select c.vagas,
           d.dia_semana,
           coalesce(d.feriado, 'Não') = 'Sim' as feriado,
           ((c.data + make_interval(hours => c.hora::int)) at time zone $6) > $5::timestamptz as futuro,
           (select count(*)
              from clinica_simulada.f_agendamentos a
             where a.servico_id = c.servico_id
               and a.profissional_id = c.profissional_id
               and a.data = c.data
               and a.hora = c.hora
               and a.status in ${ACTIVE_STATUSES_SQL})::int as ocupados
    from clinica_simulada.f_capacidade c
    join clinica_simulada.d_calendario d on d.data = c.data
    where c.servico_id = $1 and c.profissional_id = $2
      and c.data = $3::date and c.hora = $4`,

  // $1 paciente, $2 contrato, $3 servico, $4 profissional, $5 forma_pagamento,
  // $6 convenio, $7 data, $8 hora, $9 dia_semana, $10 turno, $11 numero_sessao,
  // $12 remarcacao_de, $13 primeira_consulta|null, $14 valor_sessao|null,
  // $15 now, $16 tz
  insertAppointment: `/* t10:insert_appointment */
    insert into clinica_simulada.f_agendamentos (
      paciente_id, contrato_id, servico_id, profissional_id, forma_pagamento,
      convenio_id, data, hora, dia_semana, turno, data_marcacao,
      antecedencia_dias, canal_marcacao, status, lembrete_enviado,
      lembrete_confirmado, numero_sessao, remarcacao_de, primeira_consulta,
      horario_reaproveitado, valor_sessao, receita_realizada, receita_perdida,
      valor_vaga_perdida
    )
    select $1, $2, $3, $4, $5::text, $6, $7::date, $8, $9, $10, l.today,
           $7::date - l.today, 'Chatbot', 'Agendado', null, null, $11, $12,
           coalesce($13::text,
             case when exists (
               select 1 from clinica_simulada.f_agendamentos x
               where x.paciente_id = $1 and x.status in ${ACTIVE_STATUSES_SQL}
             ) then 'Não' else 'Sim' end),
           null,
           coalesce($14::numeric,
             case when $5::text = 'Convênio' then coalesce(
               (select case s.servico
                         when 'Fisioterapia ambulatorial' then cv.valor_sessao_fisioterapia
                         when 'RPG' then cv.valor_sessao_rpg
                         when 'Fisioterapia pélvica' then cv.valor_sessao_pelvica
                       end
                  from clinica_simulada.d_convenios cv
                  join clinica_simulada.d_servicos s on s.servico_id = $3
                 where cv.convenio_id = $6),
               (select pr.valor from clinica_simulada.d_precos pr
                 where pr.servico_id = $3 and pr.tipo = 'avulso'))
             else (select pr.valor from clinica_simulada.d_precos pr
                    where pr.servico_id = $3
                      and pr.tipo = case $5::text
                                      when 'Particular avulso' then 'avulso'
                                      when 'Pacote particular' then 'pacote'
                                      when 'Mensalidade' then 'mensalidade'
                                    end)
             end),
           0, 0, 0
    from (select ($15::timestamptz at time zone $16)::date as today) l
    returning agendamento_id, paciente_id, servico_id, profissional_id,
              to_char(data, 'YYYY-MM-DD') as data, hora, status, forma_pagamento,
              convenio_id, valor_sessao, primeira_consulta, remarcacao_de`,

  // $1 agendamento, $2 paciente, $3 now, $4 tz
  findOwnedForUpdate: `/* t10:find_owned */
    select a.agendamento_id, a.paciente_id, a.contrato_id, a.servico_id,
           a.profissional_id, to_char(a.data, 'YYYY-MM-DD') as data, a.hora,
           a.status, a.forma_pagamento, a.convenio_id, a.valor_sessao,
           a.primeira_consulta, a.numero_sessao, a.remarcacao_de,
           (a.data + make_interval(hours => a.hora::int)) at time zone $4 as starts_at,
           extract(epoch from ((a.data + make_interval(hours => a.hora::int)) at time zone $4)
                              - $3::timestamptz) / 3600.0 as horas_ate
    from clinica_simulada.f_agendamentos a
    where a.agendamento_id = $1 and a.paciente_id = $2 and a.status = 'Agendado'
    for update`,

  cancelAppointment: `/* t10:cancel_appointment */
    update clinica_simulada.f_agendamentos
       set status = 'Cancelado com antecedência'
     where agendamento_id = $1 and status = 'Agendado'
    returning agendamento_id, paciente_id, servico_id, profissional_id,
              to_char(data, 'YYYY-MM-DD') as data, hora, status, forma_pagamento,
              convenio_id, valor_sessao, primeira_consulta, remarcacao_de`,

  upsertContact: `/* t10:upsert_contact */
    insert into clinica_simulada.contacts (wa_id, last_message_at)
    values ($1, $2)
    on conflict (wa_id) do update
      set last_message_at = greatest(contacts.last_message_at, excluded.last_message_at)`,

  openConversation: `/* t10:open_conversation */
    select c.id,
           exists (select 1 from clinica_simulada.agendamento_chatbot ac
                    where ac.conversation_id = c.id) as tem_agendamento
    from clinica_simulada.conversations c
    where c.wa_id = $1 and c.status = 'open'
    for update of c`,

  touchConversation: `/* t10:touch_conversation */
    update clinica_simulada.conversations
       set current_intent = 'scheduling',
           last_message_at = greatest(last_message_at, $2)
     where id = $1`,

  closeConversation: `/* t10:close_conversation */
    update clinica_simulada.conversations
       set status = 'closed', closed_at = $2
     where id = $1 and status = 'open'`,

  insertConversation: `/* t10:insert_conversation */
    insert into clinica_simulada.conversations
      (wa_id, status, current_intent, opened_at, last_message_at)
    values ($1, 'open', 'scheduling', $2, $2)
    on conflict (wa_id) where status = 'open' and wa_id is not null do nothing
    returning id`,

  insertChatbotLink: `/* t10:insert_chatbot */
    insert into clinica_simulada.agendamento_chatbot
      (agendamento_id, wa_id, conversation_id, dispatch_id, criterio)
    values ($1, $2, $3, null, 'agendamento_pelo_chatbot')`,

  audit: `/* t10:audit */
    insert into clinica_simulada.audit_log (entity_type, entity_id, action, actor_scope, created_at)
    values ('${AUDIT_ENTITY}', lpad(to_hex($1::bigint), 32, '0')::uuid, $2, '${ACTOR_SCOPE}', $3)`,
};

export function createAppointmentRepository({
  pool,
  clock = () => new Date(),
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('createAppointmentRepository requires a pool with query() and connect().');
  }

  let horizonPromise = null;

  function resolveNow(now) {
    const value = now ?? clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new TypeError('now must be a valid date.');
    }
    return date;
  }

  async function withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      if (result && result.ok === false) {
        await client.query('rollback');
      } else {
        await client.query('commit');
      }
      return result;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        // a falha original e mais util do que a do rollback
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // Chama extend_schedule no maximo uma vez por instancia (processo). Em caso
  // de erro, libera para uma nova tentativa na proxima chamada.
  function ensureScheduleHorizon(days = 60) {
    const value = requireInt(days, 'days');
    if (!horizonPromise) {
      horizonPromise = pool
        .query({ text: SQL.extendSchedule, values: [value] })
        .then((result) => ({ inserted: Number(result.rows[0]?.inserted ?? 0) }))
        .catch((error) => {
          horizonPromise = null;
          throw error;
        });
    }
    return horizonPromise;
  }

  async function listAvailableDays({
    serviceId,
    professionalId = null,
    from,
    horizonDays = DEFAULT_HORIZON_DAYS,
    now,
  } = {}) {
    const at = resolveNow(now);
    const result = await pool.query({
      text: SQL.availableDays,
      values: [
        at,
        timezone,
        requireInt(serviceId, 'serviceId'),
        optionalInt(professionalId, 'professionalId'),
        from === undefined || from === null ? '1900-01-01' : requireDate(from, 'from'),
        requireInt(horizonDays, 'horizonDays'),
      ],
    });
    return result.rows.map((row) => ({ date: row.data, freeSlots: Number(row.livres) }));
  }

  async function listAvailableTimes({
    serviceId,
    professionalId = null,
    date,
    horizonDays = DEFAULT_HORIZON_DAYS,
    now,
  } = {}) {
    const at = resolveNow(now);
    const result = await pool.query({
      text: SQL.availableTimes,
      values: [
        at,
        timezone,
        requireInt(serviceId, 'serviceId'),
        optionalInt(professionalId, 'professionalId'),
        requireDate(date, 'date'),
        requireInt(horizonDays, 'horizonDays'),
      ],
    });
    return result.rows.map((row) => ({
      hour: Number(row.hora),
      professionalId: Number(row.profissional_id),
      professionalName: row.profissional,
      remaining: Number(row.restantes),
    }));
  }

  async function listUpcoming({ patientId, now } = {}) {
    const at = resolveNow(now);
    const result = await pool.query({
      text: SQL.upcoming,
      values: [requireInt(patientId, 'patientId'), at, timezone],
    });
    return result.rows.map((row) => stripUndefined(mapAppointment(row)));
  }

  // --- helpers transacionais ------------------------------------------------

  async function lockAndCheckSlot(client, slot, now) {
    await client.query({ text: SQL.lock, values: [slotLockKey(slot)] });
    const result = await client.query({
      text: SQL.slotCheck,
      values: [slot.serviceId, slot.professionalId, slot.date, slot.hour, now, timezone],
    });
    const row = result.rows[0];
    if (!row || row.feriado || !row.futuro || Number(row.vagas) - Number(row.ocupados) <= 0) {
      return null;
    }
    return { weekday: row.dia_semana };
  }

  // Devolve uma conversa aberta sem agendamento_chatbot (UNIQUE em
  // conversation_id), fechando a aberta se ela ja sustenta um agendamento.
  async function ensureBookingConversation(client, waId, now) {
    await client.query({ text: SQL.lock, values: [`clinica_simulada:conversation:${waId}`] });
    await client.query({ text: SQL.upsertContact, values: [waId, now] });

    const open = (await client.query({ text: SQL.openConversation, values: [waId] })).rows[0];
    if (open && !open.tem_agendamento) {
      await client.query({ text: SQL.touchConversation, values: [open.id, now] });
      return { id: open.id, reused: true };
    }
    if (open) {
      await client.query({ text: SQL.closeConversation, values: [open.id, now] });
    }
    const inserted = (await client.query({ text: SQL.insertConversation, values: [waId, now] })).rows[0];
    if (!inserted) {
      throw new Error('Could not open a clinica_simulada conversation for this contact.');
    }
    return { id: inserted.id, reused: false };
  }

  async function insertAppointment(client, fields, now) {
    const result = await client.query({
      text: SQL.insertAppointment,
      values: [
        fields.patientId,
        fields.contractId ?? null,
        fields.serviceId,
        fields.professionalId,
        fields.paymentMethod,
        fields.insuranceId ?? null,
        fields.date,
        fields.hour,
        fields.weekday ?? null,
        shiftForHour(fields.hour),
        fields.sessionNumber ?? null,
        fields.rescheduledFrom ?? null,
        fields.firstVisit === undefined || fields.firstVisit === null
          ? null
          : fields.firstVisit ? 'Sim' : 'Não',
        fields.sessionValue ?? null,
        now,
        timezone,
      ],
    });
    return result.rows[0];
  }

  async function audit(client, appointmentId, action, now) {
    await client.query({ text: SQL.audit, values: [appointmentId, action, now] });
  }

  async function linkToConversation(client, appointmentId, waId, now) {
    const conversation = await ensureBookingConversation(client, waId, now);
    await client.query({
      text: SQL.insertChatbotLink,
      values: [appointmentId, waId, conversation.id],
    });
    return conversation;
  }

  async function findOwned(client, { appointmentId, patientId }, now) {
    const result = await client.query({
      text: SQL.findOwnedForUpdate,
      values: [appointmentId, patientId, now, timezone],
    });
    return result.rows[0] ?? null;
  }

  // --- escrita --------------------------------------------------------------

  async function book({
    patientId,
    waId,
    serviceId,
    professionalId,
    date,
    hour,
    paymentMethod = 'Particular avulso',
    insuranceId = null,
    firstVisit = null,
    now,
  } = {}) {
    const at = resolveNow(now);
    const slot = {
      serviceId: requireInt(serviceId, 'serviceId'),
      professionalId: requireInt(professionalId, 'professionalId'),
      date: requireDate(date, 'date'),
      hour: requireInt(hour, 'hour'),
    };
    const patient = requireInt(patientId, 'patientId');
    requireWaId(waId);
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      throw new RangeError(`Invalid paymentMethod: ${paymentMethod}`);
    }
    const insurance = optionalInt(insuranceId, 'insuranceId');
    if (paymentMethod === 'Convênio' && insurance === null) {
      throw new TypeError('insuranceId is required when paymentMethod is Convênio.');
    }

    return withTransaction(async (client) => {
      const checked = await lockAndCheckSlot(client, slot, at);
      if (!checked) {
        return { ok: false, reason: 'slot_unavailable' };
      }
      const row = await insertAppointment(client, {
        ...slot,
        patientId: patient,
        paymentMethod,
        insuranceId: paymentMethod === 'Convênio' ? insurance : null,
        weekday: checked.weekday,
        firstVisit,
      }, at);
      const conversation = await linkToConversation(client, row.agendamento_id, waId, at);
      await audit(client, row.agendamento_id, 'booked', at);
      return {
        ok: true,
        appointment: stripUndefined({ ...mapAppointment(row), conversationId: conversation.id }),
      };
    });
  }

  async function reschedule({
    patientId,
    waId,
    appointmentId,
    date,
    hour,
    professionalId = null,
    minNoticeHours = DEFAULT_MIN_NOTICE_HOURS,
    now,
  } = {}) {
    const at = resolveNow(now);
    const owned = {
      appointmentId: requireInt(appointmentId, 'appointmentId'),
      patientId: requireInt(patientId, 'patientId'),
    };
    requireWaId(waId);
    const target = { date: requireDate(date, 'date'), hour: requireInt(hour, 'hour') };
    const requestedProfessional = optionalInt(professionalId, 'professionalId');
    const notice = Number(minNoticeHours);

    return withTransaction(async (client) => {
      const original = await findOwned(client, owned, at);
      if (!original) {
        return { ok: false, reason: 'not_found' };
      }
      if (Number(original.horas_ate) < notice) {
        return { ok: false, reason: 'too_late' };
      }

      const slot = {
        serviceId: Number(original.servico_id),
        professionalId: requestedProfessional ?? Number(original.profissional_id),
        ...target,
      };
      const checked = await lockAndCheckSlot(client, slot, at);
      if (!checked) {
        return { ok: false, reason: 'slot_unavailable' };
      }

      const cancelled = (await client.query({
        text: SQL.cancelAppointment,
        values: [original.agendamento_id],
      })).rows[0];
      const row = await insertAppointment(client, {
        ...slot,
        patientId: owned.patientId,
        contractId: original.contrato_id,
        paymentMethod: original.forma_pagamento,
        insuranceId: original.convenio_id,
        weekday: checked.weekday,
        sessionNumber: original.numero_sessao,
        rescheduledFrom: original.agendamento_id,
        firstVisit: original.primeira_consulta === null ? null : original.primeira_consulta === 'Sim',
        sessionValue: original.valor_sessao,
      }, at);
      const conversation = await linkToConversation(client, row.agendamento_id, waId, at);
      await audit(client, original.agendamento_id, 'rescheduled', at);
      await audit(client, row.agendamento_id, 'booked', at);

      return {
        ok: true,
        appointment: stripUndefined({ ...mapAppointment(row), conversationId: conversation.id }),
        previous: stripUndefined(mapAppointment(cancelled)),
      };
    });
  }

  async function cancel({
    patientId,
    appointmentId,
    minNoticeHours = DEFAULT_MIN_NOTICE_HOURS,
    now,
  } = {}) {
    const at = resolveNow(now);
    const owned = {
      appointmentId: requireInt(appointmentId, 'appointmentId'),
      patientId: requireInt(patientId, 'patientId'),
    };
    const notice = Number(minNoticeHours);

    return withTransaction(async (client) => {
      const original = await findOwned(client, owned, at);
      if (!original) {
        return { ok: false, reason: 'not_found' };
      }
      if (Number(original.horas_ate) < notice) {
        return { ok: false, reason: 'too_late' };
      }
      const cancelled = (await client.query({
        text: SQL.cancelAppointment,
        values: [original.agendamento_id],
      })).rows[0];
      await audit(client, original.agendamento_id, 'cancelled', at);
      return { ok: true, appointment: stripUndefined(mapAppointment(cancelled)) };
    });
  }

  return {
    ensureScheduleHorizon,
    listAvailableDays,
    listAvailableTimes,
    book,
    listUpcoming,
    reschedule,
    cancel,
  };
}
