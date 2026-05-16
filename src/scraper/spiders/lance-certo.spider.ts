import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL  = 'https://www.lancecertoleiloes.com.br'
const LIST_URLS = [
  `${BASE_URL}/filtro/carros`,
  `${BASE_URL}/filtro/motos`,
  `${BASE_URL}/filtro/pesados`,
]

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Cache-Control':   'no-cache',
}

@Injectable()
export class LanceCertoSpider {
  private readonly logger = new Logger(LanceCertoSpider.name)

  async scrape(): Promise<Prisma.AuctionCreateInput[]> {
    this.logger.log('🕷 Lance Certo — iniciando scraping...')
    const results: Prisma.AuctionCreateInput[] = []
    const lotUrls = new Set<string>()

    // Coleta links de lotes de todas as categorias
    for (const listUrl of LIST_URLS) {
      try {
        const { data } = await axios.get(listUrl, { headers: HEADERS, timeout: 15000 })
        const $        = cheerio.load(data)

        // Pega links de lotes/leilões
        $('a[href*="/lote/"], a[href*="/leilao/"], a[href*="/veiculo/"]').each((_, el) => {
          const href = $(el).attr('href')
          if (href) {
            const url = href.startsWith('http') ? href : `${BASE_URL}${href}`
            if (!url.includes('edital') && !url.includes('javascript')) {
              lotUrls.add(url)
            }
          }
        })

        this.logger.log(`${listUrl}: ${lotUrls.size} links encontrados`)
        await this.delay(1000)
      } catch (e) {
        this.logger.warn(`Erro ao listar ${listUrl}: ${e}`)
      }
    }

    // Se não achou links de lotes individuais, tenta extrair da lista diretamente
    if (lotUrls.size === 0) {
      this.logger.log('Tentando extração direta da listagem...')
      for (const listUrl of LIST_URLS) {
        try {
          const items = await this.scrapeListPage(listUrl)
          results.push(...items)
        } catch (e) {
          this.logger.warn(`Erro na listagem ${listUrl}: ${e}`)
        }
      }
      return results
    }

    // Scraping de cada lote individual (limite de 30)
    const toScrape = [...lotUrls].slice(0, 30)
    for (const url of toScrape) {
      try {
        const item = await this.scrapeLote(url)
        if (item) results.push(item)
        await this.delay(500)
      } catch (e) {
        this.logger.warn(`Erro no lote ${url}: ${e}`)
      }
    }

    this.logger.log(`✅ Lance Certo: ${results.length} lotes extraídos`)
    return results
  }

  // Extrai lotes direto da página de listagem
  private async scrapeListPage(url: string): Promise<Prisma.AuctionCreateInput[]> {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 })
    const $        = cheerio.load(data)
    const results: Prisma.AuctionCreateInput[] = []

    // Tenta diferentes seletores de card
    const cards = $('[class*="lote"], [class*="veiculo"], [class*="card"], .item').toArray()

    for (const card of cards.slice(0, 30)) {
      try {
        const $card     = $(card)
        const title     = $card.find('h1,h2,h3,h4,[class*="titulo"],[class*="title"]').first().text().trim()
        const priceText = $card.find('[class*="lance"],[class*="valor"],[class*="price"]').first().text().trim()
        const location  = $card.find('[class*="local"],[class*="cidade"],[class*="estado"]').first().text().trim()
        const href      = $card.find('a').first().attr('href') ?? ''
        const sourceUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`
        const sourceId  = href.split('/').filter(Boolean).pop() ?? Math.random().toString(36).slice(2)
        const imgSrc    = $card.find('img').first().attr('src') ?? ''

        if (!title || title.length < 5) continue

        const price    = this.parsePrice(priceText)
        const { city, state } = this.parseLocation(location || url)
        const category = this.detectCategory(url, title)

        results.push({
          sourceId,
          sourceName: 'lance_certo',
          sourceUrl,
          title:      title.slice(0, 200),
          category,
          auctionType: 'EXTRAJUDICIAL' as AuctionType,
          status:     'ACTIVE' as AuctionStatus,
          price:      price || 5000,
          city,
          state,
          attrs: {
            origem:   'lance_certo',
            imagens:  imgSrc ? [imgSrc] : [],
          },
          scrapedAt:     new Date(),
          lastCheckedAt: new Date(),
        })
      } catch {}
    }

    return results
  }

  // Scraping de página individual de lote
  private async scrapeLote(url: string): Promise<Prisma.AuctionCreateInput | null> {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 })
    const $        = cheerio.load(data)

    const title = $('h1, h2, [class*="titulo"]').first().text().trim()
    if (!title || title.length < 5) return null

    const priceText = $('[class*="lance"], [class*="valor"], [class*="preco"]').first().text().trim()
    const location  = $('[class*="local"], [class*="cidade"], [class*="estado"]').first().text().trim()
    const desc      = $('[class*="descricao"], [class*="observ"]').first().text().trim()
    const images    = $('img[src*="veiculo"], img[src*="foto"], img[src*="lote"]')
                        .map((_, el) => $(el).attr('src') ?? '').get().filter(Boolean).slice(0, 5)

    const sourceId = url.split('/').filter(Boolean).pop() ?? Math.random().toString(36).slice(2)
    const price    = this.parsePrice(priceText)
    const { city, state } = this.parseLocation(location)
    const category = this.detectCategory(url, title)

    return {
      sourceId,
      sourceName:  'lance_certo',
      sourceUrl:   url,
      title:       title.slice(0, 200),
      description: desc || null,
      category,
      auctionType: 'EXTRAJUDICIAL' as AuctionType,
      status:      'ACTIVE' as AuctionStatus,
      price:       price || 5000,
      city,
      state,
      attrs: {
        origem:  'lance_certo',
        imagens: images,
      },
      scrapedAt:     new Date(),
      lastCheckedAt: new Date(),
    }
  }

  // ── HELPERS ──────────────────────────────────────────────────────────────

  private parsePrice(text: string): number {
    if (!text) return 0
    const clean = text.replace(/[^0-9,]/g, '').replace(',', '.')
    return parseFloat(clean) || 0
  }

  private parseLocation(text: string): { city: string; state: string } {
    if (!text) return { city: 'Não informado', state: 'PE' }
    const parts = text.split(/[-/,\n]/).map(s => s.trim()).filter(Boolean)
    const city  = parts[0] || 'Não informado'
    const rawSt = parts[parts.length - 1]?.toUpperCase() || 'PE'
    const state = rawSt.length === 2 && /^[A-Z]{2}$/.test(rawSt) ? rawSt : 'PE'
    return { city, state }
  }

  private detectCategory(url: string, title: string): AuctionCategory {
    const combined = `${url} ${title}`.toLowerCase()
    if (combined.includes('imovel') || combined.includes('imóvel') ||
        combined.includes('casa') || combined.includes('apartamento')) {
      return 'IMOVEL'
    }
    return 'VEICULO'
  }

  private delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}