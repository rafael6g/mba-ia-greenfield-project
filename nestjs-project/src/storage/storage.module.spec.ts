import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import storageConfig from '../config/storage.config';

describe('StorageModule', () => {
  it('compiles and provides StorageService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);
  });
});
