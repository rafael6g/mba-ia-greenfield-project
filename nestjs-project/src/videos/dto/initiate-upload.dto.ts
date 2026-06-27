import { IsInt, IsString, MaxLength, Min } from 'class-validator';

export class InitiateUploadDto {
  /** Video title shown to viewers. */
  @IsString()
  @MaxLength(255)
  title: string;

  /** Original file name, kept for the download disposition. */
  @IsString()
  filename: string;

  /** MIME type of the upload — must be a `video/*` type. */
  @IsString()
  contentType: string;

  /** Total size of the upload in bytes (1 … VIDEO_MAX_SIZE_BYTES). */
  @IsInt()
  @Min(1)
  sizeBytes: number;
}
