// src/fipe/fipe.service.ts
// Integração com API FIPE gratuita + cálculo de score de oportunidade

import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'

const FIPE_BASE = 'https://fipe.parallelum.com.br/api/v2'

// Cache em memória para evitar requisições repetidas
const cache = new Map<string, { value: number; ts: number }>()
const CACHE_TTL = 1000 * 60 * 60 * 24 // 24h

interface FipeBrand  { code: string; name: string }
interface FipeModel  { codigos: string; nome: string }
interface FipeYear   { code: string; name: string }
interface FipePrice  { price: string; brand: string; model: string; modelYear: number; fuel: string; fipeCode: string }

@Injectable()
export class FipeService {
  private readonly logger = new Logger(FipeService.name)

  // ── Busca valor FIPE por marca/modelo/ano extraídos do título ─────────────
  async getValueByTitle(title: string): Promise<number | null> {
    try {
      const { marca, modelo, ano } = this.extractVehicleInfo(title)
      if (!marca || !modelo) return null

      const cacheKey = `${marca}-${modelo}-${ano}`
      const cached   = cache.get(cacheKey)
      if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.value

      // 1. Busca marcas
      const brands: FipeBrand[] = await this.get('/cars/brands')
      const brand = brands.find(b =>
        b.name.toLowerCase().includes(marca.toLowerCase()) ||
        marca.toLowerCase().includes(b.name.toLowerCase().split(' ')[0])
      )
      if (!brand) return null

      // 2. Busca modelos
      const modelsRes = await this.get(`/cars/brands/${brand.code}/models`)
      const models: FipeModel[] = modelsRes.models ?? modelsRes
      const model = models.find((m: FipeModel) =>
        m.nome.toLowerCase().includes(modelo.toLowerCase()) ||
        modelo.toLowerCase().includes(m.nome.toLowerCase().split(' ')[0])
      )
      if (!model) return null

      // 3. Busca anos
      const years: FipeYear[] = await this.get(`/cars/brands/${brand.code}/models/${model.codigos}/years`)
      const year = years.find(y => ano ? y.name.startsWith(String(ano)) : true) ?? years[0]
      if (!year) return null

      // 4. Busca preço
      const priceData: FipePrice = await this.get(`/cars/brands/${brand.code}/models/${model.codigos}/years/${year.code}`)
      const price = this.parsePrice(priceData.price)

      if (price > 0) {
        cache.set(cacheKey, { value: price, ts: Date.now() })
        this.logger.log(`FIPE: ${marca} ${modelo} ${ano} = R$ ${price.toLocaleString('pt-BR')}`)
      }

      return price || null

    } catch (e) {
      this.logger.warn(`Erro FIPE para "${title}": ${e}`)
      return null
    }
  }

  // ── Extrai marca, modelo e ano do título do leilão ────────────────────────
  extractVehicleInfo(title: string): { marca: string; modelo: string; ano: number | null } {
    const text = title.toUpperCase()

    // Marcas conhecidas
    const marcas = [
      'CHEVROLET','VOLKSWAGEN','VW','FIAT','FORD','HONDA','TOYOTA','HYUNDAI',
      'RENAULT','NISSAN','JEEP','MITSUBISHI','PEUGEOT','CITROEN','KIA',
      'BMW','MERCEDES','AUDI','VOLVO','LAND ROVER','DODGE','CHRYSLER',
      'YAMAHA','KAWASAKI','SUZUKI','DUCATI','HARLEY',
    ]

    let marca  = ''
    let modelo = ''

    for (const m of marcas) {
      if (text.includes(m)) {
        marca = m === 'VW' ? 'VOLKSWAGEN' : m
        // Pega a palavra após a marca como modelo
        const afterMarca = title.slice(text.indexOf(m) + m.length).trim()
        modelo = afterMarca.split(/[\s,/]+/)[0] || ''
        break
      }
    }

    // Extrai ano (4 dígitos entre 1990 e 2030)
    const anoMatch = title.match(/\b(19[9]\d|20[0-3]\d)\b/)
    const ano      = anoMatch ? Number(anoMatch[1]) : null

    return { marca, modelo, ano }
  }

  // ── Calcula score de oportunidade ─────────────────────────────────────────
  calculateScore(params: {
    price:       number
    fipeValue:   number | null
    title:       string
    description: string | null
  }): {
    score:        number
    label:        'EXCELENTE' | 'BOA' | 'MEDIA' | 'BAIXA'
    discountPct:  number
    details:      string[]
  } {
    const { price, fipeValue, title, description } = params
    const details: string[] = []
    let score = 50 // base

    const text = `${title} ${description ?? ''}`.toLowerCase()

    // ── Fator 1: Desconto sobre FIPE (peso 50 pts) ────────────────────────
    let discountPct = 0
    if (fipeValue && fipeValue > 0 && price > 0) {
      discountPct = Math.round((1 - price / fipeValue) * 100)

      if (discountPct >= 50) { score += 50; details.push(`🔥 ${discountPct}% abaixo da FIPE`) }
      else if (discountPct >= 40) { score += 40; details.push(`✅ ${discountPct}% abaixo da FIPE`) }
      else if (discountPct >= 30) { score += 30; details.push(`👍 ${discountPct}% abaixo da FIPE`) }
      else if (discountPct >= 20) { score += 15; details.push(`📉 ${discountPct}% abaixo da FIPE`) }
      else if (discountPct >= 10) { score += 5;  details.push(`➡ ${discountPct}% abaixo da FIPE`) }
      else if (discountPct < 0)   { score -= 20; details.push(`⚠ Acima da FIPE em ${Math.abs(discountPct)}%`) }
    }

    // ── Fator 2: Palavras positivas (peso +pts cada) ──────────────────────
    const positivos: [string, number, string][] = [
      ['motor funcionando',  10, '✅ Motor funcionando'],
      ['funcionando',         5, '✅ Funcionando'],
      ['revisado',            8, '✅ Revisado'],
      ['conservado',          6, '✅ Conservado'],
      ['único dono',          8, '✅ Único dono'],
      ['chave disponível',    5, '✅ Chave disponível'],
      ['sem débitos',         5, '✅ Sem débitos'],
      ['lacrado',             6, '✅ Lacrado'],
      ['baixa km',            7, '✅ Baixa quilometragem'],
      ['pouco rodado',        7, '✅ Pouco rodado'],
    ]

    for (const [kw, pts, label] of positivos) {
      if (text.includes(kw)) { score += pts; details.push(label) }
    }

    // ── Fator 3: Palavras de atenção (desconta pts) ───────────────────────
    const negativos: [string, number, string][] = [
      ['sem chave',     -8,  '⚠ Sem chave'],
      ['batendo',       -10, '⚠ Motor batendo'],
      ['sinistrado',    -15, '⚠ Sinistrado'],
      ['sucata',        -20, '⚠ Sucata'],
      ['queimado',      -15, '⚠ Queimado'],
      ['alagado',       -12, '⚠ Alagado'],
      ['sem documento', -10, '⚠ Sem documentação'],
      ['não liga',      -12, '⚠ Não liga'],
      ['para peças',    -20, '⚠ Para peças'],
    ]

    for (const [kw, pts, label] of negativos) {
      if (text.includes(kw)) { score += pts; details.push(label) }
    }

    // ── Fator 4: Veículos populares (mais fácil revender) ────────────────
    const populares = ['gol','celta','palio','uno','corsa','onix','hb20','ka','fiesta','clio']
    if (populares.some(m => text.includes(m))) {
      score += 5
      details.push('🔄 Veículo popular — fácil revenda')
    }

    // Limita entre 0 e 100
    score = Math.max(0, Math.min(100, score))

    const label =
      score >= 75 ? 'EXCELENTE' :
      score >= 55 ? 'BOA' :
      score >= 35 ? 'MEDIA' : 'BAIXA'

    return { score, label, discountPct, details }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private async get(endpoint: string): Promise<any> {
    const res = await axios.get(`${FIPE_BASE}${endpoint}`, {
      timeout: 8000,
      headers: { 'Accept': 'application/json' },
    })
    return res.data
  }

  private parsePrice(priceStr: string): number {
    if (!priceStr) return 0
    return Number(priceStr.replace(/[^0-9,]/g,'').replace(',','.')) || 0
  }
}