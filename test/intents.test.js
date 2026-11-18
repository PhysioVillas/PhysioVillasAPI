import assert from 'node:assert/strict';
import test from 'node:test';
import { detectIntent, normalizeText } from '../src/services/bot/intents.js';

const cases = [
  // urgency
  ['isso é urgente', 'urgency'],
  ['estou com uma emergência', 'urgency'],
  ['tenho muita dor agora', 'urgency'],
  ['eu caí na escada', 'urgency'],
  ['meu joelho está sangrando', 'urgency'],
  ['vomitei sangue', 'urgency'],
  ['desmaiei hoje cedo', 'urgency'],
  ['estou com falta de ar', 'urgency'],

  // human
  ['quero falar com um atendente', 'human'],
  ['pode me passar para um humano?', 'human'],
  ['quero falar com uma pessoa', 'human'],
  ['falar com a equipe, por favor', 'human'],

  // payment
  ['quero pagar o pilates', 'payment'],
  ['preciso do boleto', 'payment'],
  ['vocês aceitam pix?', 'payment'],
  ['qual a mensalidade?', 'payment'],
  ['tem uma cobrança indevida', 'payment'],
  ['minha fatura veio errada', 'payment'],
  ['tenho um valor em aberto', 'payment'],
  ['paguei e não recebi recibo', 'payment'],

  // clinical
  ['tenho dor no joelho', 'clinical'],
  ['tive uma lesão no ombro', 'clinical'],
  ['posso fazer exercício com dor nas costas', 'clinical'],
  ['quais exercícios posso fazer em casa', 'clinical'],

  // prices (and "preço"/"valor" alone)
  ['quanto custa o pilates', 'prices'],
  ['qual o preço da consulta', 'prices'],
  ['qual o valor?', 'prices'],
  ['quais os valores das sessões', 'prices'],

  // menu
  ['menu', 'menu'],
  ['MENU', 'menu'],
  ['início', 'menu'],
  ['inicio', 'menu'],

  // my_appointments (must beat book)
  ['quero ver minhas consultas', 'my_appointments'],
  ['meus agendamentos', 'my_appointments'],
  ['quais são minhas marcações?', 'my_appointments'],

  // reschedule
  ['quero remarcar', 'reschedule'],
  ['preciso reagendar minha sessão', 'reschedule'],
  ['remarcação', 'reschedule'],

  // cancel
  ['quero cancelar', 'cancel'],
  ['preciso desmarcar', 'cancel'],
  ['cancelamento', 'cancel'],

  // book
  ['quero marcar uma consulta', 'book'],
  ['gostaria de agendar', 'book'],
  ['quero uma consulta', 'book'],
  ['marcar horário', 'book'],

  // document
  ['preciso de um atestado', 'document'],
  ['pode emitir uma declaração?', 'document'],
  ['quero o laudo', 'document'],

  // insurance
  ['vocês aceitam convênio?', 'insurance'],
  ['trabalho com plano de saúde', 'insurance'],

  // address
  ['qual o endereço?', 'address'],
  ['onde fica a clínica', 'address'],
  ['como chegar aí', 'address'],

  // hours
  ['qual o horário de funcionamento?', 'hours'],
  ['vocês abrem no sábado?', 'hours'],
  ['que horas fecha hoje', 'hours'],
  ['funciona aos domingos?', 'hours'],

  // priority
  ['urgente, quero pagar', 'urgency'],
  ['quero falar com atendente sobre o pix', 'human'],
  ['quero pagar e tenho dor', 'payment'],
  ['tenho dor, quero remarcar', 'clinical'],
  ['preciso de atendente, tenho dor', 'human'],

  // ambiguity and substring safety
  ['horário', null],
  ['tem horário amanhã?', null],
  ['pixel', null],
  ['caixa', null],
  ['pessoalmente', null],
  ['humanização', null],
  ['obrigado', null],
];

for (const [text, expected] of cases) {
  test(`detectIntent(${JSON.stringify(text)}) -> ${expected}`, () => {
    assert.equal(detectIntent(text), expected);
  });
}

test('quanto custa o pilates is prices, not payment', () => {
  assert.equal(detectIntent('quanto custa o pilates'), 'prices');
});

test('quero pagar o pilates is payment, not prices', () => {
  assert.equal(detectIntent('quero pagar o pilates'), 'payment');
});

test('empty, blank and non-string input return null', () => {
  assert.equal(detectIntent(''), null);
  assert.equal(detectIntent('   '), null);
  assert.equal(detectIntent('???'), null);
  assert.equal(detectIntent(null), null);
  assert.equal(detectIntent(undefined), null);
  assert.equal(detectIntent(42), null);
});

test('keyword matching ignores case, accents and punctuation', () => {
  assert.equal(detectIntent('PIX!!!'), 'payment');
  assert.equal(detectIntent('Cobrança...'), 'payment');
  assert.equal(detectIntent('endereço?'), 'address');
  assert.equal(detectIntent('dor/joelho'), 'clinical');
});

test('keyword matching collapses extra spaces', () => {
  assert.equal(detectIntent('   quero    pagar   '), 'payment');
  assert.equal(detectIntent('muita\t\tdor'), 'urgency');
});

test('multi-word phrases match only as whole phrases', () => {
  assert.equal(detectIntent('muita dor'), 'urgency');
  assert.equal(detectIntent('muita'), null);
  assert.equal(detectIntent('valor em aberto'), 'payment');
});

test('prefix keyword sangr* matches any word starting with sangr', () => {
  assert.equal(detectIntent('sangramento'), 'urgency');
  assert.equal(detectIntent('sangrando'), 'urgency');
});

test('normalizeText strips accents, punctuation and collapses spaces', () => {
  assert.equal(normalizeText('  Ação, já!  '), 'acao ja');
  assert.equal(normalizeText('Não'), 'nao');
  assert.equal(normalizeText(null), '');
});
