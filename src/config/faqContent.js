// Conteúdo do bot de FAQ/autoatendimento enviado pelo WhatsApp.
//
// ATENÇÃO: o bot responde a qualquer contato assim que a API está configurada.
// Como endereço, horários, convênios e serviços ainda não foram confirmados
// aqui, as respostas encaminham a pessoa à equipe em vez de inventar dados.
// Não incluir orientação clínica, diagnóstico ou preços individuais.
//
// Limites do WhatsApp verificados em test/faqBot.test.js:
// título da linha <= 24, descrição <= 72, título de seção <= 24,
// botão da lista <= 20, título de botão <= 20 (sem emoji/markdown),
// no máximo 10 linhas na lista e 3 botões por mensagem.

const BUTTON_BACK_TO_MENU = 'btn_voltar_menu';
const BUTTON_TALK_TO_TEAM = 'btn_atendente';

// Texto livre que sempre devolve o menu, mesmo durante um atendimento humano.
const MENU_KEYWORDS = ['menu', 'menú', 'inicio', 'início'];

const mainMenu = {
  header: 'PhysioVilas',
  body: 'Olá! Este é o canal de atendimento da PhysioVilas. '
    + 'Toque em "Ver opções" e escolha o assunto. '
    + 'Para dúvidas sobre saúde ou urgências, fale com a nossa equipe.',
  footer: 'Atendimento automático',
  buttonTitle: 'Ver opções',
  sections: [
    {
      title: 'Atendimento',
      rows: [
        {
          id: 'menu_agendar',
          title: 'Agendar consulta',
          description: 'Escolha o serviço, profissional, dia e horário',
        },
        {
          id: 'menu_paciente_novo',
          title: 'Sou paciente novo',
          description: 'Primeiro contato com a clínica',
        },
        {
          id: 'menu_atendente',
          title: 'Falar com a equipe',
          description: 'Remarcações, cancelamentos e atendimento humano',
        },
      ],
    },
    {
      title: 'Dúvidas frequentes',
      rows: [
        {
          id: 'faq_horarios',
          title: 'Horários',
          description: 'Dias e horários de atendimento',
        },
        {
          id: 'faq_convenios',
          title: 'Convênios',
          description: 'Convênios aceitos e formas de pagamento',
        },
        {
          id: 'faq_localizacao',
          title: 'Localização',
          description: 'Endereço e como chegar',
        },
        {
          id: 'faq_servicos',
          title: 'Serviços',
          description: 'Tratamentos oferecidos pela clínica',
        },
      ],
    },
  ],
};

// Respostas das linhas de "Dúvidas frequentes": enviadas com os botões
// "Voltar ao menu" e "Falar com a equipe".
const faqAnswers = {
  faq_horarios: '🕒 Para consultar os próximos horários por serviço e profissional, volte ao menu e toque em "Agendar consulta". A equipe confirma seu pedido por aqui.',
  faq_convenios: '💳 Convênios e pagamento\n\nNossa equipe confirma os convênios aceitos e as formas de pagamento disponíveis. Toque em "Falar com a equipe".',
  faq_localizacao: '📍 Localização\n\nNossa equipe envia o endereço atualizado e orientações para chegar. Toque em "Falar com a equipe".',
  faq_servicos: '🩺 Para ver os serviços e profissionais da agenda, volte ao menu e toque em "Agendar consulta". Nossa equipe pode ajudar se você tiver dúvidas sobre o atendimento.',
};

// Opções que encaminham para a equipe humana. Depois delas o bot fica em
// silêncio para o contato por 12 h (HANDOFF_SILENCE_HOURS em
// src/services/faqBot.js) até ele pedir o menu.
const handoffReplies = {
  menu_agendar: 'A agenda automática está indisponível neste momento. Nossa equipe pode ajudar a escolher um horário por aqui.',
  menu_paciente_novo: 'Seja bem-vindo(a)! Envie seu nome e o motivo do contato '
    + '(por exemplo: "quero marcar uma avaliação"). Nossa equipe continua o atendimento por aqui.\n\n'
    + 'Para voltar ao menu, envie MENU.',
  menu_atendente: 'Certo! Uma pessoa da nossa equipe vai continuar o atendimento por aqui em breve.\n\n'
    + 'Para voltar ao menu, envie MENU.',
};

const answerButtons = [
  { id: BUTTON_BACK_TO_MENU, title: 'Voltar ao menu' },
  { id: BUTTON_TALK_TO_TEAM, title: 'Falar com a equipe' },
];

const answerFooter = 'PhysioVilas';

export {
  BUTTON_BACK_TO_MENU,
  BUTTON_TALK_TO_TEAM,
  MENU_KEYWORDS,
  answerButtons,
  answerFooter,
  faqAnswers,
  handoffReplies,
  mainMenu,
};
