# Agent Device Access — Explicação Técnica

## O que é "Agent Device Access"?

"Agent device access" é um recurso do LMCS Agent que permite que sessões de agentes de IA (como Claude Code, Codex, etc.) **controlem dispositivos móveis** — iOS Simulators e Android Emulators — diretamente do ambiente de desenvolvimento.

A descrição na interface diz:

> _"Allow new agent sessions in this environment to start and control local and remote devices, with required tools set up automatically."_

Traduzindo: permite que novas sessões de agente iniciem e controlem dispositivos locais e remotos, com as ferramentas necessárias instaladas automaticamente.

---

## Qual é o "programa agente"?

O programa responsável por controlar os dispositivos é o **`agent-device`** — um pacote npm externo mantido pela **Callstack**:

| Campo             | Valor                                       |
| ----------------- | ------------------------------------------- |
| **Pacote npm**    | `agent-device`                              |
| **Versão pinned** | `0.21.12`                                   |
| **Repositório**   | `https://github.com/callstack/agent-device` |
| **Licença**       | MIT                                         |
| **Entry point**   | `bin/agent-device.mjs`                      |

**Este programa NÃO está no código do LMCS Agent.** É um pacote externo instalado sob demanda via `npm install` em um diretório isolado.

Além do `agent-device`, o sistema também instala o **`expo-device-hub`** (v0.12.0), que é responsável por **streamar a tela** do simulador/emulador para o painel Device na interface web.

---

## O build é separado?

**Sim, completamente separado.** O `agent-device` e o `expo-device-hub` são:

1. **Pacotes npm independentes** — publicados no registry npm público
2. **Instalados sob demanda** — apenas quando o usuário ativa o recurso
3. **Isolados por versão** — cada versão fica em `<baseDir>/tools/<nome>@<versao>/`
4. **Executados com Node runtime resolvido** — nunca via `npx` (para evitar dependência do registry em cada primeiro uso)

O LMCS Agent **não compila nem empacota** esses tools. Ele apenas:

- Define as versões necessárias (pinned)
- Instala via `npm install --prefix <staging-dir>`
- Valida o entry point após instalação
- Move atomicamente para o diretório final (rename)
- Executa os binários com o Node resolvido

---

## Como funciona a arquitetura

### Dois componentes principais

```
┌─────────────────────────────────────────────────────────┐
│                    LMCS Server                           │
│                                                          │
│  ┌──────────────────┐    ┌───────────────────────────┐  │
│  │  expo-device-hub │    │      agent-device          │  │
│  │  (streaming)     │    │      (controle)            │  │
│  │                  │    │                            │  │
│  │  - Stream tela   │    │  - Daemon HTTP             │  │
│  │  - WebSocket     │    │  - Comandos: devices,      │  │
│  │  - Painel Device │    │    tap, type, screenshot   │  │
│  └────────┬─────────    └─────────────┬─────────────┘  │
│           │                            │                │
│           ▼                            ▼                │
│  ┌─────────────────────────────────────────────────┐    │
│  │         iOS Simulator / Android Emulator         │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### Fluxo de ativação

1. **Usuário abre o painel Device** → setup wizard de 3 passos
2. **Passo 1**: Inicia o `expo-device-hub` (instala se necessário)
3. **Passo 2**: Verifica suporte a iOS/Android
4. **Passo 3**: Toggle "Agent device access" → instala `agent-device` e inicia o daemon

### Como o agente controla o dispositivo

Quando "Agent device access" está habilitado:

1. O LMCS Server cria um **shim** (`agent-device-launcher.mjs`) que encapsula o `agent-device` com as credenciais corretas
2. O shim é adicionado ao **PATH** dos subprocessos do provedor (agente)
3. Variáveis de ambiente são injetadas:
   - `AGENT_DEVICE_DAEMON_BASE_URL` → URL do daemon HTTP
   - `AGENT_DEVICE_DAEMON_AUTH_TOKEN` → token de autenticação
4. O agente recebe **MCP tools** (`device_open`, `device_close`, `device_screenshot`, etc.)
5. O agente digita `agent-device ...` no terminal e o shim roteia para o daemon correto

### Daemon HTTP

O `agent-device` roda um **daemon HTTP** em localhost:

- Auto-inicia no primeiro comando
- Porta e token salvos em `daemon.json`
- Idle timeout desabilitado (LMCS controla o lifecycle)
- Health check em `/health`

---

## Localização no código

| Caminho                                                              | Responsabilidade                         |
| -------------------------------------------------------------------- | ---------------------------------------- |
| `apps/server/src/device/DeviceToolchain.ts`                          | Instalação e versionamento dos tools     |
| `apps/server/src/device/DeviceHost.ts`                               | Interface do DeviceHost (local e SSH)    |
| `apps/server/src/device/LocalDeviceHost.ts`                          | Host local — roda hub e agent-device     |
| `apps/server/src/device/SshDeviceHost.ts`                            | Host remoto via SSH                      |
| `apps/server/src/device/DeviceService.ts`                            | Orquestração geral do serviço            |
| `apps/server/src/device/AgentDeviceShim.ts`                          | Shim/launcher para o agent-device        |
| `apps/server/src/device/AgentDeviceTarget.ts`                        | Configuração por host (config + session) |
| `apps/server/src/mcp/toolkits/device/handlers.ts`                    | MCP tools expostas ao agente             |
| `apps/web/src/components/features/device/DeviceSetup.tsx`            | Wizard de setup na UI                    |
| `apps/web/src/components/features/settings/IntegrationsSettings.tsx` | Toggle nas settings                      |
| `docs/user/devices.md`                                               | Documentação do usuário                  |

---

## Resumo

| Pergunta                           | Resposta                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| **Que programa agente é esse?**    | `agent-device` (npm, Callstack, MIT) — controla simulators/emulators via CLI |
| **Está no código?**                | **Não** — é um pacote npm externo, instalado sob demanda                     |
| **O build é separado?**            | **Sim** — publicado independentemente no npm registry                        |
| **Quem gerencia a instalação?**    | O LMCS Server via `DeviceToolchain.ts` (npm install isolado)                 |
| **O que o `expo-device-hub` faz?** | Stream da tela do dispositivo para o painel web                              |
| **O que o `agent-device` faz?**    | Daemon HTTP que recebe comandos (tap, type, screenshot, etc.)                |
| **Como o agente acessa?**          | Via MCP tools + shim no PATH + variáveis de ambiente                         |
