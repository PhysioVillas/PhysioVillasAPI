// Validação e normalização das respostas do bot contra os limites das
// mensagens interativas do WhatsApp (o engine chama isto antes de devolver
// as respostas; o envio é de outro módulo).
//
// Limites usados (documentação da WhatsApp Cloud API para mensagens
// interativas, que a API dedicada de WhatsApp da Infobip repassa):
// - texto simples: corpo até 4096 caracteres;
// - interativo (lista e botões): body até 1024, header (texto) até 60,
//   footer até 60;
// - lista: até 10 linhas no total (somando as seções), até 10 seções,
//   título da seção até 24, título do botão que abre a lista até 20,
//   título da linha até 24, descrição da linha até 72, id da linha até 200;
// - botões de resposta: até 3, título até 20, id até 256.
//
// Regras de normalização:
// - texto acima do limite é cortado e termina com "…";
// - ids nunca são cortados (cortar mudaria o roteamento): id vazio, longo
//   demais ou repetido na mesma mensagem é erro de programação e lança
//   TypeError (o engine trata como falha do fluxo);
// - mensagem de botões com mais de 3 botões vira lista (mesmos ids e
//   títulos), para não perder opções;
// - lista com mais de 10 linhas é paginada: cada página tem 9 linhas mais a
//   linha "Ver mais", cujo id segue `<flow>:<step>|more:<n>` (n = página
//   que a linha abre, começando em 2). A última página leva até 10 linhas.
//   Só uma lista por resultado pode ser paginada; as páginas seguintes ficam
//   em `pages` para o engine guardar no estado.

export const WHATSAPP_LIMITS = Object.freeze({
  textBody: 4096,
  interactiveBody: 1024,
  header: 60,
  footer: 60,
  listButtonTitle: 20,
  listMaxRows: 10,
  listMaxSections: 10,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
  rowId: 200,
  maxButtons: 3,
  buttonTitle: 20,
  buttonId: 256,
});

export const DEFAULT_LIST_BUTTON_TITLE = 'Ver opções';
export const MORE_ROW_TITLE = 'Ver mais';
export const MORE_ROW_DESCRIPTION = 'Mostrar mais opções';
const ELLIPSIS = '…';

/** Corta o texto em `max` caracteres (code points), terminando com "…". */
export function truncate(text, max) {
  const value = String(text ?? '').trim();
  const chars = Array.from(value);
  if (chars.length <= max) {
    return value;
  }
  return `${chars.slice(0, max - 1).join('').trimEnd()}${ELLIPSIS}`;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Reply ${field} must be a non-empty string.`);
  }
  return value;
}

function optionalText(value, max) {
  return typeof value === 'string' && value.trim() !== '' ? truncate(value, max) : undefined;
}

function checkId(id, max, seen) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError('Reply option id must be a non-empty string.');
  }
  if (Array.from(id).length > max) {
    throw new TypeError(`Reply option id longer than ${max} characters.`);
  }
  if (seen.has(id)) {
    throw new TypeError(`Duplicated reply option id: ${id}`);
  }
  seen.add(id);
  return id;
}

function withOptional(target, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
  return target;
}

function normalizeText(reply) {
  return { type: 'text', text: truncate(requireText(reply.text, 'text'), WHATSAPP_LIMITS.textBody) };
}

function normalizeButtons(reply) {
  const buttons = Array.isArray(reply.buttons) ? reply.buttons : [];
  if (buttons.length === 0) {
    throw new TypeError('Buttons reply needs at least one button.');
  }
  if (buttons.length > WHATSAPP_LIMITS.maxButtons) {
    // Mais de 3 botões: vira lista com as mesmas opções.
    return normalizeListRows({
      ...reply,
      type: 'list',
      sections: [{ rows: buttons.map(({ id, title }) => ({ id, title })) }],
    });
  }
  const seen = new Set();
  return withOptional({
    type: 'buttons',
    body: truncate(requireText(reply.body, 'body'), WHATSAPP_LIMITS.interactiveBody),
    buttons: buttons.map((button) => ({
      id: checkId(button?.id, WHATSAPP_LIMITS.buttonId, seen),
      title: truncate(requireText(button?.title, 'button title'), WHATSAPP_LIMITS.buttonTitle),
    })),
  }, {
    header: optionalText(reply.header, WHATSAPP_LIMITS.header),
    footer: optionalText(reply.footer, WHATSAPP_LIMITS.footer),
  });
}

// Normaliza textos e ids da lista, sem paginar. Linhas ficam achatadas com o
// título da seção de origem, para a paginação reagrupar depois.
function normalizeListRows(reply) {
  const sections = Array.isArray(reply.sections) ? reply.sections : [];
  const seen = new Set();
  const rows = [];
  for (const section of sections) {
    const sectionTitle = optionalText(section?.title, WHATSAPP_LIMITS.sectionTitle);
    for (const row of Array.isArray(section?.rows) ? section.rows : []) {
      rows.push({
        sectionTitle,
        row: withOptional({
          id: checkId(row?.id, WHATSAPP_LIMITS.rowId, seen),
          title: truncate(requireText(row?.title, 'row title'), WHATSAPP_LIMITS.rowTitle),
        }, {
          description: optionalText(row?.description, WHATSAPP_LIMITS.rowDescription),
        }),
      });
    }
  }
  if (rows.length === 0) {
    throw new TypeError('List reply needs at least one row.');
  }
  return withOptional({
    type: 'list',
    body: truncate(requireText(reply.body, 'body'), WHATSAPP_LIMITS.interactiveBody),
    buttonTitle: truncate(
      typeof reply.buttonTitle === 'string' && reply.buttonTitle.trim() !== ''
        ? reply.buttonTitle
        : DEFAULT_LIST_BUTTON_TITLE,
      WHATSAPP_LIMITS.listButtonTitle,
    ),
    rows,
  }, {
    header: optionalText(reply.header, WHATSAPP_LIMITS.header),
    footer: optionalText(reply.footer, WHATSAPP_LIMITS.footer),
  });
}

function groupSections(entries) {
  const sections = [];
  for (const { sectionTitle, row } of entries) {
    const last = sections.at(-1);
    if (last && last.titleKey === (sectionTitle ?? null)) {
      last.rows.push(row);
    } else {
      sections.push({ titleKey: sectionTitle ?? null, rows: [row] });
    }
  }
  return sections.map(({ titleKey, rows }) => withOptional({}, { title: titleKey ?? undefined, rows }));
}

function buildList(base, entries) {
  const { rows: _rows, ...rest } = base;
  return { ...rest, sections: groupSections(entries) };
}

/**
 * Divide uma lista normalizada em páginas de no máximo 10 linhas. Sem
 * `morePrefix` (`<flow>:<step>`) não há como rotear "Ver mais": a lista é
 * cortada em 10 linhas.
 */
function paginate(list, morePrefix) {
  const max = WHATSAPP_LIMITS.listMaxRows;
  if (list.rows.length <= max) {
    return [buildList(list, list.rows)];
  }
  if (!morePrefix) {
    return [buildList(list, list.rows.slice(0, max))];
  }
  const perPage = max - 1;
  const pages = [];
  let index = 0;
  while (index < list.rows.length) {
    const remaining = list.rows.length - index;
    if (remaining <= max) {
      pages.push(list.rows.slice(index));
      break;
    }
    pages.push(list.rows.slice(index, index + perPage));
    index += perPage;
  }
  return pages.map((entries, i) => {
    if (i === pages.length - 1) {
      return buildList(list, entries);
    }
    const more = {
      sectionTitle: entries.at(-1).sectionTitle,
      row: {
        id: `${morePrefix}|more:${i + 2}`,
        title: MORE_ROW_TITLE,
        description: MORE_ROW_DESCRIPTION,
      },
    };
    return buildList(list, [...entries, more]);
  });
}

/** Normaliza uma resposta. Lista longa sem `morePrefix` é cortada em 10 linhas. */
export function normalizeReply(reply, { morePrefix } = {}) {
  return normalizeRepliesWithPages([reply], { morePrefix }).replies[0];
}

/**
 * Normaliza as respostas de um FlowResult.
 * Devolve `{ replies, pages }`: `pages` é null ou a lista completa de páginas
 * (índice 0 = página 1, já incluída em `replies`) da primeira lista paginada.
 */
export function normalizeRepliesWithPages(replies, { morePrefix } = {}) {
  if (!Array.isArray(replies)) {
    throw new TypeError('replies must be an array.');
  }
  const out = [];
  let pages = null;
  for (const reply of replies) {
    switch (reply?.type) {
      case 'text':
        out.push(normalizeText(reply));
        break;
      case 'buttons': {
        const normalized = normalizeButtons(reply);
        if (normalized.type === 'buttons') {
          out.push(normalized);
          break;
        }
        pages = pushList(out, normalized, pages, morePrefix);
        break;
      }
      case 'list':
        pages = pushList(out, normalizeListRows(reply), pages, morePrefix);
        break;
      default:
        throw new TypeError(`Unknown reply type: ${reply?.type}`);
    }
  }
  return { replies: out, pages };
}

function pushList(out, list, pages, morePrefix) {
  // Só a primeira lista longa é paginada; outras são cortadas em 10 linhas.
  const listPages = paginate(list, pages === null ? morePrefix : undefined);
  out.push(listPages[0]);
  return pages === null && listPages.length > 1 ? listPages : pages;
}

/** Atalho: só as respostas normalizadas. */
export function normalizeReplies(replies, options) {
  return normalizeRepliesWithPages(replies, options).replies;
}
