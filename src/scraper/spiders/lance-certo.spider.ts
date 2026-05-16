import { Injectable, Logger } from '@nestjs/common'
import { AuctionCategory, AuctionStatus, AuctionType, Prisma } from '@prisma/client'
import { chromium } from 'playwright-core'

// Lance Certo roda na plataforma VIP Leilões (JavaScript-rendered).
// Usa Playwright para renderizar o conteúdo dinâmico.
const BASE_URL = 'https://www.lancecertoleiloes.com.br'
const LIST_URLS = [
  `${BASE_URL}/filtro/carros`,
  `${BASE_URL}/filtro/motos`,
  `${BASE_URL}/filtro/pesados`,
]

@Injectable()
export class LanceCertoSpider {
  private readonly logger = new Logger(LanceCertoSpider.name)

  async scrape(): Promise<Prisma.AuctionCreateInput[]> {
    this.logger.log('🕷 Lance Certo — iniciando scraping (Playwright)...')
    const results: Prisma.AuctionCreateInput[] = []
    const seen = new Set<string>()

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        locale: 'pt-BR',
      })

      for (const listUrl of LIST_URLS) {
        try {
          const page = await context.newPage()
          await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
          await page.waitForTimeout(2000)

          // Extrai cards da listagem
          const items = await page.evaluate(() => {
            const cards: Array<{title:string; price:string; href:string; location:string; img:string}> = []
            const els = document.querySelectorAll('a[href*="/leilao/"], a[href*="/lote/"], [class*="card"], [class*="lote"], [class*="item"]')
            els.forEach(el => {
              const anchor = el.tagName === 'A' ? el as HTMLAnchorElement : el.querySelector('a')
              if (!anchor) return
              const title = (el.querySelector('h1,h2,h3,h4,[class*="title"],[class*="titulo"],[class*="modelo"]') as HTMLElement)?.innerText?.trim() ?? ''
              const price = (el.querySelector('[class*="lance"],[class*="valor"],[class*="preco"],[class*="price"]') as HTMLElement)?.innerText?.trim() ?? ''
              const location = (el.querySelector('[class*="local"],[class*="cidade"],[class*="estado"]') as HTMLElement)?.innerText?.trim() ?? ''
              const img   = (el.querySelector('img') as HTMLImageElement)?.src ?? ''
              if (title && title.length > 3) {
                cards.push({ title, price, href: anchor.href, location, img })
              }
            })
            return cards
          })

          for (const item of items.slice(0, 20)) {
            const sourceId = item.href.split('/').filter(Boolean).pop() ?? Math.random().toString(36).slice(2)
            if (seen.has(sourceId)) continue
            seen.add(sourceId)

            const price = this.parsePrice(item.price)
            const { city, state } = this.parseLocation(item.location)
            const category = this.detectCategory(listUrl, item.title)

            results.push({
              sourceId,
              sourceName:  'lance_certo',
              sourceUrl:   item.href,
              title:       item.title.slice(0, 200),
              category,
              auctionType: 'EXTRAJUDICIAL' as AuctionType,
              status:      'ACTIVE' as AuctionStatus,
              price:       price || 5000,
              city,
              state,
              attrs: { origem: 'lance_certo', imagens: item.img ? [item.img] : [] },
              scrapedAt:     new Date(),
              lastCheckedAt: new Date(),
            })
          }

          await page.close()
          this.logger.log(`${listUrl}: ${items.length} cards encontrados`)
          await this.delay(2000)
        } catch (e) {
          this.logger.warn(`Erro em ${listUrl}: ${String(e)}`)
        }
      }
    } catch (e) {
      this.logger.error(`Lance Certo falhou: ${String(e)}`)
    } finally {
      await browser?.close()
    }

    this.logger.log(`✅ Lance Certo: ${results.length} lotes extraídos`)
    return results
  }

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
    if (combined.includes('imovel') || combined.includes('imóvel') || combined.includes('casa')) {
      return 'IMOVEL'
    }
    return 'VEICULO'
  }

  private delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
