import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  /** 1-based index of the uploaded part. */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** ETag returned by storage for the uploaded part. */
  @IsString()
  etag: string;
}

export class CompleteUploadDto {
  /** ETags of every part PUT to storage, used to finalize the multipart. */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
