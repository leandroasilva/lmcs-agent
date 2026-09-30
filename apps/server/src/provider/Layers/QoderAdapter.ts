import {
  ApprovalRequestId,
  type QoderSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  TurnId,
  DEFAULT_RUNTIME_MODE,
} from "@lmcstools/core";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import type { QoderAdapterShape } from "../Services/QoderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("qoder");

export interface QoderAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly instanceId?: ProviderInstanceId;
}

interface QoderSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<
    | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
    | { readonly _tag: "cancelled" }
  >;
}

const nowIso = () => Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Qoder adapter — stub implementation.
 *
 * TODO: Integrate with the Qoder Agent SDK (query() with async iterators,
 * PAT auth via QODER_PERSONAL_ACCESS_TOKEN).
 */
export function makeQoderAdapter(
  config: QoderSettings,
  options: QoderAdapterLiveOptions = {},
): Effect.Effect<QoderAdapterShape, never> {
  return Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<ThreadId, QoderSessionContext>());
    const eventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const pendingApprovals = yield* Ref.make(
      new Map<ApprovalRequestId, PendingApproval>(),
    );
    const pendingUserInputs = yield* Ref.make(
      new Map<ApprovalRequestId, PendingUserInput>(),
    );

    // Store the favorite model from settings for use in sendTurn
    const favoriteModel = config.favoriteModel?.trim() || undefined;

    const emit = (event: ProviderRuntimeEvent) =>
      PubSub.publish(eventPubSub, event);

    const asEventId = (suffix: string) =>
      EventId.make(`qoder:${options.instanceId ?? "default"}:${suffix}`);

    const startSession = (input: {
      threadId: ThreadId;
      cwd?: string;
      runtimeMode?: string;
      providerInstanceId?: ProviderInstanceId;
      resumeCursor?: { opaque: string };
    }) =>
      Effect.gen(function* () {
        const now = yield* nowIso();
        const scope = yield* Scope.make();

        const session: ProviderSession = {
          provider: PROVIDER,
          ...(input.providerInstanceId !== undefined
            ? { providerInstanceId: input.providerInstanceId }
            : {}),
          status: "ready",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          threadId: input.threadId,
          resumeCursor: input.resumeCursor ?? {
            opaque: `qoder-resume-${String(input.threadId)}`,
          },
          cwd: input.cwd ?? process.cwd(),
          createdAt: now,
          updatedAt: now,
        };

        const context: QoderSessionContext = {
          threadId: input.threadId,
          session,
          scope,
          turns: [],
        };

        yield* Ref.update(sessions, (map) => map.set(input.threadId, context));

        yield* emit({
          type: "session.started",
          eventId: asEventId(`session-started-${String(input.threadId)}`),
          provider: PROVIDER,
          createdAt: now,
          threadId: input.threadId,
          payload: { message: "Qoder session started" },
        });

        return session;
      });

    const sendTurn = (input: {
      threadId: ThreadId;
      prompt: string;
      model?: string;
      attachments?: ReadonlyArray<unknown>;
    }) =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        const context = sessionMap.get(input.threadId);

        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        const turnId = TurnId.make(
          `qoder-turn-${String(input.threadId)}-${context.turns.length + 1}`,
        );

        // Use the model from input, or fall back to favorite model from settings
        const selectedModel = input.model || favoriteModel;

        context.turns.push({ id: turnId, items: [] });

        // TODO: Integrate with Qoder SDK query() here
        // When SDK is integrated, pass selectedModel to query() options
        yield* emit({
          type: "turn.started",
          eventId: asEventId(`turn-started-${String(turnId)}`),
          provider: PROVIDER,
          createdAt: context.session.updatedAt,
          threadId: input.threadId,
          payload: { model: selectedModel },
        });

        return {
          threadId: input.threadId,
          turnId,
        };
      });

    const interruptTurn = (threadId: ThreadId, _turnId?: TurnId) =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        const context = sessionMap.get(threadId);

        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        // TODO: Call q.interrupt() from Qoder SDK
        yield* emit({
          type: "turn.aborted",
          eventId: asEventId(`turn-aborted-${String(threadId)}`),
          provider: PROVIDER,
          createdAt: yield* nowIso(),
          threadId,
          payload: { reason: "interrupted" },
        });
      });

    const respondToRequest = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ) =>
      Effect.gen(function* () {
        const approvalsMap = yield* Ref.get(pendingApprovals);
        const pending = approvalsMap.get(requestId);

        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail: "No pending approval found",
          });
        }

        yield* Deferred.succeed(pending.decision, decision);
        yield* Ref.update(pendingApprovals, (map) => {
          const next = new Map(map);
          next.delete(requestId);
          return next;
        });
      });

    const respondToUserInput = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        const inputsMap = yield* Ref.get(pendingUserInputs);
        const pending = inputsMap.get(requestId);

        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToUserInput",
            detail: "No pending user input found",
          });
        }

        yield* Deferred.succeed(pending.resolution, {
          _tag: "answered",
          answers,
        });
        yield* Ref.update(pendingUserInputs, (map) => {
          const next = new Map(map);
          next.delete(requestId);
          return next;
        });
      });

    const stopSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        const context = sessionMap.get(threadId);

        if (!context) {
          return;
        }

        yield* Scope.close(context.scope, Exit.void);

        yield* Ref.update(sessions, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });

        yield* emit({
          type: "session.exited",
          eventId: asEventId(`session-exited-${String(threadId)}`),
          provider: PROVIDER,
          createdAt: yield* nowIso(),
          threadId,
          payload: { reason: "stopped" },
        });
      });

    const listSessions = () =>
      Ref.get(sessions).pipe(
        Effect.map((map) => Array.from(map.values()).map((ctx) => ctx.session)),
      );

    const hasSession = (threadId: ThreadId) =>
      Ref.get(sessions).pipe(Effect.map((map) => map.has(threadId)));

    const readThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        const context = sessionMap.get(threadId);

        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        return {
          threadId,
          turns: context.turns.map((t) => ({
            id: t.id,
            items: t.items,
          })),
        };
      });

    const rollbackThread = (threadId: ThreadId, _numTurns: number) =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        const has = sessionMap.has(threadId);

        if (!has) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        // TODO: Implement rollback via Qoder SDK
        const context = sessionMap.get(threadId)!;
        return {
          threadId,
          turns: context.turns.map((t) => ({
            id: t.id,
            items: t.items,
          })),
        };
      });

    const uploadFeedback = (_input: unknown) => Effect.void;

    const stopAll = () =>
      Effect.gen(function* () {
        const sessionMap = yield* Ref.get(sessions);
        for (const threadId of sessionMap.keys()) {
          yield* stopSession(threadId);
        }
      });

    const streamEvents = Stream.fromPubSub(eventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      uploadFeedback,
      stopAll,
      streamEvents,
    } satisfies QoderAdapterShape;
  });
}
