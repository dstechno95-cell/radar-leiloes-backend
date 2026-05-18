import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL = 'https://www.lancecertoleiloes.com.br'
const API_KEY  = process.env.SCRAPER_API_KEY ?? ''

const LIST_URLS = [
  `${BASE_URL}/filtro/carros`,
  `${BASE_URL}/filtro/motos`,
  `${BASE_URL}/filtro/pesados`,
]

function scraperUrl(target: string): string {
  return `http://api.scraperapi.com?api_key=${API_KEY}&url=${encodeURIComponent(target)}&render=true&wait_for_selector=.listagem-leilao`
}

@Injectable()
export class LanceCertoSpider {
  private readonly logger = new Logger(LanceCertoSpider.name)

  async scrape(): Promise<Prisma.AuctionCreateInput[]> {
    if (!API_KEY) {
      this.logger.warn('SCRAPER_API_KEY não configurada — pulando Lance Certo')
      return []
    }

    this.logger.log('🕷 Lance Certo — scraping via ScraperAPI (render=true)...')

    const seen    = new Set<string>()
    const results: Prisma.AuctionCreateInput[] = []

    // Busca as 3 URLs em paralelo
    const pages = await Promise.allSettled(
      LIST_URLS.map(url =>
        axios.get(scraperUrl(url), { timeout: 60000, maxRedirects: 5 })
          .then(r => ({ url, html: r.data as string }))
      )
    )

    for (const page of pages) {
      if (page.status === 'rejected') {
        this.logger.warn(`Erro ao buscar página: ${String(page.reason)}`)
        continue
      }
      const { url: listUrl, html } = page.value
      const $     = cheerio.load(html)
      const cards = $('.listagem-leilao').toArray().filter(el =>
        !$(el).attr('style')?.includes('display:none')
      )
      this.logger.log(`${listUrl}: ${cards.length} cards`)

      for (const card of cards.slice(0, 20)) {
          try {
            const el   = $(card)
            const href = el.find('a[href*="/leilao/"]').first().attr('href') ?? ''
            if (!href) continue

            // Normaliza URL relativa
            const absUrl  = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\.\.\//, '')}`
            const sourceId = absUrl.split('/lote/')[1]?.split(/[/?]/)[0] ?? absUrl.split('/').pop() ?? ''
            if (!sourceId || seen.has(sourceId)) continue
            seen.add(sourceId)

            const modelLine = el.find('.lote-descricao b').filter((_, b) => $(b).text().trim() === 'Modelo').parent().text()
            const title     = modelLine.replace('Modelo:', '').split('\n')[0].trim() ||
                              el.find('.lote-descricao').text().trim().split('\n')[0].trim()
            if (!title || title.length < 3) continue

            const localText  = el.find('.lote-descricao').text()
            const localMatch = localText.match(/Local[^:]*:\s*([^<\n]+)/i)
            const location   = localMatch?.[1]?.trim() ?? ''
            const stateMatch = location.match(/\b([A-Z]{2})\b/)
            const state      = stateMatch?.[1] ?? 'PE'
            const city       = location.split(/[-,]/)[0]?.trim() || 'Não informado'

            const priceText = el.find('.lote-resultado, [class*="valor"]').first().text()
            const priceRaw  = priceText.replace(/[^0-9,]/g, '').replace(',', '.')
            const price     = parseFloat(priceRaw) || 1000

            const imgSrc    = el.find('img.lote-img').first().attr('src') ?? ''

            const titleLower  = title.toLowerCase()
            const category: AuctionCategory = titleLower.includes('imovel') || titleLower.includes('casa') || titleLower.includes('terreno')
              ? 'IMOVEL' : 'VEICULO'

            results.push({
              sourceId,
              sourceName:   'lance_certo',
              sourceUrl:    absUrl,
              title:        title.slice(0, 200),
              description:  null,
              category,
              auctionType:  'EXTRAJUDICIAL' as AuctionType,
              status:       'ACTIVE' as AuctionStatus,
              price,
              city,
              state:        state.slice(0, 2),
              attrs:        { origem: 'lance_certo', imagens: imgSrc ? [imgSrc] : [] },
              scrapedAt:    new Date(),
              lastCheckedAt: new Date(),
            })
          } catch (e) {
            this.logger.warn(`Erro ao parsear card: ${String(e)}`)
          }
        }
    }

    this.logger.log(`✅ Lance Certo: ${results.length} lotes extraídos`)
    return results
  }
}
