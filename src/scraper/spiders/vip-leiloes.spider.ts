import { Injectable, Logger } from '@nestjs/common'
import axios, { AxiosRequestConfig } from 'axios'
import * as cheerio from 'cheerio'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL    = 'https://www.vipleiloes.com.br'
const SEARCH_URL  = `${BASE_URL}/pesquisa/index`
const API_KEY     = process.env.SCRAPER_API_KEY ?? ''

function scraperUrl(target: string): string {
  // render=true: ScraperAPI roda headless Chrome e executa o JS da página
  // wait_for_selector: aguarda os cards aparecerem antes de retornar
  return `http://api.scraperapi.com?api_key=${API_KEY}&url=${encodeURIComponent(target)}&render=true&wait_for_selector=.card-lel`
}

@Injectable()
export class VipLeiloesSpider {
  private readonly logger = new Logger(VipLeiloesSpider.name)

  async scrape(): Promise<Prisma.AuctionCreateInput[]> {
    if (!API_KEY) {
      this.logger.warn('SCRAPER_API_KEY não configurada — pulando VIP Leilões')
      return []
    }

    this.logger.log('🕷 VIP Leilões — scraping via ScraperAPI (render=true)...')

    const res = await axios.get(scraperUrl(SEARCH_URL), {
      timeout: 120000, // render=true pode demorar até 60s
      maxRedirects: 5,
    })

    const $     = cheerio.load(res.data as string)
    const cards = $('.card-lel, .card-anuncio').toArray()
    this.logger.log(`Cards encontrados: ${cards.length}`)

    if (cards.length === 0) {
      this.logger.warn('Nenhum card. Amostra HTML:')
      this.logger.warn((res.data as string).substring(0, 400))
      return []
    }

    const results: Prisma.AuctionCreateInput[] = []

    for (const card of cards.slice(0, 30)) {
      try {
        const el    = $(card)
        const href  = el.find('a[href*="/evento/anuncio/"]').first().attr('href') ?? ''
        const slug  = href.split('/evento/anuncio/')[1]?.split('?')[0]?.split('/')[0]
        if (!slug) continue

        const title = el.find('.anc-title h1').text().trim() || el.find('h1').first().text().trim()
        if (!title) continue

        const priceRaw = el.find('.valor-atual').first().text().replace(/[^0-9,]/g, '').replace(',', '.')
        const price    = parseFloat(priceRaw) || 1000

        const stateMatch = el.find('.anc-local').text().match(/\b([A-Z]{2})\b/)
        const state      = stateMatch?.[1] ?? 'SP'

        const imgSrc = el.find('.crd-image img, img.card-img-top').first().attr('src') ?? ''

        const titleLower  = title.toLowerCase()
        const auctionType: AuctionType =
          titleLower.includes('judicial') ? 'JUDICIAL' :
          titleLower.includes('banco') || titleLower.includes('financeira') ? 'BANCARIO' :
          'EXTRAJUDICIAL'

        results.push({
          sourceId:     slug,
          sourceName:   'vip_leiloes',
          sourceUrl:    `${BASE_URL}/evento/anuncio/${slug}`,
          title:        title.slice(0, 200),
          description:  null,
          category:     'VEICULO' as AuctionCategory,
          auctionType,
          status:       'ACTIVE' as AuctionStatus,
          price,
          city:         'Não informado',
          state:        state.slice(0, 2),
          attrs:        { origem: 'vip_leiloes', imagens: imgSrc ? [imgSrc] : [] },
          scrapedAt:    new Date(),
          lastCheckedAt: new Date(),
        })
      } catch (e) {
        this.logger.warn(`Erro ao parsear card: ${String(e)}`)
      }
    }

    this.logger.log(`✅ VIP Leilões: ${results.length} lotes extraídos`)
    return results
  }
}
