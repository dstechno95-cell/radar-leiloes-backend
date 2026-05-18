import { Controller, Post, Get } from '@nestjs/common'
import { ScraperService } from './scraper.service'
import { VipLeiloesSpider } from './spiders/vip-leiloes.spider'
import { LanceCertoSpider } from './spiders/lance-certo.spider'
import { LeiloSpider } from './spiders/leilo.spider'
import { LeilaoJudicialSpider } from './spiders/leilao-judicial.spider'
import { SuperbidSpider } from './spiders/superbid.spider'
import { MegaleiloesSpider } from './spiders/megaleiloes.spider'

// Rota interna — proteger com API key em produção
@Controller('scraper')
export class ScraperController {
  constructor(
    private scraper: ScraperService,
    private vipSpider: VipLeiloesSpider,
    private lanceCertoSpider: LanceCertoSpider,
    private leiloSpider: LeiloSpider,
    private leilaoJudicialSpider: LeilaoJudicialSpider,
    private superbidSpider: SuperbidSpider,
    private megaleiloesSpider: MegaleiloesSpider,
  ) {}

  @Post('run')
  runAll() {
    return this.scraper.runAll()
  }

  @Get('status')
  status() {
    return { running: this.scraper.isRunning() }
  }

  @Get('logs')
  logs() {
    return this.scraper.getLastLogs()
  }

  @Post('run/vip')
  runVip() {
    return this.scraper.runSpider('vip_leiloes', () => this.vipSpider.scrape())
  }

  @Post('run/lance-certo')
  runLanceCerto() {
    return this.scraper.runSpider('lance_certo', () => this.lanceCertoSpider.scrape())
  }

  @Post('run/leilo')
  runLeilo() {
    return this.scraper.runSpider('leilo', () => this.leiloSpider.scrape())
  }

  @Post('run/leilao-judicial')
  runLeilaoJudicial() {
    return this.scraper.runSpider('leilao_judicial', () => this.leilaoJudicialSpider.scrape())
  }

  @Post('run/superbid')
  runSuperbid() {
    return this.scraper.runSpider('superbid', () => this.superbidSpider.scrape())
  }

  @Post('run/megaleiloes')
  runMegaleiloes() {
    return this.scraper.runSpider('megaleiloes', () => this.megaleiloesSpider.scrape())
  }

  @Post('cleanup')
  cleanup() {
    return this.scraper.cleanupPropertyRecords()
  }
}
