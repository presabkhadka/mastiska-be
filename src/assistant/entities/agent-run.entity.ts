import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity';
import type { GeminiContent } from '../../answer/gemini-generator';
import { Conversation } from './conversation.entity';

export enum RunStatus {
  Running = 'running',
  AwaitingApproval = 'awaiting_approval',
  Completed = 'completed',
  Failed = 'failed',
  LimitExceeded = 'limit_exceeded',
}

/** One assistant turn: the model/tool loop that answers a user message. */
@Entity('agent_runs')
// At most one unfinished run per conversation, so turns can't interleave.
@Index('uq_agent_runs_active_per_conversation', ['conversationId'], {
  unique: true,
  where: `"status" IN ('running', 'awaiting_approval')`,
})
export class AgentRun extends BaseEntity {
  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation?: Conversation;

  @Column({ name: 'user_message_id', type: 'uuid' })
  userMessageId: string;

  @Column({
    type: 'enum',
    enum: RunStatus,
    enumName: 'agent_run_status',
    default: RunStatus.Running,
  })
  status: RunStatus;

  /** Pinned after the first step: thought signatures only replay to the same model. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  model: string | null;

  @Column({ type: 'int', default: 0 })
  steps: number;

  @Column({ name: 'tool_call_count', type: 'int', default: 0 })
  toolCallCount: number;

  @Column({ name: 'tokens_used', type: 'int', default: 0 })
  tokensUsed: number;

  /** Raw model/tool turns of this run (with thought signatures), to resume after approval. */
  @Column({ type: 'jsonb', default: () => `'[]'` })
  contents: GeminiContent[];

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
