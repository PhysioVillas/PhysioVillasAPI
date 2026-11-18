// Repositorio de pacientes, contatos e leads do schema clinica_simulada (POC).
// Nunca registra CPF, nome ou telefone em log ou em mensagem de erro.

const TIMEZONE = 'America/Bahia';

const LEAD_STAGES = Object.freeze({
  greeting: 'Abandonou na saudação',
  service: 'Abandonou na escolha do serviço',
  time: 'Abandonou na escolha do horário',
  booked: 'Agendou pelo chatbot',
  transferred: 'Transferido para atendente',
});
const STAGE_VALUES = new Set(Object.values(LEAD_STAGES));

const IDENTIFICATION = 'Declarada pelo paciente';
const DEFAULT_LEAD_CHANNEL = 'Outro';
const DEFAULT_PATIENT_ORIGIN = 'Novo (lead)';

const SQL = {
  findByCpf: `select paciente_id, split_part(paciente, ' ', 1) as first_name
    from clinica_simulada.d_pacientes where cpf = $1 limit 1`,
  findByWaId: `select p.paciente_id, split_part(p.paciente, ' ', 1) as first_name
    from clinica_simulada.jornada_contatos j
    join clinica_simulada.d_pacientes p on p.paciente_id = j.paciente_id
    where j.wa_id = $1 limit 1`,
  upsertContact: `insert into clinica_simulada.contacts (wa_id) values ($1)
    on conflict (wa_id) do nothing`,
  openConversation: `select id from clinica_simulada.conversations
    where wa_id = $1 and status = 'open' limit 1`,
  insertConversation: `insert into clinica_simulada.conversations (wa_id) values ($1)
    on conflict (wa_id) where status = 'open' and wa_id is not null do nothing
    returning id`,
  journey: `select conversation_id, lead_id, paciente_id
    from clinica_simulada.jornada_contatos where wa_id = $1 for update`,
  upsertJourney: `insert into clinica_simulada.jornada_contatos
      (wa_id, lead_id, paciente_id, conversation_id, origem)
    values ($1, $2, $3, $4,
      case when $2::bigint is null then 'paciente_sem_lead' else 'lead_planilha' end)
    on conflict (wa_id) do update set
      lead_id = coalesce(jornada_contatos.lead_id, excluded.lead_id),
      paciente_id = coalesce(excluded.paciente_id, jornada_contatos.paciente_id),
      origem = case when coalesce(jornada_contatos.lead_id, excluded.lead_id) is null
        then 'paciente_sem_lead' else 'lead_planilha' end`,
  insertLead: `insert into clinica_simulada.f_leads
      (data, hora, canal, forma_identificacao, servico_interesse_id,
       fora_horario_comercial, etapa_final, transferido_atendente, agendou,
       virou_paciente, paciente_id)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    returning lead_id`,
  updateLead: `update clinica_simulada.f_leads set
      etapa_final = $2,
      canal = coalesce($3, canal),
      servico_interesse_id = coalesce($4, servico_interesse_id),
      fora_horario_comercial = coalesce($5, fora_horario_comercial),
      transferido_atendente = coalesce($6, transferido_atendente),
      agendou = coalesce($7, agendou),
      paciente_id = coalesce($8, paciente_id),
      virou_paciente = case when coalesce($8, paciente_id) is not null then 'Sim'
        else virou_paciente end
    where lead_id = $1`,
  insertPatient: `insert into clinica_simulada.d_pacientes
      (paciente, data_cadastro, origem, canal_origem, cpf, lead_id)
    values ($1, $2, $3, $4, $5, $6)
    on conflict (cpf) do nothing
    returning paciente_id`,
  linkLeadToPatient: `update clinica_simulada.f_leads
    set paciente_id = $2, virou_paciente = 'Sim' where lead_id = $1`,
  linkPatientToLead: `update clinica_simulada.d_pacientes set lead_id = $2
    where paciente_id = $1 and lead_id is null`,
};

function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function yesNo(value) {
  if (value === undefined || value === null) return null;
  return value ? 'Sim' : 'Não';
}

function resolveStage(stage) {
  const value = LEAD_STAGES[stage] ?? stage;
  if (!STAGE_VALUES.has(value)) {
    const error = new Error('Invalid lead stage');
    error.code = 'invalid_stage';
    throw error;
  }
  return value;
}

function bahiaParts(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}

function createPatientRepository({ pool, clock = () => new Date(), logger } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('A database pool is required');
  }

  async function withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        // rollback failure must not hide the original error
      }
      logger?.error?.({ code: error?.code }, 'patient repository transaction failed');
      throw error;
    } finally {
      client.release();
    }
  }

  // contacts + conversa aberta (jornada_contatos.conversation_id e NOT NULL):
  // reaproveita a conversa aberta do contato ou cria uma.
  async function ensureConversation(client, waId) {
    await client.query(SQL.upsertContact, [waId]);
    const open = await client.query(SQL.openConversation, [waId]);
    if (open.rows[0]) return open.rows[0].id;
    const created = await client.query(SQL.insertConversation, [waId]);
    if (created.rows[0]) return created.rows[0].id;
    const retry = await client.query(SQL.openConversation, [waId]);
    return retry.rows[0].id;
  }

  async function findPatientByCpf(cpf) {
    const digits = onlyDigits(cpf);
    if (digits.length !== 11) return null;
    const { rows } = await pool.query(SQL.findByCpf, [digits]);
    return rows[0] ? { id: Number(rows[0].paciente_id), firstName: rows[0].first_name } : null;
  }

  async function findPatientByWaId(waId) {
    const { rows } = await pool.query(SQL.findByWaId, [waId]);
    return rows[0] ? { id: Number(rows[0].paciente_id), firstName: rows[0].first_name } : null;
  }

  async function createPatient({ name, cpf, origin, channel, waId, leadId } = {}) {
    const digits = onlyDigits(cpf);
    if (digits.length !== 11 || typeof name !== 'string' || name.trim() === '') {
      const error = new Error('Invalid patient data');
      error.code = 'invalid_patient';
      throw error;
    }
    const today = bahiaParts(clock()).date;
    return withTransaction(async (client) => {
      let resolvedLeadId = leadId ?? null;
      if (resolvedLeadId === null && waId) {
        const journey = await client.query(SQL.journey, [waId]);
        resolvedLeadId = journey.rows[0]?.lead_id ?? null;
      }
      const inserted = await client.query(SQL.insertPatient, [
        name.trim(),
        today,
        origin ?? DEFAULT_PATIENT_ORIGIN,
        channel ?? DEFAULT_LEAD_CHANNEL,
        digits,
        resolvedLeadId,
      ]);
      if (!inserted.rows[0]) {
        const error = new Error('Patient already exists');
        error.code = 'cpf_exists';
        throw error;
      }
      const id = Number(inserted.rows[0].paciente_id);
      if (resolvedLeadId !== null) {
        await client.query(SQL.linkLeadToPatient, [resolvedLeadId, id]);
      }
      return { id };
    });
  }

  async function linkContact({ waId, patientId = null, leadId = null } = {}) {
    if (!waId) throw new Error('waId is required');
    return withTransaction(async (client) => {
      const conversationId = await ensureConversation(client, waId);
      const existing = await client.query(SQL.journey, [waId]);
      const journeyConversation = existing.rows[0]?.conversation_id ?? conversationId;
      await client.query(SQL.upsertJourney, [waId, leadId, patientId, journeyConversation]);
      if (leadId !== null && patientId !== null) {
        await client.query(SQL.linkLeadToPatient, [leadId, patientId]);
        await client.query(SQL.linkPatientToLead, [patientId, leadId]);
      }
      return { waId, conversationId: journeyConversation };
    });
  }

  async function upsertLead({
    waId,
    stage,
    channel,
    serviceInterestId,
    outsideBusinessHours,
    transferred,
    booked,
    patientId,
  } = {}) {
    if (!waId) throw new Error('waId is required');
    const etapa = resolveStage(stage);
    const flags = [
      yesNo(outsideBusinessHours),
      yesNo(transferred ?? (etapa === LEAD_STAGES.transferred ? true : undefined)),
      yesNo(booked ?? (etapa === LEAD_STAGES.booked ? true : undefined)),
    ];

    return withTransaction(async (client) => {
      const conversationId = await ensureConversation(client, waId);
      const existing = await client.query(SQL.journey, [waId]);
      const row = existing.rows[0];
      const resolvedPatient = patientId ?? row?.paciente_id ?? null;

      if (row?.lead_id) {
        await client.query(SQL.updateLead, [
          row.lead_id,
          etapa,
          channel ?? null,
          serviceInterestId ?? null,
          ...flags,
          resolvedPatient,
        ]);
        if (patientId != null && patientId !== row.paciente_id) {
          await client.query(SQL.upsertJourney, [
            waId, row.lead_id, patientId, row.conversation_id,
          ]);
        }
        return { leadId: Number(row.lead_id) };
      }

      const now = bahiaParts(clock());
      const inserted = await client.query(SQL.insertLead, [
        now.date,
        now.hour,
        channel ?? DEFAULT_LEAD_CHANNEL,
        IDENTIFICATION,
        serviceInterestId ?? null,
        flags[0] ?? 'Não',
        etapa,
        flags[1] ?? 'Não',
        flags[2] ?? 'Não',
        resolvedPatient !== null ? 'Sim' : 'Não',
        resolvedPatient,
      ]);
      const leadId = Number(inserted.rows[0].lead_id);
      await client.query(SQL.upsertJourney, [
        waId, leadId, resolvedPatient, row?.conversation_id ?? conversationId,
      ]);
      if (resolvedPatient !== null) {
        await client.query(SQL.linkPatientToLead, [resolvedPatient, leadId]);
      }
      return { leadId };
    });
  }

  return { findPatientByCpf, findPatientByWaId, createPatient, linkContact, upsertLead };
}

export { createPatientRepository, LEAD_STAGES };
