import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { VipLeiloesSpider } from './spiders/vip-leiloes.spider'

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name)

  constructor(
    private prisma: PrismaService,
    private vipSpider: VipLeiloesSpider,
  ) {}

  async runAll() {
    this.logger.log('🚀 Iniciando ciclo de scraping...')
    const results = await Promise.allSettled([
      this.runSpider('vip_leiloes', () => this.vipSpider.scrape()),
    ])
    return results
  }

  async runSpider(sourceName: string, fn: () => Promise<any[]>) {
    const log = await this.prisma.scrapingLog.create({
      data: { sourceName, status: 'RUNNING', startedAt: new Date() },
    })

    try {
      const items = await fn()
      let totalNew = 0
      let totalUpdated = 0

      for (const item of items) {
        try {
          const existing = await this.prisma.auction.findUnique({
            where: { sourceId_sourceName: { sourceId: item.sourceId, sourceName } },
          })

          if (existing) {
            await this.prisma.auction.update({
              where: { id: existing.id },
              data: { price: item.price, status: item.status, lastCheckedAt: new Date() },
            })
            totalUpdated++
          } else {
            await this.prisma.auction.create({ data: { ...item, sourceName } })
            totalNew++
          }
        } catch (e) {
          this.logger.error(`Erro ao salvar item ${item.sourceId}: ${e}`)
        }
      }

      await this.prisma.scrapingLog.update({
        where: { id: log.id },
        data: {
          status: 'SUCCESS', finishedAt: new Date(),
          totalFound: items.length, totalNew, totalUpdated,
        },
      })

      this.logger.log(`✅ ${sourceName}: ${totalNew} novos, ${totalUpdated} atualizados`)
      return { totalNew, totalUpdated }

    } catch (error) {
      await this.prisma.scrapingLog.update({
        where: { id: log.id },
        data: { status: 'FAILED', finishedAt: new Date(), errorDetails: { error: String(error) } },
      })
      this.logger.error(`❌ ${sourceName} falhou: ${error}`)
      throw error
    }
  }
}