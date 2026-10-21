// Conteúdo do bot de FAQ/autoatendimento enviado pelo WhatsApp.
//
// ATENÇÃO: o bot responde a qualquer contato assim que a API está configurada.
// Os textos marcados com [PREENCHER] precisam ser substituídos por
// informações aprovadas pela clínica antes de o número receber pacientes
// reais. Não incluir orientação clínica, diagnóstico ou preços individuais
// (ver docs/INFOBIP_AUTOMATIONS.md, AUT-03).
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
          title: 'Agendar ou remarcar',
          description: 'A equipe confirma a disponibilidade com você',
        },
        {
          id: 'menu_paciente_novo',
          title: 'Sou paciente novo',
          description: 'Primeiro contato com a clínica',
        },
        {
          id: 'menu_atendente',
          title: 'Falar com a equipe',
          description: 'Atendimento com uma pessoa da nossa equipe',
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
  faq_horarios: '🕒 Horários de atendimento\n\n[PREENCHER: dias e horários aprovados pela clínica]',
  faq_convenios: '💳 Convênios e pagamento\n\n[PREENCHER: convênios aceitos e formas de pagamento aprovados pela clínica]',
  faq_localizacao: '📍 Localização\n\n[PREENCHER: endereço completo e referência aprovados pela clínica]',
  faq_servicos: '🩺 Serviços\n\n[PREENCHER: lista de serviços aprovada pela clínica]',
};

// Opções que encaminham para a equipe humana. Depois delas o bot fica em
// silêncio para o contato por 12 h (HANDOFF_SILENCE_HOURS em
// src/services/faqBot.js) até ele pedir o menu.
const handoffReplies = {
  menu_agendar: 'Certo! Para agendar ou remarcar, envie por aqui o melhor dia e período para você. '
    + 'Nossa equipe vai confirmar a disponibilidade em breve.\n\n'
    + 'Para voltar ao menu, envie MENU.',
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
