import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL = 'https://www.leilo.com.br'
const LIST_URLS = [
  `${BASE_URL}/veiculos`,
  `${BASE_URL}/imoveis`,
]

// Palavras que indicam um elemento de navegação, NÃO um leilão
const NAV_WORDS = new Set([
  'cidade', 'estado', 'categoria', 'filtro', 'pesquisa', 'busca', 'menu',
  'home', 'contato', 'sobre', 'login', 'cadastro', 'todos', 'outras',
  'veiculo', 'veículo', 'imóvel', 'imovel', 'leilão', 'leilao',
])

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Cache-Control':   'no-cache',
  'Pragma':          'no-cache',
  'Referer':         'https://www.google.com.br/',
}

@Injectable()
export class LeiloSpider {
  private readonly logger = new Logger(LeiloSpider.name)

  async scrape(): Promise<Prisma.AuctionCreateInput[]> {
    this.logger.log('🕷 Leilo — iniciando scraping...')
    const results: Prisma.AuctionCreateInput[] = []
    const lotUrls = new Set<string>()

    // Fase 1: coleta links de lotes individuais
    for (const listUrl of LIST_URLS) {
      try {
        const { data } = await axios.get(listUrl, { headers: HEADERS, timeout: 20000 })
        const $ = cheerio.load(data)

        // Tenta padrões comuns de URL de lote
        $('a[href*="/lote/"], a[href*="/leilao/"], a[href*="/item/"]').each((_, el) => {
          const href = $(el).attr('href') ?? ''
          if (!href || href.includes('#') || href.includes('javascript')) return
          const url = href.startsWith('http') ? href : `${BASE_URL}${href}`
          if (url.includes(BASE_URL.replace('https://www.', ''))) lotUrls.add(url)
        })

        this.logger.log(`${listUrl}: ${lotUrls.size} links de lote encontrados`)
        await this.delay(1500)
      } catch (e) {
        this.logger.warn(`Erro ao listar ${listUrl}: ${String(e)}`)
      }
    }

    // Fase 2: Se encontrou links individuais, scrapa cada um
    if (lotUrls.size > 0) {
      const toScrape = [...lotUrls].slice(0, 40)
      for (const url of toScrape) {
        try {
          const item = await this.scrapeLote(url)
          if (item) results.push(item)
          await this.delay(800)
        } catch (e) {
          this.logger.warn(`Erro no lote ${url}: ${String(e)}`)
        }
      }
    } else {
      // Fallback: scraping de listagem com seletores mais específicos
      for (const listUrl of LIST_URLS) {
        try {
          const items = await this.scrapeListPage(listUrl)
          results.push(...items)
          await this.delay(1500)
        } catch (e) {
          this.logger.warn(`Erro na listagem ${listUrl}: ${String(e)}`)
        }
      }
    }

    this.logger.log(`✅ Leilo: ${results.length} lotes extraídos`)
    return results
  }

  private async scrapeLote(url: string): Promise<Prisma.AuctionCreateInput | null> {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 })
    const $ = cheerio.load(data)

    const title = $('h1, h2').first().text().trim()
    if (!this.isValidTitle(title)) return null

    const priceText = $('[class*="lance"],[class*="valor"],[class*="preco"],[class*="price"]').first().text().trim()
    const location  = $('[class*="local"],[class*="cidade"],[class*="estado"],[class*="endereco"]').first().text().trim()
    const desc      = $('[class*="descricao"],[class*="observa"],p').first().text().trim()
    const images    = $('img').map((_, el) => $(el).attr('src') ?? '').get()
                       .filter(s => s && !s.includes('logo') && !s.includes('icon') && s.startsWith('http'))
                       .slice(0, 5)

    const sourceId = url.split('/').filter(Boolean).slice(-2).join('-')
    const price    = this.parsePrice(priceText)
    const { city, state } = this.parseLocation(location)
    const category = this.detectCategory(url, title)

    return {
      sourceId,
      sourceName:  'leilo',
      sourceUrl:   url,
      title:       title.slice(0, 200),
      description: desc || null,
      category,
      auctionType: 'EXTRAJUDICIAL' as AuctionType,
      status:      'ACTIVE' as AuctionStatus,
      price:       price || 5000,
      city,
      state,
      attrs: { origem: 'leilo', imagens: images },
      scrapedAt:     new Date(),
      lastCheckedAt: new Date(),
    }
  }

  private async scrapeListPage(listUrl: string): Promise<Prisma.AuctionCreateInput[]> {
    const { data } = await axios.get(listUrl, { headers: HEADERS, timeout: 20000 })
    const $ = cheerio.load(data)
    const results: Prisma.AuctionCreateInput[] = []

    // Seletores mais específicos: evita nav, header, footer
    const cards = $('main, #content, .content, [class*="result"], [class*="listing"]')
      .find('[class*="card"], [class*="item"], [class*="lote"], article')
      .toArray()

    // Fallback: qualquer elemento com link e imagem (card pattern)
    const candidates = cards.length > 0 ? cards : $('a:has(img):has(h1,h2,h3,h4)').toArray()

    for (const card of candidates.slice(0, 40)) {
      try {
        const $card = $(card)

        const rawTitle = $card.find('h1,h2,h3,h4,[class*="title"],[class*="titulo"],[class*="nome"],[class*="modelo"]')
          .first().text().trim()

        if (!this.isValidTitle(rawTitle)) continue

        const priceText = $card.find('[class*="lance"],[class*="valor"],[class*="preco"],[class*="price"]')
          .first().text().trim()
        const location  = $card.find('[class*="local"],[class*="cidade"],[class*="estado"]')
          .first().text().trim()
        const href      = ($card.is('a') ? $card.attr('href') : $card.find('a').first().attr('href')) ?? ''
        const imgSrc    = $card.find('img').first().attr('src') ?? ''

        const sourceUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`
        const sourceId  = href.split('/').filter(Boolean).pop() ?? Math.random().toString(36).slice(2)
        const price     = this.parsePrice(priceText)
        const { city, state } = this.parseLocation(location)
        const category  = this.detectCategory(listUrl, rawTitle)

        results.push({
          sourceId,
          sourceName:  'leilo',
          sourceUrl,
          title:       rawTitle.slice(0, 200),
          category,
          auctionType: 'EXTRAJUDICIAL' as AuctionType,
          status:      'ACTIVE' as AuctionStatus,
          price:       price || 5000,
          city,
          state,
          attrs: { origem: 'leilo', imagens: imgSrc ? [imgSrc] : [] },
          scrapedAt:     new Date(),
          lastCheckedAt: new Date(),
        })
      } catch {}
    }

    this.logger.log(`${listUrl}: ${results.length} itens válidos`)
    return results
  }

  // Rejeita títulos que são claramente elementos de navegação
  private isValidTitle(title: string): boolean {
    if (!title || title.length < 8) return false
    if (title.length > 250) return false
    const lower = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    // Rejeita se for exatamente uma palavra de navegação
    if (NAV_WORDS.has(lower.trim())) return false
    // Rejeita se não tiver pelo menos 2 palavras (título real tem espaço)
    if (!lower.includes(' ')) return false
    return true
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
