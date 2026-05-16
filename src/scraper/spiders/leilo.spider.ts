import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL = 'https://www.leilo.com.br'
const LIST_URLS = [
  `${BASE_URL}/veiculos`,
  `${BASE_URL}/imoveis`,
  `${BASE_URL}/outros`,
]

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Cache-Control':   'no-cache',
}

@Injectable()
export class LeiloSpider {
  private readonly logger = new Logger(LeiloSpider.name)

  async scrape(): Promise<Prisma.AuctionCreateInput[]> {
    this.logger.log('🕷 Leilo — iniciando scraping...')
    const results: Prisma.AuctionCreateInput[] = []

    for (const listUrl of LIST_URLS) {
      try {
        const items = await this.scrapeListPage(listUrl)
        results.push(...items)
        await this.delay(1500)
      } catch (e) {
        this.logger.warn(`Erro ao scraping ${listUrl}: ${String(e)}`)
      }
    }

    this.logger.log(`✅ Leilo: ${results.length} lotes extraídos`)
    return results
  }

  private async scrapeListPage(listUrl: string): Promise<Prisma.AuctionCreateInput[]> {
    const { data } = await axios.get(listUrl, { headers: HEADERS, timeout: 15000 })
    const $ = cheerio.load(data)
    const results: Prisma.AuctionCreateInput[] = []

    const cards = $(
      '[class*="lot"], [class*="lote"], [class*="item"], [class*="card"], article'
    ).toArray()

    for (const card of cards.slice(0, 40)) {
      try {
        const $card     = $(card)
        const title     = $card.find('h1,h2,h3,h4,[class*="title"],[class*="titulo"],[class*="nome"]').first().text().trim()
        const priceText = $card.find('[class*="lance"],[class*="valor"],[class*="price"],[class*="preco"]').first().text().trim()
        const location  = $card.find('[class*="local"],[class*="cidade"],[class*="estado"],[class*="endereco"]').first().text().trim()
        const href      = $card.find('a').first().attr('href') ?? ''
        const imgSrc    = $card.find('img').first().attr('src') ?? ''

        if (!title || title.length < 4) continue

        const sourceUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`
        const sourceId  = href.split('/').filter(Boolean).pop() ?? Math.random().toString(36).slice(2)
        const price     = this.parsePrice(priceText)
        const { city, state } = this.parseLocation(location)
        const category  = this.detectCategory(listUrl, title)

        results.push({
          sourceId,
          sourceName:  'leilo',
          sourceUrl,
          title:       title.slice(0, 200),
          category,
          auctionType: 'EXTRAJUDICIAL' as AuctionType,
          status:      'ACTIVE' as AuctionStatus,
          price:       price || 5000,
          city,
          state,
          attrs: {
            origem:  'leilo',
            imagens: imgSrc ? [imgSrc] : [],
          },
          scrapedAt:     new Date(),
          lastCheckedAt: new Date(),
        })
      } catch {}
    }

    this.logger.log(`${listUrl}: ${results.length} itens`)
    return results
  }

  private parsePrice(text: string): number {
    if (!text) return 0
    const clean = text.replace(/[^0-9,]/g, '').replace(',', '.')
    return parseFloat(clean) || 0
  }

  private parseLocation(text: string): { city: string; state: string } {
    if (!text) return { city: 'Não informado', state: 'SP' }
    const parts = text.split(/[-/,\n]/).map(s => s.trim()).filter(Boolean)
    const city  = parts[0] || 'Não informado'
    const rawSt = parts[parts.length - 1]?.toUpperCase() || 'SP'
    const state = rawSt.length === 2 && /^[A-Z]{2}$/.test(rawSt) ? rawSt : 'SP'
    return { city, state }
  }

  private detectCategory(url: string, title: string): AuctionCategory {
    const combined = `${url} ${title}`.toLowerCase()
    if (combined.includes('imovel') || combined.includes('imóvel') ||
        combined.includes('imoveis') || combined.includes('casa') ||
        combined.includes('apartamento') || combined.includes('terreno')) {
      return 'IMOVEL'
    }
    return 'VEICULO'
  }

  private delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
