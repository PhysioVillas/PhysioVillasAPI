const FORMATTED_CPF = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;
const CPF_IN_TEXT = /(?<!\d)(\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?!\d)/;

function checkDigit(digits, length) {
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    sum += Number(digits[i]) * (length + 1 - i);
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/**
 * Accepts a whole-message CPF: 11 digits, optionally written as 123.456.789-09.
 * Returns the 11 digits, or null. Does not check the check digits (use isValidCpf).
 */
export function normalizeCpf(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const trimmed = text.trim();
  if (/^\d{11}$/.test(trimmed)) {
    return trimmed;
  }
  if (FORMATTED_CPF.test(trimmed)) {
    return trimmed.replace(/\D/g, '');
  }
  return null;
}

/** Validates 11 digits, their two check digits, and rejects repeated sequences. */
export function isValidCpf(digits) {
  if (typeof digits !== 'string' || !/^\d{11}$/.test(digits)) {
    return false;
  }
  if (/^(\d)\1{10}$/.test(digits)) {
    return false;
  }
  const first = checkDigit(digits, 9);
  if (first !== Number(digits[9])) {
    return false;
  }
  const second = checkDigit(digits, 10);
  return second === Number(digits[10]);
}

/** Masks a CPF for display, keeping only the two last digits: ***.***.***-09 */
export function maskCpf(digits) {
  return `***.***.***-${String(digits).slice(-2)}`;
}

/**
 * Finds the first CPF inside free text, either formatted (123.456.789-09) or as
 * 11 raw digits. Returns { digits, start, end } (end exclusive) or null.
 * The match is not validated; combine with isValidCpf when needed.
 */
export function findCpfInText(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const match = CPF_IN_TEXT.exec(text);
  if (!match) {
    return null;
  }
  return {
    digits: match[1].replace(/\D/g, ''),
    start: match.index,
    end: match.index + match[1].length,
  };
}
