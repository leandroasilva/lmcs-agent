# 🔧 Guia de Variáveis de Ambiente - LMCS Agent (Tudo Junto)

## 📋 Visão Geral

O relay standalone roda **junto com o server principal** no mesmo app/container no HCloud.

**Endereço único:** `https://lmcs-agent.cloud.hcloud.net.br`

- Server principal: `/`
- Relay API: `/relay/*`

---

## 🔐 GitHub Secrets Necessários

| Secret             | Status            | Descrição                        |
| ------------------ | ----------------- | -------------------------------- |
| `HCLOUD_APP_ID`    | ✅ Já configurado | ID do app no HCloud              |
| `HCLOUD_APP_TOKEN` | ✅ Já configurado | Token de autenticação do HCloud  |
| `EXPO_TOKEN`       | ✅ Já configurado | Token do Expo para mobile builds |

**NÃO precisa de:** `HCLOUD_RELAY_APP_ID` (tudo roda no mesmo app)

---

## 🖥️ Variáveis de Ambiente do HCloud (App Único)

### Configurar no HCloud Dashboard

```bash
# =============================================================================
# Server Configuration
# =============================================================================
NODE_ENV=production
PORT=80
HOST=0.0.0.0

# =============================================================================
# Application URLs
# =============================================================================
LMCS_HOSTED_APP_URL=https://lmcs-agent.cloud.hcloud.net.br
VITE_HOSTED_APP_URL=https://lmcs-agent.cloud.hcloud.net.br

# =============================================================================
# Database (MySQL) - HCloud External
# =============================================================================
DATABASE_URL=mysql://cli_halklenson_xsor_agent:5FePsqHZ2HBHTKCF3Ru7meZl@srv1.hcloud.net.br:3306/cli_halklenson_xsor_agent
DATABASE_HOST=srv1.hcloud.net.br
DATABASE_PORT=3306
DATABASE_USER=cli_halklenson_xsor_agent
DATABASE_PASSWORD=5FePsqHZ2HBHTKCF3Ru7meZl
DATABASE_NAME=cli_halklenson_xsor_agent

# =============================================================================
# Redis - HCloud External
# =============================================================================
REDIS_URL=redis://cli_halklenson_xsor_agent:pEjY8kBQ1wTEqL4zL89mteW2@srv1.hcloud.net.br:6379
REDIS_HOST=srv1.hcloud.net.br
REDIS_PORT=6379
REDIS_USERNAME=cli_halklenson_xsor_agent
REDIS_PASSWORD=pEjY8kBQ1wTEqL4zL89mteW2
REDIS_KEY_PREFIX=cli_halklenson_xsor_agent:

# =============================================================================
# Relay Configuration (Standalone - junto com server)
# =============================================================================
RELAY_ENABLED=true
RELAY_DOMAIN=lmcs-agent.cloud.hcloud.net.br
RELAY_TUNNEL_DOMAIN=tunnels.lmcs-agent.cloud.hcloud.net.br
RELAY_PORT=3000

# =============================================================================
# JWT Authentication (para relay)
# =============================================================================
# Gerar com: openssl rand -base64 32
JWT_SECRET=<GERAR_TOKEN_SEGURO>
JWT_EXPIRES_IN=7d

# =============================================================================
# LMCS Connect (Relay URL - aponta para o mesmo servidor)
# =============================================================================
LMCS_RELAY_URL=https://lmcs-agent.cloud.hcloud.net.br

# =============================================================================
# Auto-update (desabilitar para self-hosted)
# =============================================================================
LMCS_DISABLE_AUTO_UPDATE=1

# =============================================================================
# Logging & CORS
# =============================================================================
LOG_LEVEL=info
CORS_ORIGIN=https://lmcs-agent.cloud.hcloud.net.br
```

---

## 🔐 Como Gerar JWT_SECRET Seguro

```bash
# Opção 1: OpenSSL (recomendado)
openssl rand -base64 32

# Opção 2: Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Opção 3: Python
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

---

## 📝 Checklist de Configuração

### 1. GitHub Secrets

- [x] `HCLOUD_APP_ID` ✅
- [x] `HCLOUD_APP_TOKEN` ✅
- [x] `EXPO_TOKEN` ✅

### 2. HCloud App (Tudo Junto)

- [ ] Copiar todas as variáveis acima para o HCloud Dashboard
- [ ] Gerar `JWT_SECRET` seguro e configurar
- [ ] Salvar configurações

### 3. Deploy

- [ ] Fazer commit das mudanças
- [ ] Push para `main` → deploy automático
- [ ] Aguardar deploy completar (~3-5 min)

### 4. Testes

```bash
# Testar server principal
curl https://lmcs-agent.cloud.hcloud.net.br/health

# Testar relay (quando implementado)
curl https://lmcs-agent.cloud.hcloud.net.br/relay/health

# Registrar usuário no relay
curl -X POST https://lmcs-agent.cloud.hcloud.net.br/relay/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@lmcs.tec.br","password":"test123"}'
```

---

## 🚀 Fluxo de Deploy

```
Push para main → Build Docker (Server + Relay) → Push GHCR → Webhook HCloud → Deploy Único
```

**Vantagens:**

- ✅ Deploy simplificado (um único app)
- ✅ Mesmo endereço para tudo
- ✅ Menos custos (um container só)
- ✅ Configuração mais simples

---

## 📚 Endpoints

### Server Principal

- `GET /health` - Health check do server
- `GET /api/*` - APIs do LMCS Code

### Relay (quando implementado)

- `GET /relay/health` - Health check do relay
- `POST /relay/auth/register` - Registrar usuário
- `POST /relay/auth/login` - Login
- `POST /relay/auth/refresh` - Refresh token
- `GET /relay/auth/me` - Perfil do usuário
- `GET /relay/environments` - Listar ambientes
- `POST /relay/environments` - Criar ambiente
- `GET /relay/tunnels` - Listar tunnels

---

## 🐛 Troubleshooting

### Deploy não dispara

- Verificar se o commit foi para `main`
- Verificar GitHub Actions logs
- Verificar se `HCLOUD_APP_ID` e `HCLOUD_APP_TOKEN` estão corretos

### Relay não responde

- Verificar se `RELAY_ENABLED=true`
- Verificar logs do container no HCloud
- Verificar se `JWT_SECRET` está configurado

### Banco/Redis não conectam

- Verificar credenciais do MySQL e Redis
- Verificar se `srv1.hcloud.net.br` está acessível
- Verificar logs de conexão

---

## 💡 Resumo

**Configuração simplificada:**

- ✅ 1 app no HCloud
- ✅ 1 endereço: `https://lmcs-agent.cloud.hcloud.net.br`
- ✅ Server + Relay juntos
- ✅ Mesmo banco e Redis
- ✅ Deploy único

**Próximo passo:** Commit e push para deploy automático! 🚀
