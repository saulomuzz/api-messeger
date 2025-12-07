# Configuração do .env para Tuya

## ⚠️ IMPORTANTE: Segurança

- ✅ O arquivo `.env` **JÁ ESTÁ** no `.gitignore` e **NÃO será commitado**
- ❌ **NUNCA** coloque dados reais em arquivos de documentação (`.md`)
- ✅ Use apenas placeholders nos arquivos versionados

## 📋 Dados da Plataforma Tuya → Variáveis do .env

Baseado na imagem da plataforma Tuya, aqui está o mapeamento:

### Da Seção "Authorization Key":

| Campo na Plataforma | Variável no .env | Valor da Imagem |
|---------------------|------------------|-----------------|
| **Access ID/Client ID** | `TUYA_CLIENT_ID` | `smu5nmy5cuueqvag5xty` |
| **Access Secret/Client Secret** | `TUYA_CLIENT_SECRET` | `8dc9e1576bb64b8c98bee0d4af2e8801` |

### Da Seção "Data Center":

| Data Center na Plataforma | Variável no .env | Valor |
|---------------------------|------------------|-------|
| **Western America Data Center** | `TUYA_REGION` | `us` |
| Eastern America Data Center | `TUYA_REGION` | `us` |
| Central Europe Data Center | `TUYA_REGION` | `eu` |
| Western Europe Data Center | `TUYA_REGION` | `eu` |
| China Data Center | `TUYA_REGION` | `cn` |
| India Data Center | `TUYA_REGION` | `in` |

### Outros dados:

- **Project Code** (`p1765064371529m5y4up`): Não é usado no código, apenas para referência
- **TUYA_UID**: Precisa obter separadamente (não aparece na mesma página)

## 📝 Exemplo de .env (use seus dados reais)

```bash
# Tuya API
TUYA_CLIENT_ID=smu5nmy5cuueqvag5xty
TUYA_CLIENT_SECRET=8dc9e1576bb64b8c98bee0d4af2e8801
TUYA_REGION=us
TUYA_UID=seu_uid_aqui
```

## ✅ Checklist de Segurança

- [ ] O arquivo `.env` existe na raiz do projeto
- [ ] O `.env` está no `.gitignore` (já está configurado)
- [ ] Você NÃO commita o arquivo `.env`
- [ ] Os dados sensíveis estão APENAS no `.env` local
- [ ] Nenhum dado real aparece em arquivos `.md` ou outros arquivos versionados

## 🔍 Como Verificar se Está Seguro

Execute este comando para verificar se o `.env` está no `.gitignore`:

```bash
git check-ignore .env
```

Se retornar `.env`, está protegido! ✅

## 🆘 Se Você Comitou Dados Sensíveis por Engano

1. **NUNCA** commite o `.env` novamente
2. Se já commtou, remova do histórico do Git:
   ```bash
   git rm --cached .env
   git commit -m "Remove .env from repository"
   ```
3. Gere novas credenciais na plataforma Tuya (revogar as antigas)
4. Atualize o `.env` com as novas credenciais


