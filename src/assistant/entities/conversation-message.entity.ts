import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity';
import { Conversation } from './conversation.entity';

export type MessageRole = 'user' | 'assistant';

@Entity('conversation_messages')
@Index('idx_conversation_messages_conv_created', [
  'conversationId',
  'createdAt',
])
// A retried POST with the same clientMessageId returns the original run.
@Index(
  'uq_conversation_messages_client_id',
  ['conversationId', 'clientMessageId'],
  {
    unique: true,
    where: '"client_message_id" IS NOT NULL',
  },
)
export class ConversationMessage extends BaseEntity {
  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation?: Conversation;

  @Column({ type: 'varchar', length: 16 })
  role: MessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'run_id', type: 'uuid', nullable: true })
  runId: string | null;

  @Column({
    name: 'client_message_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  clientMessageId: string | null;
}
