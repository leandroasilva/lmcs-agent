# 🚀 LMCS Relay Standalone - Guia de Deployment Completo

## ✅ Status da Implementação

### Implementado (100%)

- ✅ Docker + Docker Compose
- ✅ MySQL 8.0 com migrations
- ✅ Redis 7 para filas/cache
- ✅ Configuração via variáveis de ambiente
- ✅ Health checks
- ✅ Autenticação JWT completa (register, login, refresh)
- ✅ Hash de senhas com bcrypt
- ✅ Middleware de autenticação
- ✅ Estrutura de routers HTTP

### Pendente (TODO)

- ⏳ CRUD completo de environments
- ⏳ Sistema de tunnels gerenciados
- ⏳ Sistema de notificações mobile
- ⏳ Integração com clientes LMCS Code

## 📦 Instalação Rápida

### 1. Clonar e Configurar

```bash
cd /Volumes/Dock/workspace/lmcs/lmcs-agent/infra/relay-standalone

# Copiar .env
cp .env.example .env

# Gerar JWT_SECRET seguro
JWT_SECRET=$(openssl rand -base64 32)
echo "JWT_SECRET=$JWT_SECRET" >> .env

# Editar outras variáveis
nano .env
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

### 3. Testar

```bash
# Health check
curl http://localhost:3000/health

# Registrar usuário
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123","name":"Test User"}'

# Login
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123"}'
```

## 🌐 Deployment no Hetzner Cloud

### 1. Criar Servidor

```bash
# Via hcloud CLI
hcloud server create \
  --name lmcs-relay \
  --type cx21 \
  --image ubuntu-22.04 \
  --ssh-key meu-ssh-key \
  --location fsn1
```

### 2. Configurar DNS

Apontar `agent.lmcs.tec.br` para o IP do servidor.

### 3. Instalar Docker

```bash
ssh root@agent.lmcs.tec.br

# Instalar Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# Instalar Docker Compose
apt install docker-compose-plugin -y
```

### 4. Deployar Aplicação

```bash
# Clonar repo
git clone https://github.com/leandroasilva/lmcs-agent.git
cd lmcs-agent/infra/relay-standalone

# Configurar
cp .env.example .env
nano .env  # Editar com valores de produção

# Build e start
docker compose build
docker compose up -d
```

### 5. Configurar Nginx + SSL

```bash
# Instalar Nginx
apt install nginx certbot python3-certbot-nginx -y

# Configurar Nginx
cat > /etc/nginx/sites-available/relay << 'EOF'
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
EOF

ln -s /etc/nginx/sites-available/relay /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

# Obter certificado SSL
certbot --nginx -d agent.lmcs.tec.br
```

### 6. Configurar Firewall

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

## 📱 Configurar Clientes

### Desktop App

```bash
# No projeto principal
cd /Volumes/Dock/workspace/lmcs/lmcs-agent

# Editar .env
nano .env
```

Adicionar:

```dotenv
LMCS_RELAY_URL=https://agent.lmcs.tec.br
```

Rebuildar:

```bash
npm run dist:desktop:dmg:arm64
```

### Mobile App

No app mobile:

1. Settings → Environments
2. Add environment
3. URL: `https://agent.lmcs.tec.br`
4. Login com credenciais

## 🔧 Comandos Úteis

```bash
# Ver status
docker compose ps

# Ver logs
docker compose logs -f relay

# Restart
docker compose restart relay

# Backup MySQL
docker compose exec db mysqldump -u lmcs_relay -p lmcs_relay > backup.sql

# Restaurar
docker compose exec -T db mysql -u lmcs_relay -p lmcs_relay < backup.sql

# Acessar MySQL
docker compose exec db mysql -u lmcs_relay -p lmcs_relay

# Acessar Redis
docker compose exec redis redis-cli
```

## 📊 Monitoramento

```bash
# Stats dos containers
docker stats

# Health checks
curl http://localhost:3000/health

# Logs de erro
docker compose logs relay | grep -i error
```

## 🔒 Segurança

### Checklist

- [ ] JWT_SECRET forte (openssl rand -base64 32)
- [ ] Senhas de banco fortes
- [ ] HTTPS configurado (Let's Encrypt)
- [ ] Firewall ativo (UFW)
- [ ] Portas 3306 e 6379 não expostas
- [ ] CORS_ORIGIN restritivo
- [ ] Backups automáticos

### Backup Automático

```bash
# Cron job diário
0 2 * * * /usr/bin/docker compose -f /path/to/relay-standalone/docker-compose.yml exec -T db mysqldump -u lmcs_relay -pPASSWORD lmcs_relay > /backups/relay-$(date +\%Y\%m\%d).sql
```

## 🐛 Troubleshooting

### Relay não inicia

```bash
docker compose logs relay
# Verificar se MySQL está pronto
```

### Database connection failed

```bash
docker compose ps db
docker compose logs db
# Resetar (CUIDADO: apaga dados)
docker compose down -v
docker compose up -d
```

### Certificado SSL

```bash
certbot renew
systemctl reload nginx
```

## 📚 Próximos Passos

1. ✅ Estrutura base criada
2. ✅ Docker + MySQL + Redis funcionando
3. ✅ Autenticação JWT implementada
4. ⏳ Implementar CRUD de environments
5. ⏳ Implementar sistema de tunnels
6. ⏳ Testar com clientes LMCS Code
7. ⏳ Deployar em produção

## 💡 Suporte

Para completar a implementação:

- CRUD de environments: ~4 horas
- Sistema de tunnels: ~8 horas
- Testes e integração: ~4 horas
- **Total: ~16 horas (2 dias de trabalho)**

---

**Status:** Estrutura base 100% funcional, pronta para deployment e testes!
