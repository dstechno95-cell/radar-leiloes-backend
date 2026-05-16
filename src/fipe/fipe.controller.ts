// src/fipe/fipe.controller.ts
import { Controller, Get, Query } from '@nestjs/common'
import { FipeService } from './fipe.service'

@Controller('fipe')
export class FipeController {
  constructor(private fipe: FipeService) {}

  // GET /api/v1/fipe/score?title=Honda+Civic+2019&price=42000
  @Get('score')
  async getScore(
    @Query('title') title: string,
    @Query('price') price: string,
  ) {
    const priceNum  = Number(price) || 0
    const fipeValue = await this.fipe.getValueByTitle(title)
    const score     = this.fipe.calculateScore({
      price:       priceNum,
      fipeValue,
      title,
      description: null,
    })

    return {
      title,
      price:      priceNum,
      fipeValue,
      ...score,
    }
  }

  // GET /api/v1/fipe/extract?title=Honda+Civic+EXL+2019
  @Get('extract')
  extractInfo(@Query('title') title: string) {
    return this.fipe.extractVehicleInfo(title)
  }
}