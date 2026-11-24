import { ApiProperty, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { SearchQueryDto } from '../../retrieval/dto/search-query.dto';

export class AskDto extends PickType(SearchQueryDto, [
  'collectionId',
  'tagId',
  'domain',
  'savedAfter',
  'savedBefore',
] as const) {
  @ApiProperty({ example: 'How do I make retries safe?', maxLength: 500 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  question: string;
}
