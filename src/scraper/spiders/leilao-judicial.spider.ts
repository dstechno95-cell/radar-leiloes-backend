import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL = 'https://www.leiloesjudiciais.com.br'
const LIST_URLS = [
  `${BASE_URL}/veiculos`,
  `${BASE_URL}/imoveis`,
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
    this.logger.log('🕷 Leilão Judicial — iniciando scraping...')
    const results: Prisma.AuctionCreateInput[] = []
    const lotUrls = new Set<string>()

    // Fase 1: coleta links de lotes de cada categoria
    for (const listUrl of LIST_URLS) {
      try {
        const { data } = await axios.get(listUrl, { headers: HEADERS, timeout: 15000 })
        const $ = cheerio.load(data)

        $('a[href*="/lote/"]').each((_, el) => {
          const href = $(el).attr('href') ?? ''
          if (!href) return
          const url = href.startsWith('http') ? href : `${BASE_URL}${href}`
          lotUrls.add(url)
        })

        this.logger.log(`${listUrl}: ${lotUrls.size} links encontrados`)
        await this.delay(1200)
      } catch (e) {
        this.logger.warn(`Erro ao listar ${listUrl}: ${String(e)}`)
      }
    }

    if (lotUrls.size === 0) {
      this.logger.warn('Nenhum link de lote encontrado — site pode ter bloqueado a requisição')
      return []
    }

    // Fase 2: scraping de cada lote (limite de 40)
    const toScrape = [...lotUrls].slice(0, 40)
    for (const url of toScrape) {
      try {
        const item = await this.scrapeLote(url)
        if (item) results.push(item)
        await this.delay(600)
      } catch (e) {
        this.logger.warn(`Erro no lote ${url}: ${String(e)}`)
      }
    }

    this.logger.log(`✅ Leilão Judicial: ${results.length} lotes extraídos`)
    return results
  }

  private async scrapeLote(url: string): Promise<Prisma.AuctionCreateInput | null> {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 })
    const $ = cheerio.load(data)

    // Título: primeiro h1 ou h2 da página
    const title = $('h1, h2').first().text().trim()
    if (!title || title.length < 4) return null

    // Preços: textos próximos a "Lance mínimo", "Avaliação", "Lance Atual"
    const priceText = this.findTextAfterLabel($, ['Lance mínimo', 'Lance Atual', 'Avaliação', 'Valor'])
    const appraisalText = this.findTextAfterLabel($, ['Avaliação', 'Valor de avaliação'])

    // Localização
    const location = this.findTextAfterLabel($, ['Comarca', 'Cidade', 'Estado', 'Local'])
                  || $('[class*="local"], [class*="cidade"], [class*="comarca"]').first().text().trim()

    // Processo judicial
    const processo = this.findTextAfterLabel($, ['Processo', 'Nº do Processo'])

    // Imagens
    const images = $('img[src*="lote"], img[src*="foto"], img[src*="imagem"]')
      .map((_, el) => $(el).attr('src') ?? '').get().filter(Boolean).slice(0, 5)

    // Descrição
    const desc = $('[class*="descricao"], [class*="observa"], p').first().text().trim()

    const sourceId = url.split('/').filter(Boolean).slice(-2).join('-')
    const price    = this.parsePrice(priceText)
    const appraisedValue = this.parsePrice(appraisalText)
    const { city, state } = this.parseLocation(location)
    const category = this.detectCategory(url, title)

    return {
      sourceId,
      sourceName:  'leilao_judicial',
      sourceUrl:   url,
      title:       title.slice(0, 200),
      description: desc || null,
      category,
      auctionType: 'JUDICIAL' as AuctionType,
      status:      'ACTIVE' as AuctionStatus,
      price:       price || 5000,
      appraisedValue: appraisedValue || undefined,
      city,
      state,
      attrs: {
        origem:    'leilao_judicial',
        imagens:   images,
        ...(processo && { processo }),
      },
      scrapedAt:     new Date(),
      lastCheckedAt: new Date(),
    }
  }

  // Procura texto imediatamente após um label conhecido
  private findTextAfterLabel($: cheerio.CheerioAPI, labels: string[]): string {
    for (const label of labels) {
      const el = $(`*:contains("${label}")`).last()
      if (el.length) {
        const next = el.next().text().trim() || el.parent().next().text().trim()
        if (next && next.length < 100) return next
      }
    }
    return ''
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
