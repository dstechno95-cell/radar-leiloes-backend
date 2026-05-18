import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL  = 'https://exchange.superbid.net'
const CAT_URL   = `${BASE_URL}/categorias/carros-motos`
const MAX_PAGES = 8   // 8 × 30 = 240 itens por ciclo
const PAGE_SIZE = 30

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Cache-Control':   'no-cache',
}

@Injectable()
export class SuperbidSpider {
  private readonly logger = new Logger(SuperbidSpider.name)

  async scrape(): Promise<Prisma.AuctionCreateInput[]> {
    this.logger.log('🕷 Superbid — iniciando scraping...')
    const results: Prisma.AuctionCreateInput[] = []
    const seen    = new Set<string>()

    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const pageUrl = `${CAT_URL}?pageNumber=${page}&pageSize=${PAGE_SIZE}`
        const { data } = await axios.get(pageUrl, { headers: HEADERS, timeout: 20000 })
        const $ = cheerio.load(data)

        const cards = $('a[href*="/oferta/"]').toArray()
        this.logger.log(`Página ${page}: ${cards.length} cards`)
        if (cards.length === 0) break

        let added = 0
        for (const card of cards) {
          const $card  = $(card)
          const href   = $card.attr('href') ?? ''
          // lot ID = último segmento numérico do slug
          const lotId  = href.split('-').pop()?.split('?')[0] ?? ''
          if (!lotId || !/^\d+$/.test(lotId) || seen.has(lotId)) continue
          seen.add(lotId)

          const fullText = $card.text().replace(/\s+/g, ' ').trim()

          // Título: texto antes do primeiro "|"
          const title = fullText.split('|')[0].trim()
          if (!title || title.length < 5) continue

          // Preço: "Lance atual: R$ 12.345,00" ou "R$ 12.345,00"
          const priceMatch = fullText.match(/R\$\s*([\d.,]+)/)
          const price = priceMatch
            ? parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'))
            : 0

          // Localização: "Cidade - UF"
          const locMatch = fullText.match(/([A-Za-zÀ-ú][A-Za-zÀ-ú\s]+?)\s*-\s*([A-Z]{2})(?:\s|$|\|)/)
          const city  = locMatch?.[1]?.trim() ?? 'Não informado'
          const state = locMatch?.[2] ?? 'SP'

          const imgSrc   = $card.find('img').first().attr('src') ?? ''
          const sourceUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`

          results.push({
            sourceId:      lotId,
            sourceName:    'superbid',
            sourceUrl,
            title:         title.slice(0, 200),
            description:   null,
            category:      'VEICULO' as AuctionCategory,
            auctionType:   'EXTRAJUDICIAL' as AuctionType,
            status:        'ACTIVE' as AuctionStatus,
            price:         price || 5000,
            city,
            state:         state.slice(0, 2),
            attrs:         { origem: 'superbid', imagens: imgSrc ? [imgSrc] : [] },
            scrapedAt:     new Date(),
            lastCheckedAt: new Date(),
          })
          added++
        }

        this.logger.log(`Página ${page}: +${added} novos itens (total ${results.length})`)
        if (added === 0) break
        await this.delay(600)
      } catch (e) {
        this.logger.warn(`Erro página ${page}: ${String(e)}`)
        break
      }
    }

    this.logger.log(`✅ Superbid: ${results.length} lotes extraídos`)
    return results
  }

  private delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
