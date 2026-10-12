# Local LLM Provider

Plano para implementar um provider local que faz requests HTTP para servidores LLM locais
(llama.cpp, ollama, vLLM, LM Studio, etc.) usando formatos OpenAI Chat e Anthropic Messages.

## Contexto

O LMCS Code atualmente integra providers via CLI (Codex, Claude Code, Cursor, Grok, OpenCode).
Este provider permite conectar a servidores LLM locais que expõem APIs HTTP compatíveis com
OpenAI ou Anthropic, sem necessidade de CLI dedicado.

O servidor alvo pode ser:

- **llama.cpp** (`llama-server`) — suporta OpenAI Chat e Anthropic Messages
- **Ollama** — apenas OpenAI Chat
- **vLLM** — apenas OpenAI Chat
- **LM Studio** — apenas OpenAI Chat
- Qualquer servidor compatível com `/v1/chat/completions` ou `/v1/messages`

## Endpoints suportados

| Formato      | Endpoint                    | Header                                              |
| ------------ | --------------------------- | --------------------------------------------------- |
| OpenAI Chat  | `POST /v1/chat/completions` | `Authorization: Bearer <key>`                       |
| Anthropic    | `POST /v1/messages`         | `x-api-key: <key>`, `anthropic-version: 2023-06-01` |
| Health check | `GET /v1/models`            | —                                                   |

## Configuração

```typescript
// packages/core/src/contracts/settings.ts

export const LocalLlmSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean,
    baseUrl: TrimmedString, // "http://localhost:8080"
    apiKey: TrimmedString, // "" para local, ou token se necessário
    model: TrimmedString, // "llama3", "qwen2", etc.
    apiFormat: Schema.Literal("openai", "anthropic"),
    command: TrimmedString, // "llama-server -m model.gguf --port 8080"
    autoStart: Schema.Boolean, // start/stop server automaticamente
  },
  { order: ["baseUrl", "apiKey", "model", "apiFormat", "command", "autoStart"] },
);
```

## Arquitetura

```
apps/server/src/provider/Drivers/LocalLlm/
├── httpClient.ts          # Requests HTTP (OpenAI + Anthropic), SSE streaming
├── LocalLlmAdapter.ts     # ProviderAdapterShape — sessões, turnos, eventos
├── processManager.ts      # Start/stop do processo local (command)
├── textGeneration.ts      # TextGeneration para commit, PR, branch, title
└── LocalLlmDriver.ts      # ProviderDriver — factory que monta tudo
```

### httpClient.ts

Responsável pela comunicação HTTP com o servidor local.

```typescript
// OpenAI Chat Completions
export async function postOpenAiChat(
  baseUrl: string,
  apiKey: string,
  body: OpenAiChatBody,
  onDelta?: (delta: OpenAiChatDelta) => void,
): Promise<OpenAiChatResponse>;

// Anthropic Messages
export async function postAnthropicMessages(
  baseUrl: string,
  apiKey: string,
  body: AnthropicMessagesBody,
  onDelta?: (delta: AnthropicDelta) => void,
): Promise<AnthropicMessagesResponse>;

// Health check
export async function fetchModels(baseUrl: string): Promise<Model[]>;

// SSE parser genérico
function parseSseStream(response: Response, onEvent: (event: SseEvent) => void): Promise<void>;
```

**Detalhes de implementação:**

- Usar `fetch` nativo (Node 18+)
- Streaming via `response.body.getReader()` + `TextDecoder`
- OpenAI SSE: linhas `data: {...}`, terminador `data: [DONE]`
- Anthropic SSE: eventos nomeados (`message_start`, `content_block_delta`, `message_stop`)
- Abort controller para interrupção de turnos

### LocalLlmAdapter.ts

Implementa `ProviderAdapterShape<ProviderAdapterError>`.

```typescript
export function makeLocalLlmAdapter(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: "openai" | "anthropic";
}): ProviderAdapterShape<ProviderAdapterError>;
```

**Mapeamento de mensagens:**

LMCS → OpenAI:

```
UserMessage → { role: "user", content: "..." }
AssistantMessage → { role: "assistant", content: "..." }
SystemMessage → { role: "system", content: "..." }
ToolResult → { role: "tool", tool_call_id: "...", content: "..." }
```

LMCS → Anthropic:

```
UserMessage → { role: "user", content: "..." }
AssistantMessage → { role: "assistant", content: "..." }
SystemMessage → system parameter (fora de messages)
ToolResult → { role: "user", content: [{ type: "tool_result", tool_use_id: "...", content: "..." }] }
```

**Eventos emitidos (`ProviderRuntimeEvent`):**

- `textDelta` — token de texto gerado
- `toolCallStart` — início de chamada de função
- `toolCallDelta` — argumentos da função (streaming)
- `toolCallEnd` — fim da chamada
- `turnEnd` — fim do turno
- `error` — erro de comunicação

### processManager.ts

Gerencia o processo do servidor local quando `autoStart` está ativo.

```typescript
export interface ProcessManager {
  start(command: string): Effect<void, ProcessError>;
  stop(): Effect<void, ProcessError>;
  isRunning(): Effect<boolean>;
  waitForReady(baseUrl: string, timeoutMs: number): Effect<void, TimeoutError>;
}
```

**Implementação:**

- `start`: `child_process.spawn(command, { shell: true, detached: false })`
- `stop`: enviar SIGTERM, aguardar, SIGKILL se necessário
- `isRunning`: `GET /v1/models` com timeout curto
- `waitForReady`: polling em `GET /v1/models` até 200 OK ou timeout
- Track PID para cleanup em shutdown do servidor LMCS

### textGeneration.ts

Reutiliza o padrão de `OpenAiCompatibleTextGeneration.ts` (que já criamos).

```typescript
export function makeLocalLlmTextGeneration(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: "openai" | "anthropic";
}): TextGeneration["Service"];
```

Para formato OpenAI, delega diretamente para `makeOpenAiCompatibleTextGeneration`.
Para formato Anthropic, implementa as 4 operações via `POST /v1/messages`:

- `generateCommitMessage`
- `generatePrContent`
- `generateBranchName`
- `generateThreadTitle`

### LocalLlmDriver.ts

```typescript
export const LocalLlmDriver: ProviderDriver<LocalLlmSettings, LocalLlmDriverEnv> = {
  driverKind: ProviderDriverKind.make("localLlm"),
  metadata: {
    displayName: "Local LLM",
    supportsMultipleInstances: true,
  },
  configSchema: LocalLlmSettings,
  defaultConfig: () => ({
    enabled: false,
    baseUrl: "http://localhost:8080",
    apiKey: "",
    model: "",
    apiFormat: "openai",
    command: "",
    autoStart: false,
  }),
  create: (input) =>
    Effect.gen(function* () {
      const config = input.config;
      const processManager = makeProcessManager();

      // Auto-start se configurado
      if (config.autoStart && config.command) {
        yield* processManager.start(config.command);
        yield* processManager.waitForReady(config.baseUrl, 30_000);
      }

      const adapter = makeLocalLlmAdapter({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        apiFormat: config.apiFormat,
      });

      const textGeneration = makeLocalLlmTextGeneration({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        apiFormat: config.apiFormat,
      });

      const snapshot = yield* makeManagedServerProvider({/* ... */});

      return {
        instanceId: input.instanceId,
        driverKind: "localLlm",
        adapter,
        textGeneration,
        snapshot,
        // ...
      };
    }),
};
```

## Registro

```typescript
// apps/server/src/provider/builtInDrivers.ts

import { LocalLlmDriver } from "./Drivers/LocalLlm/LocalLlmDriver.js";

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  // ... existing drivers
  LocalLlmDriver,
];
```

## UI (Settings)

```
apps/web/src/components/features/settings/LocalLlmSettingsSection.tsx
```

Campos:

- **Base URL** — input text (default: `http://localhost:8080`)
- **API Key** — input password (default: vazio)
- **Model** — input text com autocomplete de `/v1/models`
- **API Format** — dropdown: OpenAI Chat / Anthropic Messages
- **Server Command** — input text (ex: `llama-server -m model.gguf --port 8080`)
- **Auto-start** — toggle

Botões:

- **Test Connection** — faz `GET /v1/models`, mostra lista de modelos disponíveis
- **Start Server** / **Stop Server** — quando `autoStart` está ativo

## Compatibilidade

| Servidor              | OpenAI Chat | Anthropic | Observações                                |
| --------------------- | :---------: | :-------: | ------------------------------------------ |
| llama.cpp             |     ✅      |    ✅     | Suporta ambos nativamente via `--api-type` |
| Ollama                |     ✅      |    ❌     | Apenas OpenAI format                       |
| vLLM                  |     ✅      |    ❌     | Apenas OpenAI format                       |
| LM Studio             |     ✅      |    ❌     | Apenas OpenAI format                       |
| text-generation-webui |     ✅      |    ❌     | Via extensão openai                        |

## Decisões de design

1. **Formato padrão: OpenAI** — mais compatível com servidores locais
2. **Auto-start: opt-in** — usuário define o comando explicitamente
3. **Streaming: sempre** — SSE parser para ambos formatos
4. **Tool calling: function calling** — formato OpenAI v1
5. **Múltiplas instâncias: sim** — cada configuração é uma instância independente

## Arquivos a criar/modificar

| Arquivo                                                                 | Ação                              |
| ----------------------------------------------------------------------- | --------------------------------- |
| `packages/core/src/contracts/settings.ts`                               | Adicionar `LocalLlmSettings`      |
| `packages/core/src/contracts/model.ts`                                  | Adicionar display name e defaults |
| `apps/server/src/provider/Drivers/LocalLlm/httpClient.ts`               | Novo                              |
| `apps/server/src/provider/Drivers/LocalLlm/LocalLlmAdapter.ts`          | Novo                              |
| `apps/server/src/provider/Drivers/LocalLlm/processManager.ts`           | Novo                              |
| `apps/server/src/provider/Drivers/LocalLlm/textGeneration.ts`           | Novo                              |
| `apps/server/src/provider/Drivers/LocalLlm/LocalLlmDriver.ts`           | Novo                              |
| `apps/server/src/provider/builtInDrivers.ts`                            | Registrar driver                  |
| `apps/web/src/components/features/settings/LocalLlmSettingsSection.tsx` | Novo                              |
| `apps/web/src/i18n/locales/en-US.json`                                  | Adicionar traduções               |
| `apps/web/src/i18n/locales/pt-BR.json`                                  | Adicionar traduções               |

## Ordem de implementação

1. Schema & contracts (`settings.ts`, `model.ts`)
2. HTTP client (`httpClient.ts`) — validar com curl primeiro
3. TextGeneration (`textGeneration.ts`) — reutiliza padrão existente
4. Adapter (`LocalLlmAdapter.ts`) — sessões e turnos
5. Process Manager (`processManager.ts`) — start/stop
6. Driver (`LocalLlmDriver.ts`) — factory e registro
7. UI (settings section)
8. Testes
