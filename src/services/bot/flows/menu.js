// Fluxo `menu` (T13): menu principal do bot (seção 6.2 de plan.md).
//
// Contrato: { name, start(ctx, input?), handle(ctx, input) } (seção 3.3 de
// plan-backlog.md). Uma lista só, 7 linhas, títulos de até 24 caracteres.
//
// Ids das linhas: `menu:main|<valor>`; botões comuns: `menu:main|show`
// (Voltar ao menu) e `menu:main|human` (Falar com a equipe).
//
// Roteamento:
//   booking          -> next booking/choose_service
//   my_appointments  -> next my_appointments/start
//   services, insurance, hours_address, first_visit
//                    -> next faq/<tópico> (faq.start lê `ctx.state.step`)
//   human            -> handoff patient_request
//   show             -> mostra o menu
// Texto livre (start e handle) com intenção conhecida é encaminhado:
//   book -> booking; my_appointments/reschedule/cancel -> my_appointments;
//   prices -> faq/services; insurance -> faq/insurance;
//   address/hours -> faq/hours_address; menu -> mostra o menu.
// Qualquer outra entrada em `handle` mostra o menu de novo com
// `misunderstood: true`; `start` sem intenção conhecida só mostra o menu.

export const MENU_STEP = 'main';

export const MENU_ROWS = Object.freeze([
  { value: 'booking', title: 'Agendar consulta', description: 'Escolha serviço, dia e horário' },
  { value: 'my_appointments', title: 'Minhas consultas', description: 'Ver, remarcar ou cancelar' },
  { value: 'services', title: 'Serviços e valores', description: 'O que oferecemos e quanto custa' },
  { value: 'insurance', title: 'Convênios aceitos', description: 'Planos atendidos pela clínica' },
  { value: 'hours_address', title: 'Horários e endereço', description: 'Quando atendemos e onde fica' },
  { value: 'first_visit', title: 'Primeira consulta', description: 'O que levar e como funciona' },
  { value: 'human', title: 'Falar com a equipe', description: 'Atendimento humano' },
]);

const FAQ_VALUES = new Set(['services', 'insurance', 'hours_address', 'first_visit']);

const INTENT_ROUTES = Object.freeze({
  book: { flow: 'booking', step: 'choose_service' },
  my_appointments: { flow: 'my_appointments', step: 'start' },
  reschedule: { flow: 'my_appointments', step: 'start' },
  cancel: { flow: 'my_appointments', step: 'start' },
  prices: { flow: 'faq', step: 'services' },
  insurance: { flow: 'faq', step: 'insurance' },
  address: { flow: 'faq', step: 'hours_address' },
  hours: { flow: 'faq', step: 'hours_address' },
});

const route = ({ flow, step }) => ({ replies: [], next: { flow, step, context: {} }, events: [] });

/** Monta a resposta do menu (lista). `misunderstood` troca a saudação pelo aviso. */
export function menuReply(ctx, { misunderstood = false } = {}) {
  const name = ctx?.patient?.firstName;
  const lead = misunderstood ? 'Não entendi sua mensagem. ' : (name ? `Olá, ${name}! ` : 'Olá! ');
  return {
    type: 'list',
    body: `${lead}Aqui é o atendimento da PhysioVilas. Toque em "Ver opções" e escolha o assunto.`,
    buttonTitle: 'Ver opções',
    sections: [{
      title: 'Atendimento',
      rows: MENU_ROWS.map((row) => ({
        id: `menu:${MENU_STEP}|${row.value}`,
        title: row.title,
        description: row.description,
      })),
    }],
  };
}

function showMenu(ctx, { misunderstood = false } = {}) {
  return {
    replies: [menuReply(ctx, { misunderstood })],
    next: { flow: 'menu', step: MENU_STEP, context: {} },
    events: [{ stepKey: 'menu:show' }],
    ...(misunderstood ? { misunderstood: true } : {}),
  };
}

export const menuFlow = {
  name: 'menu',

  async start(ctx, input) {
    if (input?.kind === 'text' && INTENT_ROUTES[input.intent]) {
      return route(INTENT_ROUTES[input.intent]);
    }
    return showMenu(ctx);
  },

  async handle(ctx, input) {
    const value = input?.reply?.flow === 'menu' ? input.reply.value : null;
    if (value === 'show') {
      return showMenu(ctx);
    }
    if (value === 'human') {
      return { replies: [], next: null, handoff: { reason: 'patient_request' }, events: [] };
    }
    if (value === 'booking') {
      return route({ flow: 'booking', step: 'choose_service' });
    }
    if (value === 'my_appointments') {
      return route({ flow: 'my_appointments', step: 'start' });
    }
    if (FAQ_VALUES.has(value)) {
      return route({ flow: 'faq', step: value });
    }
    if (input?.kind === 'text') {
      if (INTENT_ROUTES[input.intent]) {
        return route(INTENT_ROUTES[input.intent]);
      }
      return showMenu(ctx, { misunderstood: input.intent !== 'menu' });
    }
    return showMenu(ctx, { misunderstood: true });
  },
};

export default menuFlow;
