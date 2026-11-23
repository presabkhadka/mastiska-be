import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDate, IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export const BOOKMARK_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'title',
] as const;
export type BookmarkSortField = (typeof BOOKMARK_SORT_FIELDS)[number];

const toBool = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class BookmarkQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BOOKMARK_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(BOOKMARK_SORT_FIELDS)
  sortBy: BookmarkSortField = 'createdAt';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tagId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  collectionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isArchived?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isFavorite?: boolean;

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
