import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity';
import { AgentRun } from './agent-run.entity';

export enum ToolCallStatus {
  Invalid = 'invalid',
  AwaitingApproval = 'awaiting_approval',
  Rejected = 'rejected',
  Running = 'running',
  Succeeded = 'succeeded',
  Failed = 'failed',
}

@Entity('tool_calls')
@Index('idx_tool_calls_run_created', ['runId', 'createdAt'])
export class ToolCall extends BaseEntity {
  @Column({ name: 'run_id', type: 'uuid' })
  runId: string;

  @ManyToOne(() => AgentRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run?: AgentRun;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @Column({ type: 'int' })
  step: number;

  /** Gemini's id for the call, echoed back in the functionResponse. */
  @Column({
    name: 'model_call_id',
    type: 'varchar',
    length: 200,
    nullable: true,
  })
  modelCallId: string | null;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'jsonb' })
  args: Record<string, unknown>;

  @Column({
    type: 'enum',
    enum: ToolCallStatus,
    enumName: 'tool_call_status',
  })
  status: ToolCallStatus;

  @Column({ name: 'requires_approval', type: 'boolean', default: false })
  requiresApproval: boolean;

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
