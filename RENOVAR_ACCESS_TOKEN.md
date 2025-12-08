# Como Renovar o Access Token do WhatsApp Business API

## ⚠️ Problema: Token Expirado

Se você recebe o erro:
```
Error validating access token: Session has expired
```

Isso significa que o `WHATSAPP_ACCESS_TOKEN` no seu `.env` expirou e precisa ser renovado.

## 🔄 Como Renovar o Token

### Opção 1: Token de Longa Duração (Recomendado)

1. **Acesse o Meta for Developers:**
   - Vá para: https://developers.facebook.com/
   - Faça login com sua conta

2. **Navegue até seu App:**
   - Clique em "Meus Apps"
   - Selecione o app do WhatsApp Business

3. **Vá para Configurações:**
   - No menu lateral, clique em "WhatsApp" → "Configuração"
   - Ou vá direto para: https://developers.facebook.com/apps/SEU_APP_ID/whatsapp-business/configuration/

4. **Gere um Token de Longa Duração:**
   - Role até a seção "Token de acesso"
   - Clique em "Gerar token"
   - Selecione "Token de longa duração" (válido por 60 dias)
   - Copie o token gerado

5. **Atualize o `.env`:**
   ```bash
   WHATSAPP_ACCESS_TOKEN=SEU_NOVO_TOKEN_AQUI
   ```

6. **Reinicie o servidor:**
   ```bash
   # Pare o servidor (Ctrl+C) e reinicie
   node src/app.js
   ```

### Opção 2: Token Permanente (System User Token)

Para evitar renovar a cada 60 dias, você pode criar um **System User Token**:

1. **Crie um System User:**
   - Vá para: https://business.facebook.com/settings/system-users
   - Clique em "Adicionar"
   - Dê um nome (ex: "WhatsApp API Bot")
   - Clique em "Criar usuário do sistema"

2. **Adicione permissões:**
   - Clique no usuário criado
   - Em "Permissões", clique em "Atribuir permissões"
   - Selecione:
     - `whatsapp_business_messaging`
     - `whatsapp_business_management`
   - Clique em "Salvar alterações"

3. **Gere o token:**
   - Na mesma página, clique em "Gerar novo token"
   - Selecione o app do WhatsApp
   - Selecione as permissões necessárias
   - Defina a expiração (recomendado: "Nunca expira" ou máximo permitido)
   - Clique em "Gerar token"
   - **IMPORTANTE:** Copie o token imediatamente (ele só é mostrado uma vez!)

4. **Atualize o `.env`:**
   ```bash
   WHATSAPP_ACCESS_TOKEN=SEU_SYSTEM_USER_TOKEN_AQUI
   ```

5. **Reinicie o servidor**

### Opção 3: Token Temporário (Para testes rápidos)

1. **No Meta for Developers:**
   - Vá para: WhatsApp → Configuração
   - Em "Token de acesso", clique em "Gerar token"
   - Selecione "Token temporário" (válido por 1 hora)
   - Copie e use para testes rápidos

## 🔍 Verificar se o Token Está Válido

Você pode testar o token com:

```bash
curl -X GET "https://graph.facebook.com/v21.0/me?access_token=SEU_TOKEN_AQUI"
```

Se retornar dados do app, o token está válido.

## 📝 Checklist

- [ ] Token gerado no Meta for Developers
- [ ] Token copiado corretamente (sem espaços extras)
- [ ] `.env` atualizado com o novo token
- [ ] Servidor reiniciado
- [ ] Teste de envio funcionando

## ⚠️ Importante

- **Tokens temporários** expiram em 1 hora
- **Tokens de longa duração** expiram em 60 dias
- **System User Tokens** podem ser configurados para nunca expirar (recomendado para produção)

## 🆘 Se ainda não funcionar

1. Verifique se o token foi copiado completamente (sem cortes)
2. Verifique se não há espaços extras no `.env`
3. Verifique se o Phone Number ID está correto
4. Verifique se o app tem as permissões necessárias
5. Tente gerar um novo token novamente

