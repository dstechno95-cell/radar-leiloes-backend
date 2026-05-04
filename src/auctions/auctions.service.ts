import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AuctionCategory, AuctionType, AuctionStatus, Prisma } from '@prisma/client'

interface FindAllParams {
  q?:           string
  category?:    AuctionCategory
  auctionType?: AuctionType
  state?:       string
  city?:        string
  minPrice?:    number
  maxPrice?:    number
  minDiscount?: number
  status?:      AuctionStatus
  sortBy?:      'price' | 'discountPct' | 'auctionDate' | 'createdAt'
  order?:       'asc' | 'desc'
  page?:        number
  limit?:       number
}

@Injectable()
export class AuctionsService {
  constructor(private prisma: PrismaService) {}

  async findAll(params: FindAllParams) {
    const {
      q, category, auctionType, state, city,
      minPrice, maxPrice, minDiscount,
      status = 'ACTIVE',
      sortBy = 'createdAt', order = 'desc',
      page = 1, limit = 12,
    } = params

    const where: Prisma.AuctionWhereInput = {
      status,
      ...(category    && { category }),
      ...(auctionType && { auctionType }),
      ...(state       && { state }),
      ...(city        && { city: { contains: city, mode: 'insensitive' } }),
      ...(minDiscount && { discountPct: { gte: minDiscount } }),
      ...((minPrice || maxPrice) && {
        price: {
          ...(minPrice && { gte: minPrice }),
          ...(maxPrice && { lte: maxPrice }),
        },
      }),
      ...(q && {
        OR: [
          { title:       { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { city:        { contains: q, mode: 'insensitive' } },
        ],
      }),
    }

    const [total, data] = await Promise.all([
      this.prisma.auction.count({ where }),
      this.prisma.auction.findMany({
        where,
        orderBy: { [sortBy]: order },
        skip: (page - 1) * limit,
        take: limit,
        include: { images: { orderBy: { order: 'asc' }, take: 1 } },
      }),
    ])

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }
  }

  async findById(id: string) {
    return this.prisma.auction.findUnique({
      where: { id },
      include: { images: { orderBy: { order: 'asc' } } },
    })
  }

  async findSimilar(id: string, category: AuctionCategory, limit = 3) {
    return this.prisma.auction.findMany({
      where: { category, status: 'ACTIVE', NOT: { id } },
      orderBy: { discountPct: 'desc' },
      take: limit,
      include: { images: { take: 1 } },
    })
  }

  async registerView(auctionId: string, userId: string) {
    return this.prisma.auctionView.create({
      data: { auctionId, userId },
    })
  }

  async toggleFavorite(auctionId: string, userId: string) {
    const existing = await this.prisma.favorite.findUnique({
      where: { userId_auctionId: { userId, auctionId } },
    })

    if (existing) {
      await this.prisma.favorite.delete({
        where: { userId_auctionId: { userId, auctionId } },
      })
      return { favorited: false }
    }

    await this.prisma.favorite.create({ data: { userId, auctionId } })
    return { favorited: true }
  }

  async getFavorites(userId: string) {
    const favs = await this.prisma.favorite.findMany({
      where: { userId },
      include: { auction: { include: { images: { take: 1 } } } },
      orderBy: { createdAt: 'desc' },
    })
    return favs.map(f => f.auction)
  }
}