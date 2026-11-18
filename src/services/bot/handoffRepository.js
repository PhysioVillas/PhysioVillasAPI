// Handoffs para a equipe humana (tabela handoffs, migration 010).
// No maximo um handoff aberto por wa_id (indice unico parcial).

export const HANDOFF_REASONS = Object.freeze([
  'patient_request',
  'payment',
  'clinical_or_urgency',
  'late_change',
  'bot_failure',
  'identity_failure',
  'document_request',
  // Migration 014: a equipe respondeu pelo app sem handoff aberto.
  'team_takeover',
]);

const COLUMNS = `id, wa_id, reason, in_business_hours, requested_at,
  first_team_reply_at, closed_at`;

function mapRow(row) {
  return {
    id: row.id,
    waId: row.wa_id,
    reason: row.reason,
    inBusinessHours: row.in_business_hours,
    requestedAt: row.requested_at,
    firstTeamReplyAt: row.first_team_reply_at,
    closedAt: row.closed_at,
  };
}

export function createHandoffRepository({ pool }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('createHandoffRepository requires a pool with query().');
  }

  async function getOpen(waId) {
    const result = await pool.query({
      text: `select ${COLUMNS} from handoffs where wa_id = $1 and closed_at is null`,
      values: [waId],
    });
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  // Idempotente e seguro sob concorrencia: o insert ignora o conflito com o
  // indice unico parcial e, se nada foi inserido, devolve o aberto existente.
  async function open({ waId, reason, inBusinessHours }) {
    if (!waId) {
      throw new TypeError('open requires waId.');
    }
    if (!HANDOFF_REASONS.includes(reason)) {
      throw new RangeError(`Invalid handoff reason: ${reason}`);
    }

    const inserted = await pool.query({
      text: `
        insert into handoffs (wa_id, reason, in_business_hours)
        values ($1, $2, $3)
        on conflict (wa_id) where closed_at is null do nothing
        returning ${COLUMNS}
      `,
      values: [waId, reason, Boolean(inBusinessHours)],
    });
    if (inserted.rows[0]) {
      return mapRow(inserted.rows[0]);
    }
    return getOpen(waId);
  }

  async function markFirstTeamReply(waId, at = new Date()) {
    const result = await pool.query({
      text: `
        update handoffs
        set first_team_reply_at = $2
        where wa_id = $1 and closed_at is null and first_team_reply_at is null
        returning ${COLUMNS}
      `,
      values: [waId, at],
    });
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async function closeOpen(waId, at = new Date()) {
    const result = await pool.query({
      text: `
        update handoffs set closed_at = $2
        where wa_id = $1 and closed_at is null
        returning ${COLUMNS}
      `,
      values: [waId, at],
    });
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  return { open, getOpen, markFirstTeamReply, closeOpen };
}
