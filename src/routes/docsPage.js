// Página HTML do Swagger UI para GET /docs.
//
// NOTA (2026-09-23): antes, esta rota usava `swagger-ui-express` (swaggerUi.serve +
// swaggerUi.setup), que serve os assets estáticos (swagger-ui-bundle.js,
// swagger-ui-standalone-preset.js, swagger-ui.css) a partir do pacote local
// swagger-ui-dist. Na Vercel isso quebrava em produção: as requisições para
// /docs/swagger-ui-bundle.js e /docs/swagger-ui-standalone-preset.js voltavam
// com status 200 mas corpo HTML (a própria página do Swagger), em vez do
// JavaScript real -- os assets estáticos não estavam sendo servidos
// corretamente pela função serverless. Confirmado ao vivo: console mostrava
// "SyntaxError: Unexpected token '<'" e "SwaggerUIBundle is not defined".
//
// Correção: carregar os assets do Swagger UI via CDN (jsDelivr), abordagem
// documentada pela própria comunidade do swagger-ui-express para ambientes
// serverless, em vez de depender do middleware de arquivos estáticos.
// swagger-ui-express foi removido das dependências.

const SWAGGER_UI_VERSION = '5.33.0';
const SWAGGER_UI_CDN_BASE = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`;

function renderDocsHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>ChatManager API Docs</title>
    <link rel="stylesheet" href="${SWAGGER_UI_CDN_BASE}/swagger-ui.css" />
    <style>body { margin: 0; }</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${SWAGGER_UI_CDN_BASE}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
    <script src="${SWAGGER_UI_CDN_BASE}/swagger-ui-standalone-preset.js" crossorigin="anonymous"></script>
    <script>
      window.onload = () => {
        window.ui = SwaggerUIBundle({
          url: '/docs.json',
          dom_id: '#swagger-ui',
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          layout: 'StandaloneLayout',
        });
      };
    </script>
  </body>
</html>
`;
}

export { renderDocsHtml };
