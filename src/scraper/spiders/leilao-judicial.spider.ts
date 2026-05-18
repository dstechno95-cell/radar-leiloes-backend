import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL = 'https://www.leiloesjudiciais.com.br'

// Categorias de veículos com número máximo de páginas conhecido
const CATEGORIES = [
  { path: 'veiculos/carros',    maxPages: 12 },
  { path: 'veiculos/motos',     maxPages: 7  },
  { path: 'veiculos/caminhoes', maxPages: 4  },
  { path: 'veiculos/onibus',    maxPages: 2  },
]

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Cache-Control':   'no-cache',
}

@Injectable()
export class LeilaoJudicialSpider {
  private readonly logger = new Logger(LeilaoJudicialSpider.name)

  async scrape(): Promise<Prisma.AuctionCreateInput[]> {
    this.logger.log('🕷 Leilão Judicial — iniciando scraping direto das listagens...')
    const results: Prisma.AuctionCreateInput[] = []
    const seen = new Set<string>()

    for (const { path, maxPages } of CATEGORIES) {
      let found = 0
      for (let page = 1; page <= maxPages; page++) {
        const listUrl = page === 1
          ? `${BASE_URL}/${path}`
          : `${BASE_URL}/${path}?pagina=${page}`
        try {
          const { data } = await axios.get(listUrl, { headers: HEADERS, timeout: 15000 })
          const $ = cheerio.load(data)

          const cards = $('a[href*="/lote/"]').toArray()
          if (cards.length === 0) {
            this.logger.log(`${path} p${page}: sem cards — encerrando`)
            break
          }

          let added = 0
          for (const card of cards) {
            const $card = $(card)
            const href  = $card.attr('href') ?? ''
            // sourceId = "DEPOSIT_ID-LOT_NUMBER"
            const parts   = href.replace('/lote/', '').split('/')
            const sourceId = parts.join('-')
            if (!sourceId || seen.has(sourceId)) continue
            seen.add(sourceId)

            const fullText = $card.text().replace(/\s+/g, ' ').trim()

            // Título: texto entre "Lance<N>" e "Avaliação/Lance mínimo/R$"
            const lanceIdx = fullText.search(/Lance\s*\d+/i)
            const priceIdx = fullText.search(/Avaliação|Lance m[íi]nimo|Lance Atual/i)
            let titleRaw = ''
            if (lanceIdx >= 0 && priceIdx > lanceIdx) {
              titleRaw = fullText.slice(lanceIdx, priceIdx).replace(/^Lance\s*\d+\s*/i, '').trim()
            } else if (lanceIdx >= 0) {
              titleRaw = fullText.slice(lanceIdx).replace(/^Lance\s*\d+\s*/i, '').trim().slice(0, 200)
            } else {
              titleRaw = fullText.slice(0, 150)
            }
            // Remove localização duplicada no final: "...CIDADE/SPCidade/SP" → "...CIDADE/SP"
            const title = titleRaw.replace(/\/([A-Z]{2})([A-Z][a-zà-ÿ][\s\S]*)$/u, '/$1').trim().slice(0, 200)
            if (!title || title.length < 4) continue

            // Imagem S3
            const imgSrc = $card.find('img').first().attr('src') ?? ''
            const images = imgSrc && imgSrc.includes('s3') && !imgSrc.includes('nao-disponivel')
              ? [imgSrc] : []

            // Localização: padrão "Cidade/UF" ou "Cidade, UF"
            const locMatch = fullText.match(/([A-Za-zÀ-ú\s]+)[\/,]\s*([A-Z]{2})\b/)
            const city  = locMatch?.[1]?.trim() ?? 'Não informado'
            const state = locMatch?.[2] ?? 'SP'

            // Preço: "Lance mínimo R$ X" ou "Lance Atual R$ X"
            const priceMatch = fullText.match(/Lance m[íi]nimo\s*R\$\s*([\d.,]+)/i)
                            ?? fullText.match(/Lance Atual\s*R\$\s*([\d.,]+)/i)
                            ?? fullText.match(/R\$\s*([\d.,]+)/)
            const price = priceMatch
              ? parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'))
              : 0

            // Avaliação
            const appraisalMatch = fullText.match(/Avalia[çc][aã]o\s*R\$\s*([\d.,]+)/i)
            const appraisedValue = appraisalMatch
              ? parseFloat(appraisalMatch[1].replace(/\./g, '').replace(',', '.'))
              : undefined

            results.push({
              sourceId,
              sourceName:     'leilao_judicial',
              sourceUrl:      `${BASE_URL}${href}`,
              title:          title.slice(0, 200),
              description:    null,
              category:       'VEICULO' as AuctionCategory,
              auctionType:    'JUDICIAL' as AuctionType,
              status:         'ACTIVE' as AuctionStatus,
              price:          price || 5000,
              appraisedValue: appraisedValue || undefined,
              city,
              state:          state.slice(0, 2),
              attrs: {
                origem:  'leilao_judicial',
                imagens: images,
              },
              scrapedAt:     new Date(),
              lastCheckedAt: new Date(),
            })
            added++
          }

          found += added
          this.logger.log(`${path} p${page}: +${added} itens (total categoria: ${found})`)
          if (added === 0 && page > 1) break
          await this.delay(500)
        } catch (e) {
          this.logger.warn(`Erro ${listUrl}: ${String(e)}`)
          break
        }
      }
    }

    this.logger.log(`✅ Leilão Judicial: ${results.length} lotes extraídos`)
    return results
  }

  private delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
