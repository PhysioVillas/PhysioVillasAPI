# Roteiro da demonstração — chatbot da POC

> Para quem vai apresentar. Não precisa conhecer o código. Tudo aqui usa
> dados **fictícios** do schema `clinica_simulada` no Neon.
> Revisado em 2026-11-18.

## Antes de começar

1. **Deploy feito** na Vercel com a branch do chatbot, e migrations 010–014
   aplicadas no Neon (já estão desde 2026-11-18).
2. **Celular com o número de teste** que conversa com o WhatsApp da clínica.
3. **Power BI aberto** e conectado ao Neon (ver "Onde aparece no Power BI").
4. **Comece sempre do zero:** envie `MENU`. Isso fecha qualquer atendimento
   humano aberto e mostra o menu.

### Dados de demonstração

Pacientes já cadastrados (para "Minhas consultas"):

| Paciente | CPF |
|---|---|
| Ana Teste | 805.908.442-96 |
| Bruno Teste | 788.360.095-81 |
| Carla Teste | 770.811.748-84 |
| Diego Teste | 753.263.401-94 |
| Elisa Teste | 735.715.054-25 |

CPFs fictícios e válidos **ainda não cadastrados** (para "paciente novo").
Cada um só serve uma vez: depois do cadastro, ele vira paciente existente.

- 428.308.442-54
- 410.760.095-57
- 393.211.748-42
- 375.663.401-90

### Regras que aparecem na demonstração

- Remarcar ou cancelar exige **24 h** de antecedência; com menos, o bot
  chama a equipe.
- Atendimento humano: **08:00 às 18:00**, todos os dias. Fora disso, o bot
  avisa quando a equipe responde.
- Depois de chamar a equipe, o bot **fica calado por 12 h** naquele número.
  Para continuar a demonstração, envie `MENU`.
- O CPF digitado **não fica gravado** nas mensagens: aparece como
  `***.***.***-NN` no banco e no Power BI.

---

## Cena 1 — Dúvida de preço (FAQ)

1. Envie: `quanto custa o pilates?`
2. O bot responde com **Serviços e valores**: duração, vagas por horário,
   profissionais e preços em R$ de cada serviço.
3. Mostre os botões no fim: **Agendar**, **Voltar ao menu**, **Falar com a
   equipe**. Toque em **Voltar ao menu**.
4. Opcional: no menu, toque em **Convênios aceitos** ou **Horários e
   endereço** (inclui feriados dos próximos 30 dias).

**O que mostrar:** o bot entende texto livre e responde com dados do banco,
não com texto fixo.

## Cena 2 — Paciente novo marca uma consulta

1. Envie `MENU` e toque em **Agendar consulta**.
2. O bot ainda não sabe quem é você e começa o cadastro:
   - **Serviço:** escolha *Fisioterapia ambulatorial*.
   - **Pagamento:** escolha *Particular avulso*.
   - **Como conheceu a clínica:** escolha *Instagram*.
   - **Nome:** digite um nome fictício, por exemplo `Marina Demo`.
   - **CPF:** digite um dos CPFs **não cadastrados** acima.
3. O bot confirma o cadastro e mostra os **dias livres** (lista com "Ver
   mais" se houver muitos). Escolha um dia **daqui a 3 ou mais dias** (para
   usar na cena 3).
4. Escolha um **horário** e toque em **Confirmar**.
5. O bot manda a confirmação com a data por extenso, profissional, valor,
   endereço, o que levar e a regra de 24 h.

**O que mostrar:** cadastro, escolha de horário e marcação sem ninguém da
equipe. Se outra pessoa pegar a última vaga antes do "Confirmar", o bot avisa
e oferece outros horários.

> Variação: escolha *Pilates* — o bot já define **mensalidade** sozinho,
> porque é a única forma de pagamento desse serviço.

## Cena 3 — Remarcação com CPF

1. Envie `MENU` e toque em **Minhas consultas**.
2. Digite o CPF usado na cena 2 (ou o da Ana, se ela tiver consulta futura).
3. O bot cumprimenta pelo primeiro nome e lista as consultas futuras.
4. Escolha a consulta da cena 2 e toque em **Remarcar**.
5. Escolha outro dia e outro horário. O horário atual não aparece na lista.
6. O bot confirma a remarcação.

**O que mostrar:** o paciente se identifica só pelo CPF, e o bot nunca
repete o CPF na conversa. Um CPF errado recebe a mesma resposta que um CPF
não cadastrado; depois de 3 tentativas, o bot chama a equipe.

## Cena 4 — Mudança com menos de 24 h vai para a equipe

1. Preparação: marque uma consulta para **hoje ou amanhã** (repita a cena 2
   com outro CPF não cadastrado, ou use **Agendar consulta** logo depois da
   cena 3, já identificado, escolhendo o primeiro dia da lista).
2. Envie `MENU` → **Minhas consultas** → escolha essa consulta → **Cancelar**.
3. O bot explica a regra de 24 h e **chama a equipe**.
4. Envie `oi`: o bot **não responde** (a equipe assumiu).
5. Envie `MENU` para voltar ao atendimento automático.

**O que mostrar:** a regra de negócio é aplicada pelo bot, e casos fora da
regra vão para uma pessoa.

## Cena 5 — Pagamento vai para a equipe

1. Envie: `quero pagar minha mensalidade`
2. O bot **chama a equipe** ("Certo! Chamei alguém da nossa equipe…"),
   porque pagamentos não são tratados pelo bot. Fora do horário
   (08:00–18:00), ele informa quando a equipe responde.
3. Envie `MENU` para voltar.

> Variação: `estou com muita dor, caí agora` → o bot orienta a ligar para o
> **SAMU (192)** e chama a equipe.

---

## Onde aparece no Power BI

As páginas abaixo leem direto do Neon. Atualize o relatório depois das cenas.

| O que mostrar | Fonte no Neon |
|---|---|
| Consultas marcadas pelo bot | `bi_simulado.f_agendamentos` com canal de marcação **Chatbot** |
| Ações do bot na agenda (marcar, remarcar, cancelar) por dia | `reporting.bot_appointment_actions_daily` |
| Funil: quantas vezes cada etapa do bot foi mostrada | `reporting.bot_funnel_daily` |
| Atendimentos humanos por motivo, dentro e fora do horário, e tempo até a primeira resposta | `reporting.bot_handoffs_daily` |
| Taxa de autoatendimento (conversas sem equipe) | `reporting.bot_self_service_rate_daily` |
| Leads e etapa em que pararam | `bi_simulado.f_leads` (etapas "Abandonou na …", "Agendou pelo chatbot", "Transferido para atendente") |

> As páginas do Power BI sobre as views `reporting.bot_*` ainda precisam ser
> criadas (pendência do G3).

## Se algo der errado

| Sintoma | O que fazer |
|---|---|
| O bot não responde | Envie `MENU` (pode haver atendimento humano aberto). |
| Nada responde nem com `MENU` | Verifique o deploy na Vercel e o painel da Infobip (webhook e sender). |
| "Não há horários" | A grade vai até 17/01/2027. Para estender: `npm run extend-schedule` com o `DATABASE_URL` de produção. |
| O CPF "novo" foi aceito como paciente existente | Ele já foi usado num ensaio; use outro da lista. |
