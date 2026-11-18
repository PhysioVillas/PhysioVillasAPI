-- 015: convenios e endereco da clinica para a demonstracao (POC, 2026-11-18).
--
-- Pedido do usuario: os convenios aceitos passam a ser Amil, Bradesco Saude,
-- SulAmerica, Cassi, Postal Saude, Mediservice, Saude Caixa e Petrobras (AMS),
-- e o endereco passa a ser R. Itagi, 25 - Belo Horizonte, Lauro de Freitas -
-- BA, 42700-000.
--
-- Os convenios 1-5 ('Convenio A' a 'E') sao referenciados por agendamentos,
-- contratos e faturamento simulados, entao NAO sao apagados: recebem os
-- cinco primeiros nomes (o historico simulado passa a aparecer com eles no
-- Power BI). Os ids 6-8 sao novos, com prazos e valores por sessao na mesma
-- faixa dos existentes. Nenhuma coluna e renomeada ou removida.
-- Idempotente; roda dentro da guarda de schema.

do $$
begin
  if to_regnamespace('clinica_simulada') is not null then

    insert into clinica_simulada.d_convenios
      (convenio_id, convenio, prazo_pagamento_dias,
       valor_sessao_fisioterapia, valor_sessao_rpg, valor_sessao_pelvica)
    values
      (1, 'Amil',            30, 42.00, 58.80, 67.20),
      (2, 'Bradesco Saúde',  45, 48.00, 67.20, 76.80),
      (3, 'SulAmérica',      60, 55.00, 77.00, 88.00),
      (4, 'Cassi',           30, 36.00, 50.40, 57.60),
      (5, 'Postal Saúde',    90, 32.00, 44.80, 51.20),
      (6, 'Mediservice',     45, 50.00, 70.00, 80.00),
      (7, 'Saúde Caixa',     30, 40.00, 56.00, 64.00),
      (8, 'Petrobras (AMS)', 60, 52.00, 72.80, 83.20)
    on conflict (convenio_id) do update
      set convenio = excluded.convenio
    where clinica_simulada.d_convenios.convenio is distinct from excluded.convenio;

    update clinica_simulada.faq_entries
       set answer = E'Nosso endereço é R. Itagi, 25 - Belo Horizonte, Lauro de Freitas - BA, 42700-000.',
           updated_at = now()
     where slug = 'endereco'
       and answer is distinct from E'Nosso endereço é R. Itagi, 25 - Belo Horizonte, Lauro de Freitas - BA, 42700-000.';

    update clinica_simulada.faq_entries
       set answer = E'Atendemos Amil, Bradesco Saúde, SulAmérica, Cassi, Postal Saúde, Mediservice, Saúde Caixa e Petrobras (AMS). A cobertura depende do seu plano e pode exigir guia de autorização. Confirme com a nossa equipe antes da primeira sessão.',
           updated_at = now()
     where slug = 'convenios'
       and answer is distinct from E'Atendemos Amil, Bradesco Saúde, SulAmérica, Cassi, Postal Saúde, Mediservice, Saúde Caixa e Petrobras (AMS). A cobertura depende do seu plano e pode exigir guia de autorização. Confirme com a nossa equipe antes da primeira sessão.';

  end if;
end $$;
