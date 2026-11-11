import { Module } from '@nestjs/common';
import { QueueRuntimeService } from './queue-runtime.service';

@Module({
  providers: [QueueRuntimeService],
  exports: [QueueRuntimeService],
})
export class QueueModule {}
