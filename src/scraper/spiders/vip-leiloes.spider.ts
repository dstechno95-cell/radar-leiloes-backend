import { Injectable, Logger } from '@nestjs/common'
import axios, { AxiosRequestConfig } from 'axios'
import * as cheerio from 'cheerio'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL = 'https://www.vipleiloes.com.br'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Referer': `${BASE_URL}/pesquisa/index`,
}

function scraperConfig(): Partial<AxiosRequestConfig> {
  const key = process.env.SCRAPER_API_KEY
  if (!key) return {}
  return {
    proxy: {
      protocol: 'http',
      host: 'proxy-server.scraperapi.com',
      port: 8001,
      auth: { username: 'scraperapi', password: key },
    },
  }
}

@Injectable()
export class VipLeiloesSpider {
  private readonly logger = new Logger(VipLeiloesSpider.name)

  async scrape(): Promise<Prisma.AuctionCreateInput[]> {
    const usingProxy = !!process.env.SCRAPER_API_KEY
    this.logger.log(`🕷 VIP Leilões — iniciando scraping (proxy: ${usingProxy})...`)

    // 1. Pega o CSRF token da página inicial
    const initRes = await axios.get(`${BASE_URL}/pesquisa/index`, {
      headers: { ...HEADERS },
      maxRedirects: 10,
      timeout: 30000,
      ...scraperConfig(),
    })

    const $init     = cheerio.load(initRes.data as string)
    const csrfToken = $init('input[name="__RequestVerificationToken"]').val() as string
    const cookies   = ((initRes.headers['set-cookie'] as string[] | undefined) ?? [])
      .map((c: string) => c.split(';')[0])
      .join('; ')

    if (!csrfToken) {
      this.logger.warn('CSRF token não encontrado — abortando')
      return []
    }

    this.logger.log(`CSRF token obtido (${csrfToken.length} chars)`)

    // 2. POST para o endpoint AJAX que retorna os cards
    const formData = new URLSearchParams({
      '__RequestVerificationToken': csrfToken,
      'Filtro.OrdenarPor':         'DataInicio',
      'Filtro.SelecaoVeiculos':    'false',
      'Filtro.SelecaoOutros':      'false',
      'Filtro.Financiavel':        'false',
    })

    const listRes = await axios.post(
      `${BASE_URL}/pesquisa?handler=pesquisar`,
      formData.toString(),
      {
        headers: {
          ...HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Cookie': cookies,
        },
        timeout: 30000,
        maxRedirects: 5,
        ...scraperConfig(),
      },
    )

    const $     = cheerio.load(listRes.data as string)
    const cards = $('.card-lel, .card-anuncio').toArray()
    this.logger.log(`Cards encontrados: ${cards.length}`)

    if (cards.length === 0) {
      this.logger.warn('Nenhum card — amostra HTML:')
      this.logger.warn((listRes.data as string).substring(0, 300))
      return []
    }

    const results: Prisma.AuctionCreateInput[] = []

    for (const card of cards.slice(0, 30)) {
      try {
        const el    = $(card)
        const href  = el.find('a[href*="/evento/anuncio/"]').first().attr('href') ?? ''
        const slug  = href.split('/evento/anuncio/')[1]?.split('?')[0]?.split('/')[0]
        if (!slug) continue

        const title = el.find('.anc-title h1').text().trim() || el.find('h1').first().text().trim()
        if (!title) continue

        const priceRaw = el.find('.valor-atual').first().text().replace(/[^0-9,]/g, '').replace(',', '.')
        const price    = parseFloat(priceRaw) || 1000

        const stateMatch = el.find('.anc-local').text().match(/\b([A-Z]{2})\b/)
        const state      = stateMatch?.[1] ?? 'SP'

        const imgSrc = el.find('.crd-image img, img.card-img-top').first().attr('src') ?? ''

        const titleLower  = title.toLowerCase()
        const auctionType: AuctionType =
          titleLower.includes('judicial') ? 'JUDICIAL' :
          titleLower.includes('banco') || titleLower.includes('financeira') ? 'BANCARIO' :
          'EXTRAJUDICIAL'

        results.push({
          sourceId:     slug,
          sourceName:   'vip_leiloes',
          sourceUrl:    `${BASE_URL}/evento/anuncio/${slug}`,
          title:        title.slice(0, 200),
          description:  null,
          category:     'VEICULO' as AuctionCategory,
          auctionType,
          status:       'ACTIVE' as AuctionStatus,
          price,
          city:         'Não informado',
          state:        state.slice(0, 2),
          attrs:        { origem: 'vip_leiloes', imagens: imgSrc ? [imgSrc] : [] },
          scrapedAt:    new Date(),
          lastCheckedAt: new Date(),
        })
      } catch (e) {
        this.logger.warn(`Erro ao parsear card: ${String(e)}`)
      }
    }

    this.logger.log(`✅ VIP Leilões: ${results.length} lotes extraídos`)
    return results
  }
}
