import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL    = 'https://www.leiloesjudiciais.com.br'
const CATEGORIES  = ['veiculos']
const MAX_PAGES   = 5   // 5 páginas × ~25 lotes = ~125 lotes por categoria
const MAX_SCRAPE  = 150 // limite total de lotes para scraping por ciclo

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
    // Mapeia URL do lote → categoria correta baseada na página de origem
    const lotMap = new Map<string, AuctionCategory>()

    // Fase 1: coleta links de lotes paginando cada categoria
    for (const cat of CATEGORIES) {
      const defaultCategory: AuctionCategory = cat === 'imoveis' ? 'IMOVEL' : 'VEICULO'

      for (let page = 0; page < MAX_PAGES; page++) {
        const listUrl = page === 0
          ? `${BASE_URL}/${cat}`
          : `${BASE_URL}/${cat}?pagina=${page}`
        try {
          const { data } = await axios.get(listUrl, { headers: HEADERS, timeout: 15000 })
          const $ = cheerio.load(data)

          const before = lotMap.size
          $('a[href*="/lote/"]').each((_, el) => {
            const href = $(el).attr('href') ?? ''
            if (!href) return
            const url = href.startsWith('http') ? href : `${BASE_URL}${href}`
            if (!lotMap.has(url)) lotMap.set(url, defaultCategory)
          })

          const added = lotMap.size - before
          this.logger.log(`${listUrl}: +${added} links (total ${lotMap.size})`)

          if (added === 0 && page > 0) break
          await this.delay(800)
        } catch (e) {
          this.logger.warn(`Erro ao listar ${listUrl}: ${String(e)}`)
          break
        }
      }
    }

    if (lotMap.size === 0) {
      this.logger.warn('Nenhum link de lote encontrado — site pode ter bloqueado a requisição')
      return []
    }

    // Fase 2: scraping de cada lote com categoria correta da origem
    const toScrape = [...lotMap.entries()].slice(0, MAX_SCRAPE)
    for (const [url, categoryFromList] of toScrape) {
      try {
        const item = await this.scrapeLote(url, categoryFromList)
        if (item) results.push(item)
        await this.delay(600)
      } catch (e) {
        this.logger.warn(`Erro no lote ${url}: ${String(e)}`)
      }
    }

    this.logger.log(`✅ Leilão Judicial: ${results.length} lotes extraídos`)
    return results
  }

  private async scrapeLote(url: string, categoryFromList: AuctionCategory = 'VEICULO'): Promise<Prisma.AuctionCreateInput | null> {
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
    // Usa a categoria da página de origem como base; refina pelo título se necessário
    const category = this.refineCategory(categoryFromList, title)
    // Rejeita lotes sem palavra-chave de veículo — provavelmente imóveis mal categorizados
    if (category !== 'VEICULO') return null

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

  private readonly VEHICLE_KW = [
    'honda','toyota','ford','fiat','chevrolet','vw','volkswagen','renault',
    'hyundai','nissan','kia','jeep','bmw','audi','mercedes','volvo','peugeot',
    'citroen','mitsubishi','yamaha','kawasaki','suzuki','ducati','triumph',
    'veículo','veiculo','moto','motocicleta','carro','caminhão','caminhao',
    'pickup','suv','automóvel','automovel','camionete','ônibus','onibus','van',
    'gol','celta','corsa','palio','uno','siena','hilux','ranger','s10',
    'frontier','amarok','duster','creta','hb20','onix','argo','kwid','sandero',
    'ecosport','fiesta','civic','corolla','fit','city','hrv','crv','compass',
    'renegade','toro','saveiro','strada','etios','yaris','kicks','tucson',
    'sportage','captur','pulse','fastback','t-cross','tiguan','polo','virtus',
    'fusca','beetle','golf','passat','jetta','fox','up!','nivus','taos',
  ]

  // Aceita apenas se o título contiver palavra-chave de veículo conhecida
  private refineCategory(base: AuctionCategory, title: string): AuctionCategory {
    if (base === 'IMOVEL') return 'IMOVEL'
    const t = title.toLowerCase()
    if (this.VEHICLE_KW.some(k => t.includes(k))) return 'VEICULO'
    return 'IMOVEL'  // título sem palavra-chave de veículo → descarta
  }

  private delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
