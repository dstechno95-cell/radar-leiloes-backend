import { Module } from '@nestjs/common'
import { ScraperService } from './scraper.service'
import { ScraperController } from './scraper.controller'
import { VipLeiloesSpider } from './spiders/vip-leiloes.spider'

@Module({
  providers: [ScraperService, VipLeiloesSpider],
  controllers: [ScraperController],
  exports: [ScraperService],
})
export class ScraperModule {}