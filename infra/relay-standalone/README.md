# LMCS Relay Standalone

Relay self-hosted para LMCS Code, rodando em Docker com MySQL e Redis.

## 🎯 Características

- ✅ **100% Self-hosted** - Sem dependência de terceiros
- ✅ **MySQL** para persistência de dados
- ✅ **Redis** para filas e cache
- ✅ **Autenticação JWT** própria
- ✅ **Docker** + Docker Compose
- ✅ **Cloudflare Tunnels** (opcional) para acesso remoto
- ✅ **API REST** completa para gerenciamento de ambientes

## 📋 Pré-requisitos

- Docker 20.10+
- Docker Compose 2.0+
- Domínio configurado (ex: `agent.lmcs.tec.br`)
- (Opcional) Conta Cloudflare para tunnels gerenciados

## 🚀 Quick Start

### 1. Configurar Variáveis de Ambiente

```bash
cd infra/relay-standalone

# Copiar exemplo
cp .env.example .env

# Editar com suas configurações
nano .env
```

**Variáveis obrigatórias:**

```dotenv
# Banco de dados
DB_PASSWORD=seu-password-seguro-aqui
DB_ROOT_PASSWORD=root-password-seguro

# JWT (use uma string aleatória longa)
JWT_SECRET=gerado-com-openssl-rand-base64-32

# Domínios
RELAY_DOMAIN=agent.lmcs.tec.br
TUNNEL_DOMAIN=tunnels.lmcs.tec.br
```

**Gerar JWT_SECRET seguro:**

```bash
openssl rand -base64 32
```

### 2. Build e Start

```bash
# Build das imagens
docker compose build

# Start dos serviços
docker compose up -d

# Ver logs
docker compose logs -f relay
```

### 3. Verificar Status

```bash
# Health check
curl http://localhost:3000/health

# Deve retornar:
# {"status":"ok","version":"1.0.0","database":"connected","redis":"connected"}
```

## 📱 Configurar Clientes

### Desktop App (Mac/Windows/Linux)

1. Rebuildar o app com as configurações do relay:

```bash
# No root do projeto
cd /Volumes/Dock/workspace/lmcs/lmcs-agent

# Editar .env
nano .env
```

Adicionar:

```dotenv
LMCS_RELAY_URL=https://agent.lmcs.tec.br
LMCS_CLERK_PUBLISHABLE_KEY=
LMCS_CLERK_JWT_TEMPLATE=
LMCS_CLERK_CLI_OAUTH_CLIENT_ID=
```

2. Rebuildar:

```bash
npm run dist:desktop:dmg:arm64
```

3. Instalar e abrir o app

4. Conectar ao relay:

```bash
npm run lmcs -- connect
```

### Mobile App

1. No app mobile, vá em **Settings → Environments**
2. Toque em **Add environment**
3. Insira a URL: `https://agent.lmcs.tec.br`
4. Faça login com suas credenciais

## 🗄️ Banco de Dados

### Conectar ao MySQL

```bash
# Via Docker
docker compose exec db mysql -u lmcs_relay -p lmcs_relay

# Ou diretamente (se porta exposta)
mysql -h localhost -P 3306 -u lmcs_relay -p lmcs_relay
```

### Migrations

Migrations rodam automaticamente no startup. Para rodar manualmente:

```bash
# Rodar migrations
docker compose exec relay npm run migrate

# Rollback (cuidado!)
docker compose exec relay npm run migrate:rollback
```

## 🔧 Comandos Úteis

### Logs

```bash
# Todos os serviços
docker compose logs -f

# Serviço específico
docker compose logs -f relay
docker compose logs -f db
docker compose logs -f redis
```

### Restart

```bash
# Reiniciar todos
docker compose restart

# Reiniciar um serviço
docker compose restart relay
```

### Stop/Start

```bash
# Parar tudo
docker compose down

# Parar e remover volumes (CUIDADO: apaga dados!)
docker compose down -v

# Iniciar novamente
docker compose up -d
```

### Backup

```bash
# Backup do MySQL
docker compose exec db mysqldump -u lmcs_relay -p lmcs_relay > backup.sql

# Restaurar
docker compose exec -T db mysql -u lmcs_relay -p lmcs_relay < backup.sql
```

## 🌐 Cloudflare Tunnels (Opcional)

Para usar tunnels gerenciados:

1. Criar tunnel no Cloudflare:

```bash
cloudflared tunnel create lmcs-relay
```

2. Copiar o token e adicionar ao `.env`:

```dotenv
CLOUDFLARE_TUNNEL_TOKEN=seu-tunnel-token
CLOUDFLARE_ACCOUNT_ID=seu-account-id
CLOUDFLARE_API_TOKEN=seu-api-token
```

3. Start com perfil de tunnel:

```bash
docker compose --profile tunnel up -d
```

## 🔒 Segurança

### Checklist

- [ ] Trocar `DB_PASSWORD` e `DB_ROOT_PASSWORD`
- [ ] Gerar `JWT_SECRET` seguro (openssl rand -base64 32)
- [ ] Configurar `CORS_ORIGIN` restritivo (ex: `https://app.lmcs.tec.br`)
- [ ] Usar HTTPS (via reverse proxy ou Cloudflare)
- [ ] Não expor portas do MySQL/Redis publicamente
- [ ] Configurar firewall (UFW/iptables)

### Firewall (UFW)

```bash
# Permitir apenas portas necessárias
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 22/tcp

# Bloquear resto
ufw enable

# NÃO expor 3306 (MySQL) ou 6379 (Redis)
```

### Reverse Proxy (Nginx)

Exemplo de configuração Nginx:

```nginx
server {
    listen 80;
    server_name agent.lmcs.tec.br;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Com Let's Encrypt:

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d agent.lmcs.tec.br
```

## 📊 Monitoramento

### Health Checks

```bash
# Relay
curl http://localhost:3000/health

# MySQL
docker compose exec db mysqladmin ping -h localhost

# Redis
docker compose exec redis redis-cli ping
```

### Métricas

```bash
# Stats do container
docker stats lmcs-relay lmcs-relay-db lmcs-relay-redis

# Logs de erro
docker compose logs relay | grep -i error
```

## 🐛 Troubleshooting

### Relay não inicia

```bash
# Ver logs
docker compose logs relay

# Erro comum: banco não pronto
# Solução: aguardar health check do MySQL
```

### Database connection failed

```bash
# Verificar se MySQL está rodando
docker compose ps db

# Ver logs do MySQL
docker compose logs db

# Resetar banco (CUIDADO: apaga dados!)
docker compose down -v
docker compose up -d
```

### Redis connection failed

```bash
# Verificar se Redis está rodando
docker compose ps redis

# Testar conexão
docker compose exec redis redis-cli ping
```

## 📚 API Endpoints

### Health

- `GET /health` - Status do servidor

### Auth

- `POST /auth/register` - Registrar novo usuário
- `POST /auth/login` - Login
- `POST /auth/refresh` - Refresh token
- `POST /auth/logout` - Logout

### Environments

- `GET /environments` - Listar ambientes
- `POST /environments` - Criar ambiente
- `GET /environments/:id` - Obter ambiente
- `PUT /environments/:id` - Atualizar ambiente
- `DELETE /environments/:id` - Remover ambiente
- `POST /environments/:id/link` - Linkar ambiente
- `POST /environments/:id/unlink` - Deslinkar ambiente

### Tunnels

- `GET /tunnels` - Listar tunnels
- `POST /tunnels` - Criar tunnel
- `DELETE /tunnels/:id` - Remover tunnel

## 🔄 Updates

```bash
# Pull mudanças
git pull

# Rebuildar
docker compose build

# Restart com novas imagens
docker compose up -d

# Verificar logs
docker compose logs -f relay
```

## 📝 Licença

MIT

## 🤝 Suporte

Para issues e dúvidas:

- GitHub Issues: https://github.com/leandroasilva/lmcs-agent/issues
- Documentação: https://github.com/leandroasilva/lmcs-agent/tree/main/docs
