import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const SEARCH_MODES = ['hybrid', 'vector', 'text'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class SearchQueryDto {
  @ApiProperty({ example: 'how do turnstiles work', maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  q: string;

  @ApiPropertyOptional({ enum: SEARCH_MODES, default: 'hybrid' })
  @IsOptional()
  @IsIn(SEARCH_MODES)
  mode: SearchMode = 'hybrid';

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 10;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  collectionId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tagId?: string;

  @ApiPropertyOptional({
    example: 'wikipedia.org',
    description: 'Matches the host and its subdomains',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @Matches(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, {
    message: 'domain must be a hostname',
  })
  @MaxLength(253)
  domain?: string;

  @ApiPropertyOptional({ description: 'Saved at or after (ISO 8601)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  savedAfter?: Date;

  @ApiPropertyOptional({ description: 'Saved before (ISO 8601)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  savedBefore?: Date;
}
