import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateNoteDto {
  @ApiProperty({ maxLength: 20000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  body: string;
}

export class UpdateNoteDto extends CreateNoteDto {}
