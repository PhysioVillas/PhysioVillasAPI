// Estado de conversa do bot (tabela conversation_state, migration 010).
//
// conversation_state.wa_id tem FK para public.contacts(wa_id): quem chama
// save() deve garantir que o contato existe. O webhook inbound ja faz upsert
// do contato (database.persistInboundMessage -> upsertContactWith) antes de
// acionar o bot, entao o fluxo normal satisfaz a FK.

function mapRow(row) {
  return {
    waId: row.wa_id,
    flow: row.flow,
    step: row.step,
    context: row.context ?? {},
    cpfAttempts: row.cpf_attempts,
    misunderstoodCount: row.misunderstood_count,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export function createStateStore({ pool }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('createStateStore requires a pool with query().');
  }

  async function getActive(waId, now = new Date()) {
    const result = await pool.query({
      text: `
        select wa_id, flow, step, context, cpf_attempts, misunderstood_count,
               expires_at, updated_at
        from conversation_state
        where wa_id = $1 and expires_at > $2
      `,
      values: [waId, now],
    });
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async function save(state) {
    if (!state?.waId || !state.flow || !state.step) {
      throw new TypeError('save requires waId, flow and step.');
    }
    if (!state.expiresAt) {
      throw new TypeError('save requires expiresAt.');
    }

    await pool.query({
      text: `
        insert into conversation_state
          (wa_id, flow, step, context, cpf_attempts, misunderstood_count,
           expires_at, updated_at)
        values ($1, $2, $3, $4::jsonb, $5, $6, $7, now())
        on conflict (wa_id) do update set
          flow = excluded.flow,
          step = excluded.step,
          context = excluded.context,
          cpf_attempts = excluded.cpf_attempts,
          misunderstood_count = excluded.misunderstood_count,
          expires_at = excluded.expires_at,
          updated_at = now()
      `,
      values: [
        state.waId,
        state.flow,
        state.step,
        JSON.stringify(state.context ?? {}),
        state.cpfAttempts ?? 0,
        state.misunderstoodCount ?? 0,
        state.expiresAt,
      ],
    });
  }

  async function clear(waId) {
    await pool.query({
      text: 'delete from conversation_state where wa_id = $1',
      values: [waId],
    });
  }

  return { getActive, save, clear };
}
