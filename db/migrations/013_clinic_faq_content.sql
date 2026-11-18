-- 013: conteudo mock do FAQ da clinica (POC, T09).
--
-- Textos FICTICIOS para a demonstracao a investidores; nada aqui e dado real
-- da clinica. Roda dentro da guarda de schema (sem clinica_simulada nao faz
-- nada). Idempotente: upsert por slug (faq_entries_slug_key). Nenhuma coluna
-- e renomeada ou removida; as entradas antigas '[SIMULACAO]' (slug
-- sim_servico_<id>) sao arquivadas, nao apagadas, para preservar o historico
-- visto em bi_simulado.d_faq.
-- Servicos: 1 Pilates, 2 Fisioterapia ambulatorial, 3 RPG, 4 Massagem,
-- 5 Fisioterapia pelvica.

do $$
begin
  if to_regnamespace('clinica_simulada') is not null then

    update clinica_simulada.faq_entries
       set status = 'archived', updated_at = now()
     where slug like 'sim\_servico\_%' and status <> 'archived';

    insert into clinica_simulada.faq_entries (slug, question, answer, status, reviewed_at)
    values
      ('endereco', 'Onde fica a clínica?',
       E'Endereço FICTÍCIO (demonstração): Rua das Acácias, 123 - Bairro Exemplo, Cidade Modelo/UF. Fica a duas quadras da Praça Fictícia e há estacionamento conveniado ao lado.',
       'published', now()),
      ('o_que_levar', 'O que levar para a consulta?',
       E'Traga um documento com foto, a carteirinha do convênio (se for usar) e exames ou laudos recentes relacionados ao seu caso. Use roupas confortáveis que permitam movimentar o corpo. Chegue 10 minutos antes do horário.',
       'published', now()),
      ('primeira_consulta', 'Como funciona a primeira consulta?',
       E'A primeira consulta dura cerca de 60 minutos. O fisioterapeuta faz uma avaliação completa, ouve sua queixa, examina a região e define o plano de tratamento com você. Dependendo do caso, o atendimento já pode começar no mesmo dia.',
       'published', now()),
      ('politica_cancelamento', 'Qual é a política de cancelamento e remarcação?',
       E'Você pode cancelar ou remarcar sem custo com pelo menos 24 horas de antecedência. Com menos de 24 horas, a alteração é feita com a nossa equipe de atendimento e a sessão pode ser cobrada. Faltas sem aviso também podem ser cobradas.',
       'published', now()),
      ('formas_pagamento', 'Quais são as formas de pagamento?',
       E'Aceitamos PIX, cartão de débito e de crédito, e dinheiro. Há valor avulso por sessão, pacotes com desconto e mensalidade (Pilates). A cobrança é feita na recepção; pagamentos pelo WhatsApp são tratados pela nossa equipe.',
       'published', now()),
      ('convenios', 'Quais convênios vocês atendem?',
       E'Atendemos os convênios A, B, C, D e E (nomes fictícios da demonstração). A cobertura depende do seu plano e pode exigir guia de autorização. Confirme com a nossa equipe antes da primeira sessão.',
       'published', now()),
      ('sobre_servico_1', 'Como funciona o Pilates?',
       E'O Pilates é feito em turmas pequenas, com até 4 alunos por horário, e aulas de 60 minutos com acompanhamento do profissional. Trabalha força, postura e flexibilidade. O plano é por mensalidade.',
       'published', now()),
      ('sobre_servico_2', 'Como funciona a Fisioterapia ambulatorial?',
       E'Atendimento de 60 minutos para dores, lesões e recuperação pós-cirúrgica ou pós-trauma, com plano de tratamento individual. Pode ser particular (avulso ou pacote) ou por convênio.',
       'published', now()),
      ('sobre_servico_3', 'Como funciona o RPG?',
       E'A Reeducação Postural Global é uma sessão individual de 60 minutos, com alongamentos e posturas guiadas pelo fisioterapeuta, indicada para dores na coluna e desvios posturais.',
       'published', now()),
      ('sobre_servico_4', 'Como funciona a Massagem?',
       E'Sessão individual de 60 minutos de massagem terapêutica e relaxante, para aliviar tensões musculares e o estresse. É um atendimento particular, sem cobertura de convênio.',
       'published', now()),
      ('sobre_servico_5', 'Como funciona a Fisioterapia pélvica?',
       E'Atendimento individual e reservado de 60 minutos, com fisioterapeuta especializada, para incontinência, dores pélvicas e preparo ou recuperação do parto. A avaliação respeita sua privacidade e conforto.',
       'published', now())
    on conflict (slug) do update
      set question = excluded.question,
          answer = excluded.answer,
          status = 'published',
          reviewed_at = now(),
          updated_at = now();

    -- Pacientes de demonstracao da 011: o bot cumprimenta pelo primeiro nome,
    -- entao "Demo Ana Teste" viraria "Ola, Demo". Ajusta para "Ana Teste" etc.
    -- (mesmos CPFs ficticios fixos; ids 2680-2684 em production).
    update clinica_simulada.d_pacientes p
       set paciente = v.nome
      from (values
        ('80590844296', 'Ana Teste'),
        ('78836009581', 'Bruno Teste'),
        ('77081174884', 'Carla Teste'),
        ('75326340194', 'Diego Teste'),
        ('73571505425', 'Elisa Teste')
      ) as v(cpf, nome)
     where p.cpf = v.cpf
       and p.paciente is distinct from v.nome;

  end if;
end $$;
