-- Mascara dados pessoais apos um restore com --sanitize (ver restore.sh).
-- NUNCA rodar isso direto em producao - so serve pra popular ambiente de dev
-- com um backup real sem carregar dados pessoais/conteudo de mensagens reais.
-- Nota: sqlite3 CLI precisa estar disponivel na imagem (nao esta por padrao
-- no Dockerfile atual) - se faltar, restore.sh avisa e este arquivo pode ser
-- rodado manualmente com "sqlite3 app.sqlite < sanitize.sql".

UPDATE contacts SET
  name = 'Contato Dev ' || rowid;

UPDATE message_audit SET
  to_number          = '+5541900' || substr('00000' || id, -5),
  dev_redirected_to  = '',
  payload_json       = '{"sanitized":true}',
  response_json      = '{"sanitized":true}',
  error_json         = NULL,
  source_ip          = '10.0.0.1';

UPDATE webhook_events SET
  from_number            = '+5541900' || substr('00000' || id, -5),
  payload_json           = '{"sanitized":true}',
  processed_result_json  = '{"sanitized":true}',
  source_ip              = '10.0.0.1';

-- Senha padrao de dev pro painel admin (troque no primeiro acesso)
UPDATE admin_users SET
  password_hash = NULL
WHERE 1=0; -- placeholder: hash de admin_users usa scrypt/bcrypt proprio do app,
           -- gere um novo com "node scripts/reset-admin-password.js" apos o restore.
