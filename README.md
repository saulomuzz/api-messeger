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
- `POST /send`: Envia mensagens de texto para um número brasileiro (normalizado para E.164). Corpo esperado:

  ```json
  {
    "phone": "+5511999999999",
    "message": "Olá!",
    "subject": "Assunto opcional"
  }
  ```

  Caso `REQUIRE_SIGNED_REQUESTS=true`, inclua os cabeçalhos de assinatura descritos no código.

- `POST /send-media`: Envia arquivos de mídia (ex.: gráficos) com legenda opcional. Corpo esperado:

  ```json
  {
    "phone": "+5511999999999",
    "caption": "Legenda opcional exibida no WhatsApp",
    "media": {
      "mimetype": "image/png",
      "filename": "grafico.png",
      "data": "<conteúdo base64>"
    }
  }
  ```

  O campo `media.data` deve conter o arquivo codificado em base64 (sem prefixo `data:`).

## Estrutura do projeto

- `src/app.js`: Implementação da API.
- `.env.example`: Exemplo de configuração de variáveis de ambiente.
- `logs/`: Pasta sugerida para armazenar arquivos de log (ignorados pelo Git).
- `scripts/zabbix_whatsapp_sender.py`: Script auxiliar para integração com o Zabbix.

## Integração com Zabbix

O diretório `scripts/` contém o utilitário `zabbix_whatsapp_sender.py`, preparado para uso em ações ou
notificações do Zabbix. Ele envia uma mensagem de texto via endpoint `/send` e, opcionalmente,
anexa um gráfico renderizado pelo próprio Zabbix utilizando `/send-media`.

### Dependências

- Python 3.9 ou superior.
- Biblioteca `requests` (`pip install requests`).

### Exemplo de uso

```bash
python3 scripts/zabbix_whatsapp_sender.py \
  --api-base-url "https://whatsapp-api.exemplo.com" \
  --api-token "TOKEN_API" \
  --zabbix-url "https://zabbix.exemplo.com" \
  --zabbix-token "TOKEN_ZABBIX" \
  --graph-id 12345 \
  --period 7200 \
  "+5511998765432" \
  "Alerta: uso de CPU elevado"
```

Parâmetros adicionais relevantes:

- `--subject`: adiciona um título à mensagem de texto enviada.
- `--caption`: legenda específica para a imagem. Caso omitida, utiliza a própria mensagem de texto.
- `--zabbix-user`/`--zabbix-password`: alternativa ao uso de token, com autenticação via `user.login`.
- `--period`, `--width`, `--height`: personalizam o gráfico recuperado pelo `chart2.php` do Zabbix.

O script retorna `0` em caso de sucesso, `2` quando o envio de texto falha e `3` caso o envio do
gráfico não seja concluído.

## Segurança

- Utilize `API_TOKEN` para proteger os endpoints sensíveis.
- Habilite `REQUIRE_SIGNED_REQUESTS` em produção e configure `PUBLIC_KEY_PATH` com a chave pública de verificação.
- Certifique-se de executar a aplicação em ambiente seguro e mantenha o diretório `.wwebjs_auth` protegido.

## Licença

Este projeto baseia-se no trabalho de [BenyFilho/whatsapp-web.js](https://github.com/BenyFilho/whatsapp-web.js) e nos termos da licença MIT.
