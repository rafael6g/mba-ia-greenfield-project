import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Short, opaque, URL-safe public identifier (nanoid) — the unique video URL.
  @Index({ unique: true })
  @Column({ type: 'varchar' })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoStatus,
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  // Object storage key of the original upload — `videos/{public_id}/source`.
  @Column({ type: 'varchar' })
  storage_key: string;

  // Set after processing — `videos/{public_id}/thumbnail.jpg`.
  @Column({ type: 'varchar', nullable: true })
  thumbnail_key: string | null;

  // S3 multipart UploadId while the upload is in progress; cleared on complete.
  @Column({ type: 'varchar', nullable: true })
  upload_id: string | null;

  // Duration in seconds (from ffprobe).
  @Column({ type: 'int', nullable: true })
  duration: number | null;

  // ffprobe subset: width, height, codec, bitrate, etc.
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', nullable: true })
  original_filename: string | null;

  // bigint is mapped to string by TypeORM to avoid precision loss.
  @Column({ type: 'bigint', nullable: true })
  size_bytes: string | null;

  // Populated when status = 'failed'.
  @Column({ type: 'varchar', nullable: true })
  error_reason: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
