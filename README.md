# API Messenger

API REST para integração com o WhatsApp utilizando [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js).

## Requisitos

- Node.js 18 ou superior
- Navegador Chromium (fornecido automaticamente pelo `whatsapp-web.js`)

## Configuração

1. Instale as dependências:

   ```bash
   npm install
   ```

2. Copie o arquivo `.env.example` para `.env` e ajuste as variáveis conforme necessário.

   ```bash
   cp .env.example .env
   ```

   Principais variáveis:

   - `PORT`: Porta onde a API será exposta.
   - `API_TOKEN`: Token opcional para autenticação via cabeçalho `X-API-Token`.
   - `CORS_ORIGIN`: Origem permitida para CORS. Use `*` para liberar geral.
   - `DEBUG`: Habilita logs detalhados quando definido como `true`.
   - `LOG_PATH`: Caminho do arquivo de log. Certifique-se de que a pasta exista ou possa ser criada.
   - `REQUIRE_SIGNED_REQUESTS`: Quando `true`, exige assinaturas RSA para o endpoint `/send`.
   - `PUBLIC_KEY_PATH`: Caminho para a chave pública utilizada na validação das assinaturas.

3. Execute a aplicação:

   ```bash
   npm start
   ```

   No primeiro acesso será necessário autenticar a sessão do WhatsApp escaneando o QR Code exibido no terminal ou acessando `/qr.png`.

## Endpoints

- `GET /health`: Verifica se a API está disponível.
- `GET /status`: Retorna o estado do cliente WhatsApp. Requer token caso `API_TOKEN` esteja configurado.
- `GET /qr.png`: Retorna o QR Code atual em formato PNG.
- `POST /send`: Envia mensagens para um número brasileiro (normalizado para E.164). Corpo esperado:

  ```json
  {
    "phone": "+5511999999999",
    "message": "Olá!",
    "subject": "Assunto opcional"
  }
  ```

  Caso `REQUIRE_SIGNED_REQUESTS=true`, inclua os cabeçalhos de assinatura descritos no código.

## Estrutura do projeto

- `src/app.js`: Implementação da API.
- `.env.example`: Exemplo de configuração de variáveis de ambiente.
- `logs/`: Pasta sugerida para armazenar arquivos de log (ignorados pelo Git).

## Segurança

- Utilize `API_TOKEN` para proteger os endpoints sensíveis.
- Habilite `REQUIRE_SIGNED_REQUESTS` em produção e configure `PUBLIC_KEY_PATH` com a chave pública de verificação.
- Certifique-se de executar a aplicação em ambiente seguro e mantenha o diretório `.wwebjs_auth` protegido.

## Licença

Este projeto baseia-se no trabalho de [BenyFilho/whatsapp-web.js](https://github.com/BenyFilho/whatsapp-web.js) e nos termos da licença MIT.
