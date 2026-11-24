import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

export class CreateNoteDto {
  @ApiProperty({ maxLength: 20000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  body: string;
}

export class UpdateNoteDto extends CreateNoteDto {
  @ApiProperty({
    description: 'The version you last read; a stale version returns 409.',
    example: 1,
  })
  @IsInt()
  @Min(1)
  version: number;
}
