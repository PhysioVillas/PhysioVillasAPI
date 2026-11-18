// Fluxo `triage` (T16): cadastro de paciente novo antes do agendamento.
//
// Etapas: choose_service -> choose_payment (-> choose_insurance, só em
// Convênio) -> ask_origin -> ask_name -> ask_cpf. Ids das linhas e botões:
// `triage:service|<id>`, `triage:payment|<chave>`, `triage:insurance|<id>`,
// `triage:origin|<chave>`.
//
// Contexto (`next.context`) durante a triagem:
//   serviceId, payment {method, insuranceId}, channel (canal de origem),
//   name (só entre ask_name e o cadastro; sai do contexto ao criar o paciente),
//   leadId. O CPF nunca entra em contexto, resposta, evento ou log.
// Fim: next = { flow:'booking', step:'choose_day',
//   context:{ serviceId, payment, patient:{id, firstName}, newPatient:true } }.
//
// Interação com o engine: o engine trata `detectIntent(texto)` igual a
// clinical/urgency/human/payment/document ANTES de chamar qualquer fluxo e
// abre handoff. Logo, texto com "dor", "lesão" etc. não chega aqui. O desvio
// de sintomas deste fluxo (detectIntent + lista própria de palavras) é só
// uma rede de segurança para termos que o engine não intercepta e não gera
// handoff: responde que a avaliação cuida disso e repete a pergunta.

import { findCpfInText, isValidCpf, normalizeCpf } from '../cpf.js';
import { detectIntent } from '../intents.js';
import { LEAD_STAGES } from '../../clinic/patientRepository.js';

const FLOW = 'triage';
const NAME_MIN = 2;
const NAME_MAX = 80;
const NAME_PATTERN = /^\p{L}[\p{L}\p{M}'.\- ]*$/u;
const DEFAULT_CPF_MAX_ATTEMPTS = 3;

export const ORIGINS = Object.freeze([
  { value: 'instagram', title: 'Instagram', channel: 'Instagram' },
  { value: 'google', title: 'Google', channel: 'Google' },
  { value: 'indicacao', title: 'Indicação', channel: 'Indicação' },
  { value: 'medico', title: 'Encaminhamento médico', channel: 'Médico' },
  { value: 'outro', title: 'Outro', channel: 'Outro' },
]);

const PAYMENT_OPTIONS = Object.freeze({
  convenio: { method: 'Convênio', title: 'Convênio' },
  avulso: { method: 'Particular avulso', title: 'Particular avulso' },
  pacote: { method: 'Pacote particular', title: 'Pacote particular' },
  mensalidade: { method: 'Mensalidade', title: 'Mensalidade' },
});

const STEP_IDS = Object.freeze({
  choose_service: 'service',
  choose_payment: 'payment',
  choose_insurance: 'insurance',
  ask_origin: 'origin',
});

const SYMPTOM_WORDS = new Set([
  'dor', 'dores', 'doi', 'doendo', 'sintoma', 'sintomas', 'lesao', 'lesoes',
  'machucado', 'machuquei', 'inchaco', 'formigamento', 'tendinite', 'hernia',
  'fratura', 'cirurgia', 'torcicolo', 'lombalgia',
]);

export const TRIAGE_TEXTS = Object.freeze({
  intro: 'Vamos fazer seu primeiro cadastro, é rápido.',
  chooseService: 'Qual serviço você quer agendar?',
  choosePayment: 'Como você pretende pagar?',
  chooseInsurance: 'Qual é o seu convênio?',
  askOrigin: 'Como você conheceu a clínica?',
  askName: 'Qual é o seu nome completo?',
  askCpf: 'Para finalizar o cadastro, informe seu CPF (somente números ou no formato 000.000.000-00).',
  invalidName: 'Não consegui entender o nome. Envie seu nome completo, só com letras.',
  invalidCpf: 'Esse CPF não parece válido. Confira e envie novamente.',
  symptoms: 'Entendi. Quem cuida disso é a avaliação com a nossa equipe, então por aqui eu só preciso '
    + 'dos dados do cadastro.',
  identified: 'Cadastro confirmado! Agora vamos escolher o dia da sua consulta.',
  useButtons: 'Escolha uma das opções para continuar.',
  singlePayment: (title) => `Para este serviço o pagamento é ${title}.`,
});

function stripAccents(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function mentionsSymptoms(text) {
  if (typeof text !== 'string') return false;
  if (detectIntent(text) === 'clinical') return true;
  return stripAccents(text).split(/[^a-z]+/).some((word) => SYMPTOM_WORDS.has(word));
}

function paymentKeysFor(service, hasInsurance) {
  const name = stripAccents(service?.name);
  if (name.includes('pilates')) return ['mensalidade'];
  if (name.includes('massagem')) return ['avulso'];
  return hasInsurance ? ['convenio', 'avulso', 'pacote'] : ['avulso', 'pacote'];
}

function sameId(a, b) {
  return a !== undefined && a !== null && b !== undefined && b !== null && Number(a) === Number(b);
}

function cleanName(text) {
  const name = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX || !NAME_PATTERN.test(name)) return null;
  return name;
}

function text(value) {
  return { type: 'text', text: value };
}

function ask(step, context, replies, { cpfAttempts, misunderstood } = {}) {
  return {
    replies,
    next: { flow: FLOW, step, context, ...(cpfAttempts !== undefined ? { cpfAttempts } : {}) },
    events: [{ stepKey: `${FLOW}:${step}` }],
    ...(misunderstood ? { misunderstood: true } : {}),
  };
}

function flagged(result) {
  return { ...result, misunderstood: true };
}

function baseContext(ctx) {
  const source = ctx.state?.context ?? {};
  const context = {};
  for (const key of ['serviceId', 'payment', 'channel', 'name', 'leadId']) {
    if (source[key] !== undefined && source[key] !== null) context[key] = source[key];
  }
  return context;
}

async function trackLead(ctx, context, extra = {}) {
  try {
    const saved = await ctx.repos.patients.upsertLead({
      waId: ctx.waId,
      stage: LEAD_STAGES.service,
      channel: context.channel,
      serviceInterestId: context.serviceId,
      outsideBusinessHours: !ctx.inBusinessHours,
      ...extra,
    });
    if (saved?.leadId !== undefined && saved?.leadId !== null) context.leadId = saved.leadId;
  } catch {
    // Falha de lead não derruba o fluxo; nada é logado (PII).
  }
}

function askService(context, services, prefix) {
  const clean = { ...context };
  delete clean.serviceId;
  return ask('choose_service', clean, [
    ...(prefix ? [text(prefix)] : []),
    {
      type: 'list',
      body: TRIAGE_TEXTS.chooseService,
      buttonTitle: 'Ver serviços',
      sections: [{
        title: 'Serviços',
        rows: services.map((s) => ({ id: `${FLOW}:service|${s.id}`, title: s.name })),
      }],
    },
  ]);
}

async function askPayment(ctx, context, prefix) {
  const services = await ctx.repos.catalog.listServices();
  const service = services.find((s) => sameId(s.id, context.serviceId));
  if (!service) return askService(context, services, prefix);
  const plans = await ctx.repos.catalog.listInsurancePlans();
  const keys = paymentKeysFor(service, plans.length > 0);
  if (keys.length === 1) {
    const option = PAYMENT_OPTIONS[keys[0]];
    const next = { ...context, payment: { method: option.method, insuranceId: null } };
    await trackLead(ctx, next);
    return askOrigin(next, [prefix, TRIAGE_TEXTS.singlePayment(option.title)].filter(Boolean).join(' '));
  }
  return ask('choose_payment', context, [
    ...(prefix ? [text(prefix)] : []),
    {
      type: 'buttons',
      body: TRIAGE_TEXTS.choosePayment,
      buttons: keys.map((key) => ({ id: `${FLOW}:payment|${key}`, title: PAYMENT_OPTIONS[key].title })),
    },
  ]);
}

async function askInsurance(ctx, context) {
  const plans = await ctx.repos.catalog.listInsurancePlans();
  return ask('choose_insurance', context, [{
    type: 'list',
    body: TRIAGE_TEXTS.chooseInsurance,
    buttonTitle: 'Ver convênios',
    sections: [{
      title: 'Convênios',
      rows: plans.map((p) => ({ id: `${FLOW}:insurance|${p.id}`, title: p.name })),
    }],
  }]);
}

function askOrigin(context, prefix) {
  return ask('ask_origin', context, [
    ...(prefix ? [text(prefix)] : []),
    {
      type: 'list',
      body: TRIAGE_TEXTS.askOrigin,
      buttonTitle: 'Ver opções',
      sections: [{
        title: 'Origem',
        rows: ORIGINS.map((o) => ({ id: `${FLOW}:origin|${o.value}`, title: o.title })),
      }],
    },
  ]);
}

function askName(context, prefix) {
  return ask('ask_name', context, [text([prefix, TRIAGE_TEXTS.askName].filter(Boolean).join('\n\n'))]);
}

function askCpf(context, prefix, cpfAttempts) {
  return ask('ask_cpf', context, [text([prefix, TRIAGE_TEXTS.askCpf].filter(Boolean).join('\n\n'))], { cpfAttempts });
}

// Repete a pergunta da etapa atual.
async function repeat(ctx, step, context, prefix) {
  switch (step) {
    case 'choose_service': return askService(context, await ctx.repos.catalog.listServices(), prefix);
    case 'choose_payment': return askPayment(ctx, context, prefix);
    case 'choose_insurance': return askInsurance(ctx, context);
    case 'ask_origin': return askOrigin(context, prefix);
    case 'ask_name': return askName(context, prefix);
    default: return askCpf(context, prefix, ctx.state?.cpfAttempts ?? 0);
  }
}

async function start(ctx) {
  const context = baseContext(ctx);
  const step = ctx.state?.step;
  if (step && step !== 'choose_service') {
    return repeat(ctx, step, context);
  }
  await trackLead(ctx, context);
  if (context.serviceId !== undefined) {
    return askPayment(ctx, context, TRIAGE_TEXTS.intro);
  }
  return askService(context, await ctx.repos.catalog.listServices(), TRIAGE_TEXTS.intro);
}

async function handleCpf(ctx, input, context) {
  const attempts = ctx.state?.cpfAttempts ?? 0;
  const max = Number(ctx.config?.cpfMaxAttempts ?? DEFAULT_CPF_MAX_ATTEMPTS);
  const raw = input.kind === 'text' ? input.text : null;
  const digits = normalizeCpf(raw) ?? findCpfInText(raw)?.digits ?? null;

  if (!digits || !isValidCpf(digits)) {
    if (raw && !/\d/.test(raw) && mentionsSymptoms(raw)) {
      return askCpf(context, TRIAGE_TEXTS.symptoms, attempts);
    }
    const used = attempts + 1;
    if (used >= max) {
      return { replies: [], next: null, handoff: { reason: 'identity_failure' }, events: [{ stepKey: `${FLOW}:ask_cpf` }] };
    }
    return askCpf(context, TRIAGE_TEXTS.invalidCpf, used);
  }

  const patients = ctx.repos.patients;
  let patient = await patients.findPatientByCpf(digits);
  if (!patient) {
    try {
      const created = await patients.createPatient({
        name: context.name,
        cpf: digits,
        channel: context.channel,
        waId: ctx.waId,
        leadId: context.leadId,
      });
      patient = { id: created.id, firstName: String(context.name).split(' ')[0] };
    } catch (error) {
      if (error?.code !== 'cpf_exists') throw error;
      patient = await patients.findPatientByCpf(digits);
      if (!patient) throw error;
    }
  }
  await patients.linkContact({ waId: ctx.waId, patientId: patient.id, leadId: context.leadId ?? null });
  await trackLead(ctx, context, { patientId: patient.id });
  // Mesma resposta para CPF novo e já cadastrado: nada é revelado.
  return {
    replies: [text(TRIAGE_TEXTS.identified)],
    next: {
      flow: 'booking',
      step: 'choose_day',
      context: {
        serviceId: context.serviceId,
        payment: context.payment,
        patient: { id: patient.id, firstName: patient.firstName },
        newPatient: true,
      },
    },
    events: [{ stepKey: `${FLOW}:ask_cpf` }],
  };
}

async function handle(ctx, input) {
  const step = ctx.state?.step ?? 'choose_service';
  const context = baseContext(ctx);

  if (step === 'ask_cpf') return handleCpf(ctx, input, context);

  if (step === 'ask_name') {
    if (input.kind !== 'text') return flagged(askName(context, TRIAGE_TEXTS.invalidName));
    if (mentionsSymptoms(input.text)) return askName(context, TRIAGE_TEXTS.symptoms);
    const name = cleanName(input.text);
    if (!name) return flagged(askName(context, TRIAGE_TEXTS.invalidName));
    const next = { ...context, name };
    await trackLead(ctx, next);
    return askCpf(next, null, 0);
  }

  if (input.kind === 'text' && mentionsSymptoms(input.text)) {
    return repeat(ctx, step, context, TRIAGE_TEXTS.symptoms);
  }
  const reply = input.reply;
  if (input.kind === 'text' || reply?.flow !== FLOW || reply.step !== STEP_IDS[step]) {
    return flagged(await repeat(ctx, step, context, TRIAGE_TEXTS.useButtons));
  }
  const invalid = async () => flagged(await repeat(ctx, step, context, TRIAGE_TEXTS.useButtons));
  const value = reply.value;

  if (step === 'choose_service') {
    const service = (await ctx.repos.catalog.listServices()).find((s) => String(s.id) === value);
    if (!service) return invalid();
    const next = { ...context, serviceId: service.id };
    await trackLead(ctx, next);
    return askPayment(ctx, next);
  }

  if (step === 'choose_payment') {
    const services = await ctx.repos.catalog.listServices();
    const service = services.find((s) => sameId(s.id, context.serviceId));
    const plans = await ctx.repos.catalog.listInsurancePlans();
    const allowed = service ? paymentKeysFor(service, plans.length > 0) : [];
    if (!allowed.includes(value)) return invalid();
    if (value === 'convenio') return askInsurance(ctx, context);
    const next = { ...context, payment: { method: PAYMENT_OPTIONS[value].method, insuranceId: null } };
    await trackLead(ctx, next);
    return askOrigin(next);
  }

  if (step === 'choose_insurance') {
    const plan = (await ctx.repos.catalog.listInsurancePlans()).find((p) => String(p.id) === value);
    if (!plan) return invalid();
    const next = { ...context, payment: { method: 'Convênio', insuranceId: plan.id } };
    await trackLead(ctx, next);
    return askOrigin(next);
  }

  // ask_origin
  const origin = ORIGINS.find((o) => o.value === value);
  if (!origin) return invalid();
  const next = { ...context, channel: origin.channel };
  await trackLead(ctx, next);
  return askName(next);
}

export const triageFlow = Object.freeze({ name: FLOW, start, handle });
export default triageFlow;
