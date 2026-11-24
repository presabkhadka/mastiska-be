import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnswerModule } from '../answer/answer.module';
import { BookmarksModule } from '../bookmarks/bookmarks.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { AgentRun } from './entities/agent-run.entity';
import { ConversationMessage } from './entities/conversation-message.entity';
import { Conversation } from './entities/conversation.entity';
import { ToolCall } from './entities/tool-call.entity';
import { CreateCollectionTool } from './tools/create-collection.tool';
import { GetRelatedResourcesTool } from './tools/get-related-resources.tool';
import { GetResourceTool } from './tools/get-resource.tool';
import { SearchLibraryTool } from './tools/search-library.tool';
import { ToolRegistry } from './tools/tool-registry';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Conversation,
      ConversationMessage,
      AgentRun,
      ToolCall,
    ]),
    AnswerModule,
    BookmarksModule,
    RetrievalModule,
    RateLimitModule,
  ],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    ToolRegistry,
    SearchLibraryTool,
    GetResourceTool,
    GetRelatedResourcesTool,
    CreateCollectionTool,
  ],
})
export class AssistantModule {}
