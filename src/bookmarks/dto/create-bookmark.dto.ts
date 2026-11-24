import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateBookmarkDto {
  /**
   * Shape validation only. Safe-fetch rules (SSRF, private IPs, redirects)
   * belong to the ingestion pipeline.
   */
  @ApiProperty({ example: 'https://example.com/article' })
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  url: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;
}
