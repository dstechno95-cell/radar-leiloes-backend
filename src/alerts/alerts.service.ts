import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class AlertsService {
  constructor(private prisma: PrismaService) {}

  async findAll(userId: string) {
    return this.prisma.savedSearch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { matches: true } },
      },
    })
  }

  async create(userId: string, data: {
    name: string
    filters: object
    notifyByEmail?: boolean
    notifyByWhatsApp?: boolean
  }) {
    return this.prisma.savedSearch.create({
      data: {
        userId,
        name:             data.name,
        filters:          data.filters,
        notifyByEmail:    data.notifyByEmail    ?? true,
        notifyByWhatsApp: data.notifyByWhatsApp ?? false,
      },
    })
  }

  async toggle(id: string, userId: string) {
    const alert = await this.prisma.savedSearch.findUnique({ where: { id } })
    if (!alert)            throw new NotFoundException('Alerta não encontrado')
    if (alert.userId !== userId) throw new ForbiddenException()

    return this.prisma.savedSearch.update({
      where: { id },
      data:  { alertEnabled: !alert.alertEnabled },
    })
  }

  async remove(id: string, userId: string) {
    const alert = await this.prisma.savedSearch.findUnique({ where: { id } })
    if (!alert)            throw new NotFoundException('Alerta não encontrado')
    if (alert.userId !== userId) throw new ForbiddenException()

    await this.prisma.savedSearch.delete({ where: { id } })
    return { deleted: true }
  }

  async getNotifications(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data:  { readAt: new Date(), status: 'READ' },
    })
    return { updated: true }
  }

  // Job interno: verifica novos leilões contra alertas ativos
  async runMatchJob() {
    const alerts = await this.prisma.savedSearch.findMany({
      where: { alertEnabled: true },
    })

    let totalMatches = 0

    for (const alert of alerts) {
      const filters = alert.filters as any

      const auctions = await this.prisma.auction.findMany({
        where: {
          status: 'ACTIVE',
          ...(filters.category  && { category:    filters.category }),
          ...(filters.state     && { state:        filters.state }),
          ...(filters.minPrice  && { price:        { gte: filters.minPrice } }),
          ...(filters.maxPrice  && { price:        { lte: filters.maxPrice } }),
          ...(filters.minDiscount && { discountPct: { gte: filters.minDiscount } }),
          ...(filters.q && {
            OR: [
              { title: { contains: filters.q, mode: 'insensitive' } },
              { city:  { contains: filters.q, mode: 'insensitive' } },
            ],
          }),
          // Só leilões ainda não notificados para este alerta
          NOT: {
            savedSearchMatches: {
              some: { savedSearchId: alert.id },
            },
          },
        },
        take: 10,
      })

      for (const auction of auctions) {
        // Registra o match
        await this.prisma.savedSearchMatch.create({
          data: { savedSearchId: alert.id, auctionId: auction.id },
        })

        // Cria notificação
        await this.prisma.notification.create({
          data: {
            userId:       alert.userId,
            savedSearchId: alert.id,
            auctionId:    auction.id,
            type:         'ALERT_MATCH',
            title:        `Novo leilão: ${alert.name}`,
            body:         `${auction.title} por ${auction.price}`,
            channel:      alert.notifyByWhatsApp ? 'WHATSAPP' : 'EMAIL',
            status:       'PENDING',
          },
        })

        totalMatches++
      }

      // Atualiza contagem do alerta
      if (auctions.length > 0) {
        await this.prisma.savedSearch.update({
          where: { id: alert.id },
          data: {
            matchCount:     { increment: auctions.length },
            lastTriggeredAt: new Date(),
          },
        })
      }
    }

    return { processed: alerts.length, totalMatches }
  }
}