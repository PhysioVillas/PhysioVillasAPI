import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogRepository } from '../src/services/clinic/catalogRepository.js';

function createPool(rows) {
  const calls = [];
  return {
    calls,
    query: async (query) => {
      calls.push(query);
      return { rows };
    },
  };
}

test('listServices maps services and professionals to camelCase numbers', async () => {
  const pool = createPool([
    {
      servico_id: '2',
      servico: 'Fisioterapia ambulatorial',
      duracao_min: '60',
      vagas_por_horario: '6',
      professionals: [{ id: 3, name: 'Prof A' }],
    },
    { servico_id: '4', servico: 'Massagem', duracao_min: '60', vagas_por_horario: '1', professionals: null },
  ]);
  const result = await createCatalogRepository({ pool }).listServices();

  assert.deepEqual(result, [
    { id: 2, name: 'Fisioterapia ambulatorial', durationMin: 60, slotCapacity: 6, professionals: [{ id: 3, name: 'Prof A' }] },
    { id: 4, name: 'Massagem', durationMin: 60, slotCapacity: 1, professionals: [] },
  ]);
  assert.match(pool.calls[0].text, /from clinica_simulada\.d_servicos/i);
});

test('listInsurancePlans and listPrices convert ids and amounts', async () => {
  const plans = await createCatalogRepository({
    pool: createPool([{ convenio_id: '1', convenio: 'Convênio A' }]),
  }).listInsurancePlans();
  assert.deepEqual(plans, [{ id: 1, name: 'Convênio A' }]);

  const prices = await createCatalogRepository({
    pool: createPool([{ servico_id: '3', tipo: 'pacote', valor: '130.00' }]),
  }).listPrices();
  assert.deepEqual(prices, [{ serviceId: 3, kind: 'pacote', amount: 130 }]);
});

test('listHolidays passes the range as parameters and filters feriado = Sim', async () => {
  const pool = createPool([{ data: '2026-12-25' }]);
  const result = await createCatalogRepository({ pool }).listHolidays({
    from: '2026-11-18',
    to: '2027-01-17',
  });

  assert.deepEqual(result, ['2026-12-25']);
  assert.match(pool.calls[0].text, /feriado = 'Sim'/);
  assert.deepEqual(pool.calls[0].values, ['2026-11-18', '2027-01-17']);
  assert.doesNotMatch(pool.calls[0].text, /2026/);
});

test('listFaqEntries returns only published entries', async () => {
  const pool = createPool([{ slug: 'endereco', question: 'Q', answer: 'A' }]);
  const result = await createCatalogRepository({ pool }).listFaqEntries();

  assert.deepEqual(result, [{ slug: 'endereco', question: 'Q', answer: 'A' }]);
  assert.match(pool.calls[0].text, /status = 'published'/);
});

test('getOpeningHours uses weekday 0 = Sunday derived from isodow', async () => {
  const pool = createPool([
    { weekday: 1, first_hour: '6', last_hour: '19' },
    { weekday: 6, first_hour: '8', last_hour: '12' },
  ]);
  const result = await createCatalogRepository({ pool }).getOpeningHours();

  assert.deepEqual(result, [
    { weekday: 1, firstHour: 6, lastHour: 19 },
    { weekday: 6, firstHour: 8, lastHour: 12 },
  ]);
  assert.match(pool.calls[0].text, /isodow from data\)::int % 7/);
  assert.match(pool.calls[0].text, /current_date \+ 28/);
});

test('createCatalogRepository requires a pool', () => {
  assert.throws(() => createCatalogRepository({}), /pool/);
});
