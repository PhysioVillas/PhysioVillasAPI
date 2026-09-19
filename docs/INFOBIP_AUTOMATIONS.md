# Pacote de configuração das automações Infobip

**Estado:** preparado localmente; nenhuma automação, template, subscription ou
envio foi criado por este documento.

Este arquivo transforma `AUT-01` a `AUT-04` em uma configuração reproduzível
na plataforma. Os fluxos continuam fora do código do ChatManager: este projeto
só recebe os eventos e valida mensagens sem envio enquanto não houver uma
autorização específica para disparos reais.

## Evidência de inventário — 2026-09-19

Na área WhatsApp da conta Infobip foi feita uma busca por `physio` nos modelos
de mensagem: o resultado foi **zero**. A listagem contém modelos de demonstração
da própria Infobip, inclusive um lembrete em inglês, mas nenhum foi associado
ao projeto ou adotado como template da clínica.

Portanto, `AUT-01` permanece pendente de cadastrar modelos em português do
Brasil e de receber a aprovação da Meta/Infobip. Não usar o sandbox nem os
modelos de demonstração como evidência de aprovação para produção.

Na tentativa de cadastro em 2026-09-19, o portal exibiu o remetente de teste
`447860088970` como **Ativado**, **Conectado** e com limite "Ilimitado". Porém,
ao iniciar `Registrar modelo → Criar novo modelo`, a seleção de remetente
retornou **"Nenhum remetente disponível"**. Logo, esse remetente de teste não
está elegível para registrar modelos nessa área da conta. Nenhum template foi
submetido, enviado ou agendado. O próximo desbloqueio técnico é vincular um
remetente/WABA elegível para templates; não cadastrar outro remetente sem
decisão operacional da clínica.

## AUT-01 — modelos a cadastrar

| Nome sugerido | Categoria | Idioma | Variáveis | Finalidade |
|---|---|---|---|---|
| `physiovilas_appointment_confirmation_v1` | Utility | `pt_BR` | nome, data, horário | Confirmação de consulta já agendada |
| `physiovilas_appointment_reminder_v1` | Utility | `pt_BR` | nome, data, horário | Lembrete de consulta futura |
| `physiovilas_service_update_v1` | Utility | `pt_BR` | nome, assunto | Retorno administrativo solicitado pelo paciente |

Texto-base para revisão da clínica e adequação final às políticas:

- Confirmação: “Olá, {{1}}. Sua consulta está agendada para {{2}}, às {{3}}.
  Se precisar falar com a equipe, responda a esta mensagem.”
- Lembrete: “Olá, {{1}}. Lembramos sua consulta em {{2}}, às {{3}}. Para
  confirmar ou pedir ajuda, responda a esta mensagem.”
- Retorno administrativo: “Olá, {{1}}. Temos uma atualização sobre {{2}}.
  Responda a esta mensagem para falar com nossa equipe.”

Antes de submeter, a clínica deve revisar o texto, o nome comercial exibido, o
motivo de cada variável e se há orientação legal/operacional aplicável. Não
incluir diagnóstico, resultado clínico ou outro dado de saúde no template.

**Critério de aceite:** os três modelos aparecem como aprovados, com categoria
e idioma corretos, e a versão/ID resultante é registrada em configuração
privada — nunca no repositório.

## AUT-02 — triagem

Os protótipos anteriores do PhysioVilas foram usados como referência funcional
em 2026-09-19. Eles inspiram o menu abaixo, mas não são fonte de horários,
endereço, convênios, disponibilidade ou conduta clínica. Esses conteúdos só
entram no Flow depois de revisão explícita da clínica.

Fluxo inicial proposto para configurar na Infobip:

1. Mensagem de boas-vindas com aviso de que o canal é administrativo e opção
   de encerrar a conversa.
2. Menu principal: `1. Agendar ou remarcar`, `2. Dúvidas frequentes`,
   `3. Sou novo`, `4. Falar com a equipe`.
3. `1. Agendar ou remarcar` informa que a equipe confirmará a disponibilidade;
   enquanto não existir uma integração aprovada com a agenda da clínica, não
   promete horário nem registra consulta automaticamente.
4. `3. Sou novo` coleta, no máximo, nome e o motivo administrativo do contato
   (por exemplo, `quero marcar uma avaliação`) e encaminha para a equipe. Não
   coleta queixa, histórico ou outro dado de saúde pelo fluxo automático.
5. `4. Falar com a equipe`, qualquer pergunta clínica, urgência ou resposta
   fora do menu segue para a equipe humana; o fluxo não presta orientação
   clínica.
6. Fora do horário validado pela clínica, o fluxo oferece deixar um pedido de
   retorno, sem prometer prazo. Dentro do horário, a conversa é encaminhada.

**Teste de aceite:** cada opção chega ao destino esperado, a opção humana não
fica presa no menu e nenhum dado além do necessário é coletado.

## AUT-03 — FAQ

O menu de dúvidas terá, inicialmente, tópicos institucionais: `horários`,
`convênios`, `localização` e `serviços`. Cada resposta deve ser aprovada pela
clínica antes da publicação; as imagens e o simulador antigo não comprovam que
as informações neles contidas ainda são verdadeiras.

Perguntas sobre diagnóstico, tratamento, preço individual, disponibilidade ou
urgência devem ser encaminhadas à equipe humana. A opção `voltar ao menu`
continua disponível após cada resposta.

**Teste de aceite:** respostas aprovadas aparecem para perguntas previstas;
perguntas não previstas e clínicas recebem o encaminhamento humano, sem
resposta inventada.

## AUT-04 — lembrete de consulta

Pré-requisitos técnicos: `physiovilas_appointment_reminder_v1` aprovado,
contrato de template da Messages API confirmado e envio real autorizado. O
backend já valida localmente o campo `sendAt`, mas ainda não possui endpoint de
envio e não deve programar mensagens sem autorização específica.

O protótipo anterior propõe lembretes em `24 h` e `2 h` antes da consulta. Essa
é a cadência candidata, não uma automação ativa: só poderá ser habilitada depois
de existir uma agenda integrada ou uma fonte confiável de consultas, a política
operacional da clínica e os templates aprovados. Cada disparo continuará
dependendo das regras vigentes do WhatsApp e da autorização de envio.

**Teste de aceite:** em um contato de teste que consentiu, o lembrete chega no
horário programado; a resposta e os relatórios de entrega são persistidos sem
duplicação.

## Registro de execução na plataforma

Quando houver uma rodada de configuração autorizada, registrar apenas:

| Item | Situação | Evidência segura |
|---|---|---|
| Templates | Pendente | nome, idioma, categoria e estado de aprovação; sem IDs ou conteúdo de pacientes |
| Triagem | Pendente | opções do menu e resultado do teste com contato de teste |
| FAQ | Pendente | tópicos aprovados e resultado do encaminhamento humano |
| Lembrete | Pendente | horário de teste, status de entrega e confirmação do contato de teste |

## Conciliação com os protótipos anteriores

| Ideia dos protótipos | Decisão no ChatManager atual |
|---|---|
| Menu WhatsApp com agendamento, FAQ, novo paciente e atendente | Mantido como menu 1–4, configurado em um Flow Infobip |
| Roteador, FAQ e triagem no backend | Não adotado: a Infobip executa o fluxo; o backend só recebe/persiste eventos e validará mensagens antes de qualquer envio |
| Coleta de nome, queixa e histórico | Reduzida a contato administrativo mínimo e encaminhamento humano; não automatizar coleta de dados clínicos |
| Confirmação de horário e agenda automática | Pendente de uma integração de agenda explicitamente escolhida e autorizada pela clínica |
| Lembretes 24 h e 2 h | Mantidos como regra de negócio candidata, bloqueados até templates, agenda e teste controlado |
| Integrações antigas sugeridas (API WhatsApp própria, calendário, cron) | Não adotadas nesta sprint; o provedor definido é a Infobip e nenhum job externo será criado sem decisão específica |

O diagrama funcional vigente é: `Paciente → Flow Infobip → webhook protegido →
ChatManager → Neon`. O retorno automático ao paciente e qualquer lembrete só
entra depois de validação do contrato da Messages API e de autorização de
disparo. Assim, o fluxo continua útil para recepção, mas não toma decisões
clínicas, nem usa o material antigo como dado operacional da clínica.
