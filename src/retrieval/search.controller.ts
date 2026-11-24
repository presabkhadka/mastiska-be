import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthUser,
} from '../auth/decorators/current-user.decorator';
import { SearchQueryDto } from './dto/search-query.dto';
import { RetrievalService, SearchResponse } from './retrieval.service';

@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly retrieval: RetrievalService) {}

  @Get()
  search(
    @CurrentUser() user: AuthUser,
    @Query() q: SearchQueryDto,
  ): Promise<SearchResponse> {
    return this.retrieval.search(user.id, q);
  }
}
