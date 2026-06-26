import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), ChannelsModule, StorageModule],
  exports: [TypeOrmModule],
})
export class VideosModule {}
