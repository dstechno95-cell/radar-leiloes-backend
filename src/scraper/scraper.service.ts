import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { VipLeiloesSpider } from './spiders/vip-leiloes.spider'
import { LanceCertoSpider } from './spiders/lance-certo.spider'
import { LeiloSpider } from './spiders/leilo.spider'
import { LeilaoJudicialSpider } from './spiders/leilao-judicial.spider'
import { Prisma } from '@prisma/client'

type SpiderFn = () => Promise<Prisma.AuctionCreateInput[]>

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name)
  private running = false

  constructor(
    private prisma: PrismaService,
    private vipSpider: VipLeiloesSpider,
    private lanceCertoSpider: LanceCertoSpider,
    private leiloSpider: LeiloSpider,
    private leilaoJudicialSpider: LeilaoJudicialSpider,
  ) {}

  // 06h00 e 22h00 (horário de Brasília)
  @Cron('0 6,22 * * *', { timeZone: 'America/Sao_Paulo' })
  async scheduledRun() {
    if (this.running) {
      this.logger.warn('Scraping já em execução, pulando ciclo agendado')
      return
    }
    this.logger.log('⏰ Cron disparado — iniciando ciclo agendado')
    await this.runAll()
  }

  async runAll() {
    if (this.running) return { message: 'Já em execução', running: true }
    this.running = true

    const t0 = Date.now()
    this.logger.log('🚀 Iniciando ciclo de scraping...')

    try {
      const results = await Promise.allSettled([
        this.runSpider('lance_certo',    () => this.lanceCertoSpider.scrape()),
        this.runSpider('leilo',          () => this.leiloSpider.scrape()),
        this.runSpider('leilao_judicial',() => this.leilaoJudicialSpider.scrape()),
        // VIP usa Playwright (mais lento) — roda separado para não bloquear os outros
        this.runSpider('vip_leiloes',    () => this.vipSpider.scrape()),
      ])

      const summary = results.map((r, i) => ({
        spider: ['lance_certo', 'leilo', 'leilao_judicial', 'vip_leiloes'][i],
        ok:     r.status === 'fulfilled',
        data:   r.status === 'fulfilled' ? r.value : { error: String(r.reason) },
      }))

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      this.logger.log(`✅ Ciclo completo em ${elapsed}s — ${JSON.stringify(summary.map(s => ({ spider: s.spider, ok: s.ok })))}`)
      return { summary, elapsed }
    } finally {
      this.running = false
    }
  }

  async runSpider(name: string, fn: SpiderFn) {
    const startedAt = new Date()
    const log = await this.prisma.scrapingLog.create({
      data: { sourceName: name, status: 'RUNNING', startedAt },
    })

    let totalFound = 0, totalNew = 0, totalUpdated = 0, totalErrors = 0

    try {
      const auctions = await fn()
      totalFound = auctions.length

      for (const auction of auctions) {
        try {
          const existing = await this.prisma.auction.findUnique({
            where: { sourceId_sourceName: { sourceId: auction.sourceId, sourceName: auction.sourceName } },
            select: { id: true },
          })

          if (existing) {
            await this.prisma.auction.update({
              where: { id: existing.id },
              data: {
                price:         auction.price,
                status:        auction.status,
                lastCheckedAt: new Date(),
                ...(auction.attrs && { attrs: auction.attrs }),
                ...(auction.description && { description: auction.description }),
              },
            })
            totalUpdated++
          } else {
            await this.prisma.auction.create({ data: auction })
            totalNew++
          }
        } catch (e) {
          totalErrors++
          this.logger.warn(`[${name}] Erro ao salvar ${auction.sourceId}: ${String(e)}`)
        }
      }

      const status = totalErrors === 0 ? 'SUCCESS'
        : totalNew + totalUpdated > 0  ? 'PARTIAL'
        : 'FAILED'

      await this.prisma.scrapingLog.update({
        where:  { id: log.id },
        data:   { status, finishedAt: new Date(), totalFound, totalNew, totalUpdated, totalErrors },
      })

      this.logger.log(`[${name}] ✅ ${totalFound} encontrados | ${totalNew} novos | ${totalUpdated} atualizados | ${totalErrors} erros`)
      return { totalFound, totalNew, totalUpdated, totalErrors }

    } catch (e) {
      await this.prisma.scrapingLog.update({
        where: { id: log.id },
        data:  { status: 'FAILED', finishedAt: new Date(), totalErrors: 1, errorDetails: { message: String(e) } },
      })
      this.logger.error(`[${name}] Falhou: ${String(e)}`)
      throw e
    }
  }

  async getLastLogs(limit = 20) {
    return this.prisma.scrapingLog.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    })
  }

  isRunning() {
    return this.running
  }

  async cleanupPropertyRecords() {
    // Deleta registros que claramente não são veículos:
    // 1) category = IMOVEL
    // 2) sourceName = leilao_judicial E título sem palavra-chave de veículo
    const vehicleKw = [
      'honda','toyota','ford','fiat','chevrolet','volkswagen','renault',
      'hyundai','nissan','kia','jeep','bmw','audi','mercedes','volvo',
      'peugeot','citroen','mitsubishi','yamaha','kawasaki','suzuki',
      'veículo','veiculo','moto','carro','caminhao','pickup','suv',
      'gol','celta','corsa','palio','hilux','ranger','duster','creta',
      'hb20','onix','kwid','sandero','civic','corolla','hrv','compass',
      'renegade','saveiro','strada','tucson','sportage','captur','polo',
    ]

    // Busca todos os de leilao_judicial
    const judicialItems = await this.prisma.auction.findMany({
      where:  { sourceName: 'leilao_judicial' },
      select: { id: true, title: true },
    })

    const toDelete = judicialItems
      .filter(({ title }) => {
        const t = title.toLowerCase()
        return !vehicleKw.some(k => t.includes(k))
      })
      .map(({ id }) => id)

    const [byCategory, byTitle] = await Promise.all([
      this.prisma.auction.deleteMany({ where: { category: 'IMOVEL' } }),
      toDelete.length
        ? this.prisma.auction.deleteMany({ where: { id: { in: toDelete } } })
        : Promise.resolve({ count: 0 }),
    ])

    const total = byCategory.count + byTitle.count
    this.logger.log(`🧹 Cleanup: ${total} registros deletados (${byCategory.count} por categoria, ${byTitle.count} por título)`)
    return { deleted: total, byCategory: byCategory.count, byTitle: byTitle.count }
  }
}
