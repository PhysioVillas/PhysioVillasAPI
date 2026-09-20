const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'PhysioVilas ChatManager API',
    version: '0.1.0',
    description: 'Backend de integração Infobip. As rotas de integração ficam desligadas até receberem suas configurações de ambiente. O identificador `wa_id` é armazenado exatamente como recebido no campo `from` do evento da Infobip; o backend não adiciona `+`, remove dígitos ou normaliza esse valor. O formato comercial definitivo depende da captura de um payload real.',
  },
  paths: {
    '/health': {
      get: {
        summary: 'Verifica a disponibilidade da aplicação',
        responses: {
          200: { description: 'Aplicação disponível' },
        },
      },
    },
    '/health/ready': {
      get: {
        summary: 'Confirma que o banco configurado tem o schema do ChatManager',
        responses: {
          200: { description: 'Aplicação e banco prontos para receber webhooks' },
          503: { description: 'Banco ainda não configurado ou indisponível' },
        },
      },
    },
    '/webhooks/infobip/inbound': {
      post: {
        summary: 'Recebe evento WhatsApp de entrada ou relatório de entrega da Infobip',
        security: [{ InfobipWebhookBearer: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['results'],
                properties: {
                  results: {
                    type: 'array',
                    description: 'Somente os campos mapeados são processados; o payload bruto não é armazenado.',
                    items: {
                      oneOf: [
                        {
                          type: 'object',
                          required: ['from', 'receivedAt', 'messageId', 'message'],
                          properties: {
                            from: { type: 'string' },
                            receivedAt: { type: 'string', format: 'date-time' },
                            messageId: { type: 'string' },
                            message: {
                              type: 'object',
                              required: ['type'],
                              properties: {
                                type: { type: 'string', example: 'TEXT' },
                                text: { type: 'string' },
                              },
                            },
                            contact: {
                              type: 'object',
                              properties: { name: { type: 'string' } },
                            },
                          },
                        },
                        {
                          type: 'object',
                          required: ['messageId', 'status'],
                          properties: {
                            messageId: { type: 'string' },
                            doneAt: { type: 'string', format: 'date-time' },
                            status: {
                              type: 'object',
                              properties: {
                                name: { type: 'string', example: 'DELIVERED_TO_HANDSET' },
                                groupName: { type: 'string', example: 'DELIVERED' },
                              },
                            },
                            error: {
                              type: 'object',
                              properties: { name: { type: 'string' } },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Evento mapeado persistido; relatórios atualizam apenas status, erro e instante de entrega' },
          202: { description: 'Evento não mapeado reconhecido sem persistência' },
          400: { description: 'JSON inválido' },
          401: { description: 'Token de webhook inválido' },
          503: { description: 'Webhook ainda não configurado' },
        },
      },
    },
    '/messages/validate': {
      post: {
        summary: 'Valida texto ou agendamento na Messages API sem enviar mensagem',
        security: [{ ChatManagerBearer: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['to', 'text'],
                properties: {
                  to: { type: 'string', description: 'Destinatário no formato aceito pela Infobip' },
                  text: { type: 'string' },
                  sendAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Payload válido para a Messages API; nenhuma mensagem foi enviada' },
          400: { description: 'Corpo inválido' },
          401: { description: 'Token interno inválido' },
          502: { description: 'Infobip recusou a validação' },
          503: { description: 'Validação ainda não configurada' },
        },
      },
    },
    '/messages/templates/validate': {
      post: {
        summary: 'Valida um template WhatsApp na Messages API sem enviar mensagem',
        security: [{ ChatManagerBearer: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['to', 'templateName', 'language'],
                properties: {
                  to: { type: 'string', description: 'Destinatário no formato aceito pela Infobip' },
                  templateName: { type: 'string' },
                  language: { type: 'string', example: 'pt_BR' },
                  parameters: { type: 'array', items: { type: 'string' } },
                  sendAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Contrato do template válido; nenhuma mensagem foi enviada' },
          400: { description: 'Corpo inválido' },
          401: { description: 'Token interno inválido' },
          502: { description: 'Infobip recusou a validação' },
          503: { description: 'Validação ainda não configurada' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ChatManagerBearer: { type: 'http', scheme: 'bearer' },
      InfobipWebhookBearer: { type: 'http', scheme: 'bearer' },
    },
  },
};

export { openApiDocument };
