import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SendMessageDto {
  @ApiProperty({
    example: 'What have I saved about idempotency?',
    maxLength: 4000,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content: string;

  @ApiPropertyOptional({
    description:
      'Client-generated id; resending the same id returns the original reply instead of running again.',
    maxLength: 100,
  })
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,100}$/, {
    message: 'clientMessageId may contain letters, digits, _ and - (max 100)',
  })
  clientMessageId?: string;
}

export class CreateConversationDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}
