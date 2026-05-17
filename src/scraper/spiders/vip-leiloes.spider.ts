import { Injectable, Logger } from '@nestjs/common'
import { chromium } from 'playwright-core'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'

const BASE_URL  = 'https://www.vipleiloes.com.br'
const LIST_URLS = [
  `${BASE_URL}/pesquisa/index?Filtro.TipoBem=1`,   // veículos
  `${BASE_URL}/pesquisa/index?Filtro.TipoBem=2`,   // imóveis
  `${BASE_URL}/pesquisa/index`,                     // todos
]

@Injectable()
export class VipLeiloesSpider {
  private readonly logger = new Logger(VipLeiloesSpider.name)

  async scrape(): Promise<Prisma.AuctionCreateInput[]> {
    this.logger.log('🕷 VIP Leilões — iniciando scraping...')

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1920,1080',
      ],
    })

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      viewport: { width: 1920, height: 1080 },
      extraHTTPHeaders: {
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })

    const seenUrls = new Set<string>()
    const lotLinks: string[] = []

    try {
      const page = await context.newPage()
      await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', r => r.abort())

      for (const listUrl of LIST_URLS) {
        try {
          this.logger.log(`Navegando para: ${listUrl}`)
          await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
          await page.waitForSelector('a[href*="/lote/"]', { timeout: 15000 }).catch(() => {})
          await page.waitForTimeout(3000)

          const pageTitle = await page.title()
          const allLinks  = await page.$$eval('a', els => els.map(el => (el as HTMLAnchorElement).href))
          const loteLinks = allLinks.filter(h => h.includes('/lote/'))

          this.logger.log(`[${listUrl}] título: "${pageTitle}" | total links: ${allLinks.length} | links /lote/: ${loteLinks.length}`)

          // Log sample links for debugging
          if (allLinks.length > 0) {
            this.logger.log(`[${listUrl}] amostra de links: ${allLinks.slice(0, 5).join(' | ')}`)
          }

          for (const link of loteLinks) {
            if (!seenUrls.has(link)) {
              seenUrls.add(link)
              lotLinks.push(link)
            }
          }
        } catch (e) {
          this.logger.warn(`Erro ao navegar ${listUrl}: ${String(e)}`)
        }
      }

      await page.close()
    } catch (e) {
      this.logger.error(`Erro geral: ${String(e)}`)
    }

    this.logger.log(`Total de lotes únicos encontrados: ${lotLinks.length}`)

    const results: Prisma.AuctionCreateInput[] = []

    try {
      const toScrape = lotLinks.slice(0, 20)

      for (const url of toScrape) {
        try {
          const auction = await this.scrapeLote(context, url)
          if (auction) results.push(auction)
          await new Promise(r => setTimeout(r, 800))
        } catch (e) {
          this.logger.warn(`Erro no lote ${url}: ${String(e)}`)
        }
      }
    } finally {
      await browser.close()
    }

    this.logger.log(`✅ VIP Leilões: ${results.length} lotes extraídos`)
    return results
  }

  private async scrapeLote(context: any, url: string): Promise<Prisma.AuctionCreateInput | null> {
    const page = await context.newPage()
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', (r: any) => r.abort())

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await page.waitForTimeout(3000)

      const data = await page.evaluate(() => {
        const getText = (sel: string) =>
          document.querySelector(sel)?.textContent?.trim() ?? ''
        const getAttr = (sel: string, attr: string) =>
          (document.querySelector(sel) as any)?.[attr]?.trim() ?? ''

        return {
          title:       getText('h1') || getText('.lote-titulo') || getText('.titulo-lote'),
          price:       getText('.lance-atual') || getText('.valor-lance') || getText('[class*="lance"]'),
          location:    getText('.localizacao') || getText('[class*="local"]') || getText('[class*="cidade"]'),
          auctionDate: getText('[class*="data"]') || getText('.data-leilao'),
          images:      Array.from(document.querySelectorAll('[class*="foto"] img, [class*="imagem"] img, .carousel img'))
                         .map(img => (img as HTMLImageElement).src).filter(s => s && !s.includes('data:')).slice(0, 5),
          description: getText('[class*="descricao"]') || getText('[class*="observ"]'),
          edital:      getAttr('a[href*="edital"]', 'href'),
        }
      })

      if (!data.title) return null

      const sourceId = url.split('/lote/')[1]?.split('?')[0]?.split('/')[0] ?? url

      const priceStr  = data.price.replace(/[^0-9,]/g, '').replace(',', '.')
      const price     = parseFloat(priceStr) || 0

      const locParts  = data.location.split(/[-/,]/)
      const city      = locParts[0]?.trim() || 'Não informado'
      const stateRaw  = locParts[locParts.length - 1]?.trim().toUpperCase() || 'SP'
      const state     = stateRaw.length === 2 ? stateRaw : 'SP'

      const titleLower = data.title.toLowerCase()
      const auctionType: AuctionType =
        titleLower.includes('judicial') ? 'JUDICIAL' :
        titleLower.includes('banco') || titleLower.includes('financeira') ? 'BANCARIO' :
        'EXTRAJUDICIAL'

      return {
        sourceId,
        sourceName: 'vip_leiloes',
        sourceUrl:   url,
        title:       data.title.slice(0, 200),
        description: data.description || null,
        category:    'VEICULO' as AuctionCategory,
        auctionType,
        status:      'ACTIVE' as AuctionStatus,
        price:       price || 1000,
        city,
        state:       state.slice(0, 2),
        attrs: {
          origem: 'vip_leiloes',
          imagens: data.images,
          edital: data.edital,
        },
        scrapedAt:    new Date(),
        lastCheckedAt: new Date(),
      }

    } finally {
      await page.close()
    }
  }
}
