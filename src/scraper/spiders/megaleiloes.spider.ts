import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL  = 'https://www.megaleiloes.com.br'
const CAT_URL   = `${BASE_URL}/veiculos`
const MAX_PAGES = 5   // 5 × 48 = 240 itens

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Cache-Control':   'no-cache',
}

@Injectable()
export class MegaleiloesSpider {
  private readonly logger = new Logger(MegaleiloesSpider.name)

  async scrape(): Promise<Prisma.AuctionCreateInput[]> {
    this.logger.log('🕷 Mega Leilões — iniciando scraping...')
    const results: Prisma.AuctionCreateInput[] = []
    const seen    = new Set<string>()

    for (let page = 1; page <= MAX_PAGES; page++) {
      const pageUrl = page === 1 ? CAT_URL : `${CAT_URL}?pagina=${page}`
      try {
        const { data } = await axios.get(pageUrl, { headers: HEADERS, timeout: 20000 })
        const $ = cheerio.load(data)

        // Cards: <a> com href contendo "/veiculos/" e "-j" (lot ID pattern)
        // Tenta seletores progressivamente mais amplos
        let cards = $('a[href*="/veiculos/"][href*="-j"]').toArray()
        if (cards.length === 0) cards = $('a[href*="/veiculos/carros/"], a[href*="/veiculos/motos/"], a[href*="/veiculos/caminhoes/"]').toArray()
        this.logger.log(`Página ${page}: ${cards.length} cards`)

        if (cards.length === 0) {
          this.logger.warn(`Nenhum card — amostra HTML: ${(data as string).slice(0, 600)}`)
          break
        }

        let added = 0
        for (const card of cards) {
          try {
            const $card = $(card)
            const href  = $card.attr('href') ?? ''

            // Lot ID: padrão jXXXXXX no final da URL (antes de ?)
            const lotMatch = href.match(/-(j\d+)(?:\?|$)/i)
            const lotId    = lotMatch?.[1]?.toUpperCase()
            if (!lotId || seen.has(lotId)) continue
            seen.add(lotId)

            // Texto de todos os divs filhos
            const divTexts = $card.find('div').map((_, el) => $(el).text().trim()).get().filter(Boolean)

            // Título: div com padrão de veículo (marca/modelo + ano, ex: "Carro Hyundai I30 2.0 - 2009/2010")
            const title = divTexts.find(t =>
              /\b(carro|moto|caminhão|caminhao|ônibus|onibus|van|pickup|suv|trator)\b/i.test(t) ||
              /\d{4}\/\d{4}/.test(t) ||
              /\b(honda|toyota|ford|fiat|vw|volkswagen|renault|hyundai|nissan|chevrolet|jeep)\b/i.test(t)
            )
            if (!title || title.length < 5) continue

            // Preço: primeiro div com "R$"
            const priceText = divTexts.find(t => t.startsWith('R$')) ?? ''
            const price = parseFloat(
              priceText.replace('R$', '').replace(/\./g, '').replace(',', '.').trim()
            ) || 5000

            // Localização: "Cidade, UF"
            const locText    = divTexts.find(t => /^[A-Za-zÀ-ú\s]+,\s*[A-Z]{2}$/.test(t.trim())) ?? ''
            const locParts   = locText.split(',')
            const city       = locParts[0]?.trim() || 'Não informado'
            const state      = locParts[1]?.trim().slice(0, 2) || 'SP'

            // Tipo de leilão
            const typeText      = divTexts.find(t => /^(judicial|extrajudicial|bancário|seguradora)/i.test(t)) ?? ''
            const auctionType: AuctionType =
              /judicial/i.test(typeText) ? 'JUDICIAL' :
              /banco|bancário|financ/i.test(typeText) ? 'BANCARIO' :
              'EXTRAJUDICIAL'

            const sourceUrl = href.startsWith('http') ? href.split('?')[0] : `${BASE_URL}${href.split('?')[0]}`

            results.push({
              sourceId:      lotId,
              sourceName:    'megaleiloes',
              sourceUrl,
              title:         title.slice(0, 200),
              description:   null,
              category:      'VEICULO' as AuctionCategory,
              auctionType,
              status:        'ACTIVE' as AuctionStatus,
              price,
              city,
              state,
              attrs:         { origem: 'megaleiloes', imagens: [] },
              scrapedAt:     new Date(),
              lastCheckedAt: new Date(),
            })
            added++
          } catch (e) {
            this.logger.warn(`Erro ao parsear card: ${String(e)}`)
          }
        }

        this.logger.log(`Página ${page}: +${added} itens (total ${results.length})`)
        if (added === 0 && page > 1) break
        await this.delay(700)
      } catch (e) {
        this.logger.warn(`Erro página ${page}: ${String(e)}`)
        break
      }
    }

    this.logger.log(`✅ Mega Leilões: ${results.length} lotes extraídos`)
    return results
  }

  private delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
