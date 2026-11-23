import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateTagDto {
  @ApiProperty({ example: 'distributed-systems', maxLength: 50 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string;
}

export class UpdateTagDto extends PartialType(CreateTagDto) {}
