// Leitura do catalogo da clinica (schema clinica_simulada, POC). Somente SELECT,
// SQL parametrizado, saida em camelCase. O pool e injetado (pg.Pool ou falso).

const SCHEMA = 'clinica_simulada';

const LIST_SERVICES_SQL = `
  select s.servico_id, s.servico, s.duracao_min, s.vagas_por_horario,
         coalesce(
           json_agg(json_build_object('id', p.profissional_id, 'name', p.profissional)
                    order by p.profissional_id) filter (where p.profissional_id is not null),
           '[]'::json
         ) as professionals
    from ${SCHEMA}.d_servicos s
    left join ${SCHEMA}.d_profissionais p on p.servico_id = s.servico_id
   group by s.servico_id, s.servico, s.duracao_min, s.vagas_por_horario
   order by s.servico_id`;

const LIST_INSURANCE_SQL = `
  select convenio_id, convenio from ${SCHEMA}.d_convenios order by convenio_id`;

const LIST_PRICES_SQL = `
  select servico_id, tipo, valor from ${SCHEMA}.d_precos order by servico_id, tipo`;

// feriado = 'Sim' | 'Não' (texto). Datas devolvidas como YYYY-MM-DD.
const LIST_HOLIDAYS_SQL = `
  select to_char(data, 'YYYY-MM-DD') as data
    from ${SCHEMA}.d_calendario
   where feriado = 'Sim' and data between $1::date and $2::date
   order by data`;

const LIST_FAQ_SQL = `
  select slug, question, answer
    from ${SCHEMA}.faq_entries
   where status = 'published'
   order by slug`;

// extract(isodow): 1 = segunda ... 7 = domingo; convertido para 0 = domingo
// (como Date.getDay e businessHours.js) com isodow % 7.
const OPENING_HOURS_SQL = `
  select (extract(isodow from data)::int % 7) as weekday,
         min(hora) as first_hour, max(hora) as last_hour
    from ${SCHEMA}.f_capacidade
   where data >= current_date and data < current_date + 28 and vagas > 0
   group by 1
   order by 1`;

export function createCatalogRepository({ pool }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createCatalogRepository requires a pool with query().');
  }

  async function rows(text, values) {
    const result = await pool.query(values ? { text, values } : { text });
    return result.rows;
  }

  return {
    async listServices() {
      return (await rows(LIST_SERVICES_SQL)).map((row) => ({
        id: Number(row.servico_id),
        name: row.servico,
        durationMin: Number(row.duracao_min),
        slotCapacity: Number(row.vagas_por_horario),
        professionals: (row.professionals ?? []).map((p) => ({
          id: Number(p.id),
          name: p.name,
        })),
      }));
    },

    async listInsurancePlans() {
      return (await rows(LIST_INSURANCE_SQL)).map((row) => ({
        id: Number(row.convenio_id),
        name: row.convenio,
      }));
    },

    async listPrices() {
      return (await rows(LIST_PRICES_SQL)).map((row) => ({
        serviceId: Number(row.servico_id),
        kind: row.tipo,
        amount: Number(row.valor),
      }));
    },

    async listHolidays({ from, to }) {
      return (await rows(LIST_HOLIDAYS_SQL, [from, to])).map((row) => row.data);
    },

    async listFaqEntries() {
      return rows(LIST_FAQ_SQL);
    },

    // weekday: 0 = domingo ... 6 = sabado. Dias sem vaga nas proximas 4 semanas
    // (ex.: domingo) nao aparecem.
    async getOpeningHours() {
      return (await rows(OPENING_HOURS_SQL)).map((row) => ({
        weekday: Number(row.weekday),
        firstHour: Number(row.first_hour),
        lastHour: Number(row.last_hour),
      }));
    },
  };
}
