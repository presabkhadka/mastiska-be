import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  GeminiContent,
  GeminiGenerator,
  GeminiPart,
  GenerateResult,
} from '../answer/gemini-generator';
import { isUniqueViolation } from '../common/db-errors';
import { paginate, Paginated } from '../common/dto/paginated.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { errorMessage } from '../ingestion/ingestion-errors';
import { SYSTEM_PROMPT } from './assistant.prompt';
import { SendMessageDto } from './dto/send-message.dto';
import { AgentRun, RunStatus } from './entities/agent-run.entity';
import { ConversationMessage } from './entities/conversation-message.entity';
import { Conversation } from './entities/conversation.entity';
import { ToolCall, ToolCallStatus } from './entities/tool-call.entity';
import { ToolRegistry } from './tools/tool-registry';
import { ToolError } from './tools/tool.types';

export const LIMITS = {
  /** Model calls per run; the last one is forced to answer without tools. */
  maxSteps: 6,
  maxToolCalls: 8,
  maxTokens: 40_000,
  /** Wall-clock budget for one HTTP request driving the loop. */
  requestBudgetMs: 90_000,
  /** Time kept for the forced final answer. */
  finalStepReserveMs: 25_000,
  historyMessages: 20,
  toolResultChars: 8_000,
};

export interface TurnView {
  conversationId: string;
  run: Pick<
    AgentRun,
    | 'id'
    | 'status'
    | 'model'
    | 'steps'
    | 'toolCallCount'
    | 'tokensUsed'
    | 'error'
  >;
  messages: Pick<
    ConversationMessage,
    'id' | 'role' | 'content' | 'createdAt'
  >[];
  toolCalls: Pick<
    ToolCall,
    | 'id'
    | 'step'
    | 'name'
    | 'args'
    | 'status'
    | 'requiresApproval'
    | 'result'
    | 'error'
  >[];
  pendingApprovals: { toolCallId: string; name: string; summary: string }[];
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationMessage)
    private readonly messages: Repository<ConversationMessage>,
    @InjectRepository(AgentRun) private readonly runs: Repository<AgentRun>,
    @InjectRepository(ToolCall)
    private readonly toolCalls: Repository<ToolCall>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: ToolRegistry,
    private readonly generator: GeminiGenerator,
  ) {}

  // --- Conversations ---

  createConversation(userId: string, title?: string): Promise<Conversation> {
    return this.conversations.save(
      this.conversations.create({ userId, title: title ?? null }),
    );
  }

  async listConversations(
    userId: string,
    q: PaginationQueryDto,
  ): Promise<Paginated<Conversation>> {
    const [items, total] = await this.conversations.findAndCount({
      where: { userId },
      order: { updatedAt: q.order, id: q.order },
      skip: q.skip,
      take: q.limit,
    });
    return paginate(items, total, q.page, q.limit);
  }

  async getConversation(userId: string, id: string) {
    const conversation = await this.owned(userId, id);
    const [messages, toolCalls] = await Promise.all([
      this.messages.find({
        where: { conversationId: id },
        order: { createdAt: 'ASC' },
      }),
      this.toolCalls.find({
        where: { conversationId: id },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return { conversation, messages, toolCalls };
  }

  async deleteConversation(userId: string, id: string): Promise<void> {
    const res = await this.conversations.delete({ id, userId });
    if (!res.affected) throw new NotFoundException('Conversation not found');
  }

  // --- Turns ---

  async sendMessage(
    userId: string,
    conversationId: string,
    dto: SendMessageDto,
  ): Promise<TurnView> {
    const conversation = await this.owned(userId, conversationId);

    const retried = await this.runForClientMessage(
      conversationId,
      dto.clientMessageId,
    );
    if (retried) return this.view(retried);

    let run: AgentRun;
    try {
      run = await this.dataSource.transaction(async (m) => {
        const message = await m.save(
          m.create(ConversationMessage, {
            conversationId,
            role: 'user',
            content: dto.content,
            clientMessageId: dto.clientMessageId ?? null,
            runId: null,
          }),
        );
        const created = await m.save(
          m.create(AgentRun, {
            conversationId,
            userMessageId: message.id,
            status: RunStatus.Running,
            contents: [],
          }),
        );
        await m.update(ConversationMessage, message.id, { runId: created.id });
        // Also bumps updated_at so the conversation list sorts by activity.
        await m.update(Conversation, conversationId, {
          title: conversation.title ?? dto.content.slice(0, 80),
        });
        return created;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const again = await this.runForClientMessage(
        conversationId,
        dto.clientMessageId,
      );
      if (again) return this.view(again);
      if (constraintOf(err) === 'uq_agent_runs_active_per_conversation') {
        throw new ConflictException(
          'The previous message in this conversation is still running or waiting for approval',
        );
      }
      throw err;
    }
    return this.drive(run, userId);
  }

  /** Approve or reject a write the assistant proposed, then let the run continue. */
  async decide(
    userId: string,
    conversationId: string,
    toolCallId: string,
    approve: boolean,
  ): Promise<TurnView> {
    await this.owned(userId, conversationId);
    const call = await this.toolCalls.findOneBy({
      id: toolCallId,
      conversationId,
    });
    if (!call) throw new NotFoundException('Tool call not found');

    if (call.status !== ToolCallStatus.AwaitingApproval) {
      // Repeated or racing clicks: report the outcome instead of acting twice.
      if (approve && call.status === ToolCallStatus.Rejected) {
        throw new ConflictException('This action was already rejected');
      }
      if (!approve && call.status === ToolCallStatus.Succeeded) {
        throw new ConflictException('This action already ran');
      }
      return this.view(await this.runs.findOneByOrFail({ id: call.runId }));
    }

    if (approve) await this.executeApproved(call, userId);
    else {
      await this.toolCalls
        .createQueryBuilder()
        .update()
        .set({
          status: ToolCallStatus.Rejected,
          error:
            'The user rejected this action. Do not retry it; tell the user it was not done.',
          finishedAt: () => 'now()',
        })
        .where('id = :id AND status = :s', {
          id: call.id,
          s: ToolCallStatus.AwaitingApproval,
        })
        .execute();
    }
    return this.resume(call.runId, userId);
  }

  // --- Agent loop ---

  private async drive(run: AgentRun, userId: string): Promise<TurnView> {
    const started = Date.now();
    const history = await this.history(run);

    for (;;) {
      const timeLeft = LIMITS.requestBudgetMs - (Date.now() - started);
      const forceAnswer =
        run.steps >= LIMITS.maxSteps - 1 ||
        run.toolCallCount >= LIMITS.maxToolCalls ||
        run.tokensUsed >= LIMITS.maxTokens ||
        timeLeft < LIMITS.finalStepReserveMs;

      let gen: GenerateResult<GeminiContent>;
      try {
        gen = await this.generate(history, run, forceAnswer, timeLeft);
      } catch (err) {
        return this.finish(
          run,
          RunStatus.Failed,
          'Sorry, the assistant model is unavailable right now. Please try again in a moment.',
          errorMessage(err),
        );
      }

      run.model ??= gen.model;
      run.steps += 1;
      run.tokensUsed += Number(gen.usage?.totalTokenCount ?? 0);
      run.contents = [...run.contents, gen.value];

      const calls = gen.value.parts.filter((p) => p.functionCall);
      if (calls.length === 0) {
        const text = gen.value.parts
          .filter((p) => p.text && !p.thought)
          .map((p) => p.text)
          .join('')
          .trim();
        return this.finish(
          run,
          RunStatus.Completed,
          text || 'I could not produce an answer.',
        );
      }
      if (forceAnswer) {
        return this.finish(
          run,
          RunStatus.LimitExceeded,
          'I stopped because this request needed more steps than I am allowed. Try a narrower question.',
          'model kept calling tools after the limit',
        );
      }

      for (const part of calls)
        await this.handleCall(run, part.functionCall!, userId);

      const pending = await this.toolCalls.countBy({
        runId: run.id,
        step: run.steps,
        status: ToolCallStatus.AwaitingApproval,
      });
      if (pending > 0) return this.pause(run);

      run.contents = [...run.contents, await this.responsesFor(run)];
      await this.saveProgress(run);
    }
  }

  private async handleCall(
    run: AgentRun,
    call: NonNullable<GeminiPart['functionCall']>,
    userId: string,
  ): Promise<void> {
    run.toolCallCount += 1;
    const base = {
      runId: run.id,
      conversationId: run.conversationId,
      step: run.steps,
      modelCallId: call.id ?? null,
      name: call.name,
      args: call.args ?? {},
    };
    const save = (fields: Partial<ToolCall>) =>
      this.toolCalls.save(this.toolCalls.create({ ...base, ...fields }));

    const parsed = await this.registry.parse(call.name, call.args);
    if (!parsed.ok) {
      await save({ status: ToolCallStatus.Invalid, error: parsed.error });
      return;
    }
    const { tool, args } = parsed;
    const plainArgs = toPlain(args);

    if (tool.requiresApproval) {
      const earlier = await this.sameWriteInRun(run.id, tool.name, plainArgs);
      if (earlier?.status === ToolCallStatus.Succeeded) {
        // The model repeated a write it already made: report it, don't redo it.
        await save({
          args: plainArgs,
          requiresApproval: true,
          status: ToolCallStatus.Succeeded,
          result: {
            ...earlier.result,
            note: 'Already done earlier in this turn; not repeated.',
          },
          finishedAt: new Date(),
        });
        return;
      }
      if (earlier?.status === ToolCallStatus.AwaitingApproval) {
        await save({
          args: plainArgs,
          status: ToolCallStatus.Invalid,
          error: 'Duplicate of a call already waiting for approval',
        });
        return;
      }
      const problem = tool.precheck
        ? await tool.precheck(args, { userId })
        : null;
      await save(
        problem
          ? {
              args: plainArgs,
              requiresApproval: true,
              status: ToolCallStatus.Failed,
              error: problem,
            }
          : {
              args: plainArgs,
              requiresApproval: true,
              status: ToolCallStatus.AwaitingApproval,
            },
      );
      return;
    }

    try {
      const result = await tool.execute(args, { userId });
      await save({
        args: plainArgs,
        status: ToolCallStatus.Succeeded,
        result: capResult(result),
        finishedAt: new Date(),
      });
    } catch (err) {
      if (!(err instanceof ToolError)) {
        this.logger.error(
          `Tool ${tool.name} failed in run ${run.id}: ${errorMessage(err)}`,
        );
      }
      await save({
        args: plainArgs,
        status: ToolCallStatus.Failed,
        error:
          err instanceof ToolError
            ? err.message
            : 'The tool failed unexpectedly',
        finishedAt: new Date(),
      });
    }
  }

  /**
   * Claims the call (awaiting_approval → running) and runs the write in the
   * same transaction as its status update, so a crash can't leave a created
   * collection without a recorded result, and a second approval can't redo it.
   */
  private async executeApproved(call: ToolCall, userId: string): Promise<void> {
    const parsed = await this.registry.parse(call.name, call.args);
    if (!parsed.ok) throw new ConflictException(parsed.error);
    const { tool, args } = parsed;

    await this.dataSource.transaction(async (m) => {
      const claimed = await m
        .createQueryBuilder()
        .update(ToolCall)
        .set({ status: ToolCallStatus.Running })
        .where('id = :id AND status = :s', {
          id: call.id,
          s: ToolCallStatus.AwaitingApproval,
        })
        .execute();
      if (claimed.affected !== 1) return;
      try {
        const result = await tool.execute(args, { userId, manager: m });
        await m.update(ToolCall, call.id, {
          status: ToolCallStatus.Succeeded,
          result: jsonColumn(capResult(result)),
          finishedAt: new Date(),
        });
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        await m.update(ToolCall, call.id, {
          status: ToolCallStatus.Failed,
          error: err.message,
          finishedAt: new Date(),
        });
      }
    });
  }

  private async resume(runId: string, userId: string): Promise<TurnView> {
    const run = await this.runs.findOneByOrFail({ id: runId });
    const pending = await this.toolCalls.countBy({
      runId,
      status: ToolCallStatus.AwaitingApproval,
    });
    if (pending > 0 || run.status !== RunStatus.AwaitingApproval)
      return this.view(run);

    // Only one request continues the run, even if two approvals land together.
    const moved = await this.runs
      .createQueryBuilder()
      .update()
      .set({ status: RunStatus.Running })
      .where('id = :id AND status = :s', {
        id: runId,
        s: RunStatus.AwaitingApproval,
      })
      .execute();
    if (moved.affected !== 1)
      return this.view(await this.runs.findOneByOrFail({ id: runId }));

    run.status = RunStatus.Running;
    run.contents = [...run.contents, await this.responsesFor(run)];
    await this.saveProgress(run);
    return this.drive(run, userId);
  }

  private async pause(run: AgentRun): Promise<TurnView> {
    const pending = await this.toolCalls.find({
      where: { runId: run.id, status: ToolCallStatus.AwaitingApproval },
      order: { createdAt: 'ASC' },
    });
    const asks = await Promise.all(pending.map((c) => this.summary(c)));
    await this.dataSource.transaction(async (m) => {
      await m.update(AgentRun, run.id, {
        status: RunStatus.AwaitingApproval,
        ...progressFields(run),
      });
      await m.save(
        m.create(ConversationMessage, {
          conversationId: run.conversationId,
          role: 'assistant',
          content: `I need your approval to ${asks.join(' and ')}. Approve or reject it to continue.`,
          runId: run.id,
        }),
      );
    });
    run.status = RunStatus.AwaitingApproval;
    return this.view(run);
  }

  private async finish(
    run: AgentRun,
    status: RunStatus,
    text: string,
    error: string | null = null,
  ): Promise<TurnView> {
    await this.dataSource.transaction(async (m) => {
      await m.update(AgentRun, run.id, {
        status,
        error,
        finishedAt: new Date(),
        ...progressFields(run),
      });
      await m.save(
        m.create(ConversationMessage, {
          conversationId: run.conversationId,
          role: 'assistant',
          content: text,
          runId: run.id,
        }),
      );
    });
    this.logger.log(
      `run ${run.id}: ${status} via ${run.model ?? '-'}, ${run.steps} steps, ${run.toolCallCount} tool calls, ${run.tokensUsed} tokens${error ? ` (${error})` : ''}`,
    );
    return this.view(await this.runs.findOneByOrFail({ id: run.id }));
  }

  // --- Helpers ---

  /**
   * Thought signatures in this run only replay to the model that made them, so
   * the run is pinned to one model. If that model fails mid-run, the run's tool
   * calls are rewritten as plain text (no signatures) and any model may continue.
   */
  private async generate(
    history: GeminiContent[],
    run: AgentRun,
    forceAnswer: boolean,
    timeLeft: number,
  ): Promise<GenerateResult<GeminiContent>> {
    const deadlineMs = Math.max(timeLeft, 10_000);
    if (run.model) {
      try {
        return await this.generator.generateContent(
          this.requestBody([...history, ...run.contents], forceAnswer),
          { models: [run.model], deadlineMs },
        );
      } catch (err) {
        this.logger.warn(
          `run ${run.id}: ${run.model} failed mid-run (${errorMessage(err)}); continuing with tool history as text`,
        );
        run.contents = asPlainText(run.contents);
        run.model = null;
      }
    }
    return this.generator.generateContent(
      this.requestBody([...history, ...run.contents], forceAnswer),
      { deadlineMs },
    );
  }

  private requestBody(contents: GeminiContent[], forceAnswer: boolean) {
    return {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      tools: this.registry.declarations(),
      toolConfig: {
        functionCallingConfig: { mode: forceAnswer ? 'NONE' : 'AUTO' },
      },
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingLevel: 'low' },
      },
    };
  }

  /**
   * Earlier turns as plain text (no tool calls or thought signatures, which only
   * replay to the model that produced them), then this run's user message.
   */
  private async history(run: AgentRun): Promise<GeminiContent[]> {
    const recent = await this.messages
      .createQueryBuilder('msg')
      .where('msg.conversationId = :cid', { cid: run.conversationId })
      .andWhere('(msg.runId IS NULL OR msg.runId <> :rid)', { rid: run.id })
      .orderBy('msg.createdAt', 'DESC')
      .limit(LIMITS.historyMessages)
      .getMany();
    const current = await this.messages.findOneByOrFail({
      id: run.userMessageId,
    });

    const turns: GeminiContent[] = recent.reverse().map((msg) => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }],
    }));
    while (turns.length && turns[0].role === 'model') turns.shift();
    return [...turns, { role: 'user', parts: [{ text: current.content }] }];
  }

  /** functionResponse parts for every call of the run's current step. */
  private async responsesFor(run: AgentRun): Promise<GeminiContent> {
    const calls = await this.toolCalls.find({
      where: { runId: run.id, step: run.steps },
      order: { createdAt: 'ASC' },
    });
    return {
      role: 'user',
      parts: calls.map((c) => ({
        functionResponse: {
          ...(c.modelCallId ? { id: c.modelCallId } : {}),
          name: c.name,
          response:
            c.status === ToolCallStatus.Succeeded
              ? {
                  result: c.result ?? {},
                  // Otherwise the model tends to ask for approval that was already given.
                  ...(c.requiresApproval
                    ? {
                        outcome:
                          'The user approved this action and it has been completed.',
                      }
                    : {}),
                }
              : { error: c.error ?? 'The tool call failed' },
        },
      })),
    };
  }

  private saveProgress(run: AgentRun) {
    return this.runs.update(run.id, progressFields(run));
  }

  private sameWriteInRun(
    runId: string,
    name: string,
    args: Record<string, unknown>,
  ) {
    return this.toolCalls
      .createQueryBuilder('tc')
      .where('tc.runId = :runId AND tc.name = :name', { runId, name })
      .andWhere('tc.args = :args::jsonb', { args: JSON.stringify(args) })
      .andWhere('tc.status IN (:...statuses)', {
        statuses: [ToolCallStatus.Succeeded, ToolCallStatus.AwaitingApproval],
      })
      .orderBy('tc.createdAt', 'ASC')
      .getOne();
  }

  private async summary(call: ToolCall): Promise<string> {
    const parsed = await this.registry.parse(call.name, call.args);
    if (!parsed.ok || !parsed.tool.describe) return `run ${call.name}`;
    const run = await this.runs.findOneByOrFail({ id: call.runId });
    const conversation = await this.conversations.findOneByOrFail({
      id: run.conversationId,
    });
    return parsed.tool.describe(parsed.args, { userId: conversation.userId });
  }

  private async runForClientMessage(
    conversationId: string,
    clientMessageId?: string,
  ) {
    if (!clientMessageId) return null;
    const message = await this.messages.findOneBy({
      conversationId,
      clientMessageId,
    });
    return message?.runId ? this.runs.findOneBy({ id: message.runId }) : null;
  }

  private async owned(userId: string, id: string): Promise<Conversation> {
    const conversation = await this.conversations.findOneBy({ id, userId });
    // 404 (not 403) for other users' conversations: don't leak existence.
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  private async view(run: AgentRun): Promise<TurnView> {
    const [messages, calls] = await Promise.all([
      this.messages.find({
        where: { runId: run.id },
        order: { createdAt: 'ASC' },
      }),
      this.toolCalls.find({
        where: { runId: run.id },
        order: { createdAt: 'ASC' },
      }),
    ]);
    const pending = calls.filter(
      (c) => c.status === ToolCallStatus.AwaitingApproval,
    );
    return {
      conversationId: run.conversationId,
      run: {
        id: run.id,
        status: run.status,
        model: run.model,
        steps: run.steps,
        toolCallCount: run.toolCallCount,
        tokensUsed: run.tokensUsed,
        error: run.error,
      },
      messages: messages.map(({ id, role, content, createdAt }) => ({
        id,
        role,
        content,
        createdAt,
      })),
      toolCalls: calls.map(
        ({
          id,
          step,
          name,
          args,
          status,
          requiresApproval,
          result,
          error,
        }) => ({
          id,
          step,
          name,
          args,
          status,
          requiresApproval,
          result,
          error,
        }),
      ),
      pendingApprovals: await Promise.all(
        pending.map(async (c) => ({
          toolCallId: c.id,
          name: c.name,
          summary: await this.summary(c),
        })),
      ),
    };
  }
}

// TypeORM's update() types can't express nested JSON columns; the values are plain JSON.
const jsonColumn = (value: unknown) => value as never;

function progressFields(run: AgentRun): QueryDeepPartialEntity<AgentRun> {
  return {
    contents: jsonColumn(run.contents),
    steps: run.steps,
    toolCallCount: run.toolCallCount,
    tokensUsed: run.tokensUsed,
    model: run.model,
  };
}

/** Turns function-call turns into text so a different model can read them. */
export function asPlainText(contents: GeminiContent[]): GeminiContent[] {
  return contents
    .map((c) => ({
      role: c.role,
      parts: c.parts
        .filter((p) => !p.thought)
        .map((p) => {
          if (p.functionCall) {
            return {
              text: `[called ${p.functionCall.name} with ${JSON.stringify(p.functionCall.args ?? {})}]`,
            };
          }
          if (p.functionResponse) {
            return {
              text: `[${p.functionResponse.name} returned ${JSON.stringify(p.functionResponse.response).slice(0, LIMITS.toolResultChars)}]`,
            };
          }
          return { text: p.text ?? '' };
        })
        .filter((p) => p.text),
    }))
    .filter((c) => c.parts.length > 0);
}

function toPlain(args: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
}

/** Keeps tool output from blowing the token budget. */
function capResult(result: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(result);
  return json.length <= LIMITS.toolResultChars
    ? result
    : { truncated: true, partialJson: json.slice(0, LIMITS.toolResultChars) };
}

function constraintOf(err: unknown): string | undefined {
  return err instanceof QueryFailedError
    ? (err.driverError as { constraint?: string }).constraint
    : undefined;
}
