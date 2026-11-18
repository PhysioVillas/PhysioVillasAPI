import assert from 'node:assert/strict';
import test from 'node:test';
import { findCpfInText, isValidCpf, maskCpf, normalizeCpf } from '../src/services/bot/cpf.js';

test('normalizeCpf accepts 11 raw digits or the formatted CPF', () => {
  assert.equal(normalizeCpf('52998224725'), '52998224725');
  assert.equal(normalizeCpf(' 529.982.247-25 '), '52998224725');
  assert.equal(normalizeCpf('529.982.247-25'), '52998224725');
});

test('normalizeCpf rejects anything that is not exactly a CPF', () => {
  assert.equal(normalizeCpf('5299822472'), null);
  assert.equal(normalizeCpf('529982247255'), null);
  assert.equal(normalizeCpf('529.982.247-2a'), null);
  assert.equal(normalizeCpf('meu cpf é 52998224725'), null);
  assert.equal(normalizeCpf(''), null);
  assert.equal(normalizeCpf(null), null);
  assert.equal(normalizeCpf(52998224725), null);
});

test('isValidCpf accepts CPFs with correct check digits', () => {
  assert.equal(isValidCpf('52998224725'), true);
  assert.equal(isValidCpf('12345678909'), true);
  assert.equal(isValidCpf('11144477735'), true);
});

test('isValidCpf rejects wrong check digits, repeated sequences and malformed input', () => {
  assert.equal(isValidCpf('52998224726'), false);
  assert.equal(isValidCpf('12345678900'), false);
  assert.equal(isValidCpf('11111111111'), false);
  assert.equal(isValidCpf('00000000000'), false);
  assert.equal(isValidCpf('99999999999'), false);
  assert.equal(isValidCpf('1234567890'), false);
  assert.equal(isValidCpf('529.982.247-25'), false);
  assert.equal(isValidCpf(52998224725), false);
  assert.equal(isValidCpf(undefined), false);
});

test('maskCpf shows only the two last digits', () => {
  assert.equal(maskCpf('12345678909'), '***.***.***-09');
  assert.equal(maskCpf('52998224725'), '***.***.***-25');
});

test('findCpfInText finds a formatted CPF in the middle of a sentence', () => {
  const text = 'Oi, meu CPF é 529.982.247-25, pode confirmar?';
  const found = findCpfInText(text);
  assert.deepEqual(found.digits, '52998224725');
  assert.equal(text.slice(found.start, found.end), '529.982.247-25');
});

test('findCpfInText finds 11 raw digits inside a sentence', () => {
  const text = 'cpf 52998224725 obrigado';
  const found = findCpfInText(text);
  assert.deepEqual(found, { digits: '52998224725', start: 4, end: 15 });
});

test('findCpfInText ignores digit runs that are not exactly 11 digits', () => {
  assert.equal(findCpfInText('pedido 123456789012 confirmado'), null);
  assert.equal(findCpfInText('consulta às 10 horas'), null);
  assert.equal(findCpfInText(''), null);
  assert.equal(findCpfInText(null), null);
});
