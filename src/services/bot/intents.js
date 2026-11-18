// Detector de intenção por palavras-chave (sem IA generativa).
//
// Regras de casamento:
// - o texto é normalizado (minúsculas, sem acento, pontuação vira espaço);
// - cada palavra-chave casa por palavra inteira ou frase inteira, nunca por
//   substring ("pix" não casa dentro de outra palavra);
// - uma palavra-chave terminada em "*" casa como prefixo da palavra
//   ("sangr*" casa "sangra", "sangrando", "sangramento").
//
// Prioridade: urgency > human > payment > clinical > o resto.
// Pergunta de urgência ou clínica sempre vai para triagem antes de qualquer
// outra coisa; pedido de atendente e pagamento vão para a equipe.

// Urgência: orientar SAMU 192 e chamar a equipe.
// Decisões de ambiguidade:
// - "cai" vem de "caí" (acento removido). "cai" também é verbo comum
//   ("o preço cai"), então pode gerar falso positivo de urgência. Mantido
//   por segurança: um falso positivo leva a um atendimento humano, um falso
//   negativo deixa uma queda sem resposta. Casa só a palavra inteira.
// - "sangue" é acréscimo além da lista original (ex.: "vomitei sangue").
export const URGENCY_KEYWORDS = [
  'urgente',
  'urgencia',
  'emergencia',
  'muita dor',
  'cai',
  'sangr*',
  'sangue',
  'desmai*',
  'falta de ar',
];

// Pedido de atendente humano.
// "pessoa" e "humano" são termos genéricos; aceitos conforme o plano.
export const HUMAN_KEYWORDS = [
  'atendente',
  'humano',
  'humana',
  'pessoa',
  'atendimento humano',
  'falar com alguem',
  'falar com a equipe',
  'falar com uma pessoa',
];

// Qualquer assunto de pagamento, mensalidade ou cobrança vai para a equipe.
// "valor em aberto" é frase; "valor" sozinho é `prices`.
export const PAYMENT_KEYWORDS = [
  'pagar',
  'pagamento',
  'pagamentos',
  'paguei',
  'pago',
  'boleto',
  'pix',
  'mensalidade',
  'cobranca',
  'cobrado',
  'cobraram',
  'fatura',
  'valor em aberto',
];

// Perguntas clínicas (lesão, exercício) vão para a equipe.
// "dor" sozinho NÃO é clínico (decisão de 2026-11-18): "tenho dor no joelho,
// quero agendar" deve seguir para o agendamento; "muita dor" continua urgência.
export const CLINICAL_KEYWORDS = [
  'lesao',
  'lesoes',
  'exercicio',
  'exercicios',
];

export const RESCHEDULE_KEYWORDS = [
  'remarcar',
  'remarcacao',
  'reagendar',
  'reagendamento',
];

export const CANCEL_KEYWORDS = [
  'cancelar',
  'cancelamento',
  'desmarcar',
];

// Verificado antes de `book`: "minhas consultas marcadas" não pode virar agendamento.
export const MY_APPOINTMENTS_KEYWORDS = [
  'minhas consultas',
  'meus agendamentos',
  'minhas marcacoes',
  'proxima consulta',
  'meus horarios',
];

// Decisões de ambiguidade:
// - "horário" sozinho NÃO entra aqui: pode significar agendamento ou
//   funcionamento, então devolve null. "marcar horário" vira `book` (via
//   "marcar") e "horário de funcionamento/atendimento" vira `hours`.
// - "consulta" sozinho NÃO entra aqui: "qual o preço da consulta" é `prices`.
//   Só frases explícitas de agendamento disparam `book`.
export const BOOK_KEYWORDS = [
  'agendar',
  'agendamento',
  'marcar',
  'quero uma consulta',
  'nova consulta',
];

// Atestado, declaração, recibo, laudo: pedido de documento para a equipe.
export const DOCUMENT_KEYWORDS = [
  'atestado',
  'declaracao',
  'recibo',
  'laudo',
];

export const INSURANCE_KEYWORDS = [
  'convenio',
  'convenios',
  'plano',
  'planos',
  'plano de saude',
];

export const ADDRESS_KEYWORDS = [
  'endereco',
  'onde fica',
  'onde voces ficam',
  'localizacao',
  'como chegar',
];

export const HOURS_KEYWORDS = [
  'horario de funcionamento',
  'horario de atendimento',
  'que horas abre',
  'que horas fecha',
  'funciona',
  'funcionamento',
  'abre',
  'abrem',
  'fecha',
  'fecham',
];

// "preço" e "valor" sozinhos são `prices`; "valor em aberto" já foi tratado como payment.
export const PRICES_KEYWORDS = [
  'preco',
  'precos',
  'valor',
  'valores',
  'quanto custa',
  'custa',
];

export const MENU_KEYWORDS = [
  'menu',
  'inicio',
];

const STEPS = [
  ['urgency', URGENCY_KEYWORDS],
  ['human', HUMAN_KEYWORDS],
  ['payment', PAYMENT_KEYWORDS],
  ['clinical', CLINICAL_KEYWORDS],
  ['reschedule', RESCHEDULE_KEYWORDS],
  ['cancel', CANCEL_KEYWORDS],
  ['my_appointments', MY_APPOINTMENTS_KEYWORDS],
  ['book', BOOK_KEYWORDS],
  ['document', DOCUMENT_KEYWORDS],
  ['insurance', INSURANCE_KEYWORDS],
  ['address', ADDRESS_KEYWORDS],
  ['hours', HOURS_KEYWORDS],
  ['prices', PRICES_KEYWORDS],
  ['menu', MENU_KEYWORDS],
];

function stripAccents(value) {
  return value.normalize('NFD').replace(/\p{M}+/gu, '');
}

// Normaliza o texto de entrada: minúsculas, sem acento, pontuação vira espaço,
// espaços colapsados.
export function normalizeText(text) {
  if (typeof text !== 'string') {
    return '';
  }

  return stripAccents(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordToPattern(keyword) {
  // "*" vira prefixo de palavra; o restante é literal (já sem acento e minúsculo).
  const normalized = stripAccents(keyword).toLowerCase();
  const body = normalized.split('*').map(escapeRegExp).join('\\S*');
  return `(?:^| )${body}(?= |$)`;
}

const COMPILED = new Map(
  STEPS.map(([name, keywords]) => [
    name,
    new RegExp(keywords.map(keywordToPattern).join('|')),
  ]),
);

// Devolve a intenção do texto ou null. A primeira categoria da lista de
// prioridade que casar vence.
export function detectIntent(text) {
  const normalized = normalizeText(text);

  if (normalized === '') {
    return null;
  }

  for (const [name] of STEPS) {
    if (COMPILED.get(name).test(normalized)) {
      return name;
    }
  }

  return null;
}
