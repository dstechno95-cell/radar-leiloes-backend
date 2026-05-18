import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL   = 'https://www.vipleiloes.com.br'
const API_KEY    = process.env.SCRAPER_API_KEY ?? ''
const MAX_PAGES  = 4

// Tentativas de padrão de paginação — para quando 1 funcionar, as outras retornam 0 cards
const pageUrl = (n: number) => [
  `${BASE_URL}/pesquisa/index?page=${n}`,
  `${BASE_URL}/pesquisa/index?pagina=${n}`,
  `${BASE_URL}/pesquisa/index?p=${n}`,
]

function scraperUrl(target: string): string {
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

    const results: Prisma.AuctionCreateInput[] = []
    const seen    = new Set<string>()

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = page === 1
        ? `${BASE_URL}/pesquisa/index`
        : pageUrl(page)[0]  // tenta ?page=N primeiro

      try {
        const { data } = await axios.get(scraperUrl(url), {
          timeout: 90000,
          maxRedirects: 5,
        })

        const $     = cheerio.load(data as string)
        const cards = $('.card-lel, .card-anuncio').toArray().filter(el =>
          !$(el).attr('style')?.includes('display:none')
        )
        this.logger.log(`Página ${page} (${url}): ${cards.length} cards`)

        if (cards.length === 0) break

        let added = 0
        for (const card of cards.slice(0, 30)) {
          try {
            const el   = $(card)
            const href = el.find('a[href*="/evento/anuncio/"]').first().attr('href') ?? ''
            const slug = href.split('/evento/anuncio/')[1]?.split('?')[0]?.split('/')[0]
            if (!slug || seen.has(slug)) continue
            seen.add(slug)

            const title = el.find('.anc-title h1').text().trim() || el.find('h1').first().text().trim()
            if (!title) continue

            const priceRaw = el.find('.valor-atual').first().text().replace(/[^0-9,]/g, '').replace(',', '.')
            const price    = parseFloat(priceRaw) || 1000

            const stateMatch = el.find('.anc-local').text().match(/\b([A-Z]{2})\b/)
            const state      = stateMatch?.[1] ?? 'SP'
            const imgSrc     = el.find('.crd-image img, img.card-img-top').first().attr('src') ?? ''

            const titleLower  = title.toLowerCase()
            const auctionType: AuctionType =
              titleLower.includes('judicial')  ? 'JUDICIAL' :
              titleLower.includes('banco') || titleLower.includes('financeira') ? 'BANCARIO' :
              'EXTRAJUDICIAL'

            results.push({
              sourceId:      slug,
              sourceName:    'vip_leiloes',
              sourceUrl:     `${BASE_URL}/evento/anuncio/${slug}`,
              title:         title.slice(0, 200),
              description:   null,
              category:      'VEICULO' as AuctionCategory,
              auctionType,
              status:        'ACTIVE' as AuctionStatus,
              price,
              city:          'Não informado',
              state:         state.slice(0, 2),
              attrs:         { origem: 'vip_leiloes', imagens: imgSrc ? [imgSrc] : [] },
              scrapedAt:     new Date(),
              lastCheckedAt: new Date(),
            })
            added++
          } catch (e) {
            this.logger.warn(`Erro ao parsear card: ${String(e)}`)
          }
        }

        // Se página 2+ não trouxe nada novo, o site não tem paginação nesse formato
        if (page > 1 && added === 0) break
      } catch (e) {
        this.logger.warn(`Erro página ${page}: ${String(e)}`)
        if (page === 1) break  // página 1 falhou, não adianta continuar
      }
    }

    this.logger.log(`✅ VIP Leilões: ${results.length} lotes extraídos`)
    return results
  }
}
