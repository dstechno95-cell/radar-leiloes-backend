import { Controller, Post, Get } from '@nestjs/common'
import { ScraperService } from './scraper.service'

// Rota interna — proteger com API key em produção
@Controller('scraper')
export class ScraperController {
  constructor(private scraper: ScraperService) {}

  @Post('run')
  runAll() {
    return this.scraper.runAll()
  }

  @Post('run/vip')
  runVip() {
    return this.scraper.runSpider('vip_leiloes', async () => {
      const { VipLeiloesSpider } = await import('./spiders/vip-leiloes.spider')
      return []
    })
  }
}