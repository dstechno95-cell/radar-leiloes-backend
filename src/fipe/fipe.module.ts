// src/fipe/fipe.module.ts
import { Module } from '@nestjs/common'
import { FipeService } from './fipe.service'
import { FipeController } from './fipe.controller'

@Module({
  providers:   [FipeService],
  controllers: [FipeController],
  exports:     [FipeService],
})
export class FipeModule {}