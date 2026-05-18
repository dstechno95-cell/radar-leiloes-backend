import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { ScraperService } from './scraper.service'
import { ScraperController } from './scraper.controller'
import { VipLeiloesSpider } from './spiders/vip-leiloes.spider'
import { LanceCertoSpider } from './spiders/lance-certo.spider'
import { LeiloSpider } from './spiders/leilo.spider'
import { LeilaoJudicialSpider } from './spiders/leilao-judicial.spider'
import { SuperbidSpider } from './spiders/superbid.spider'

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [ScraperService, VipLeiloesSpider, LanceCertoSpider, LeiloSpider, LeilaoJudicialSpider, SuperbidSpider],
  controllers: [ScraperController],
  exports: [ScraperService],
})
export class ScraperModule {}