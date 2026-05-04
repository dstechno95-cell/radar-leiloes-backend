import { Controller, Get, Param, Post, Query, UseGuards, Request } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { AuctionsService } from './auctions.service'
import { AuctionCategory, AuctionType } from '@prisma/client'

@Controller('auctions')
export class AuctionsController {
  constructor(private auctions: AuctionsService) {}

  // GET /api/v1/auctions
  @Get()
  findAll(@Query() query: any) {
    return this.auctions.findAll({
      q:           query.q,
      category:    query.cat       as AuctionCategory,
      auctionType: query.type      as AuctionType,
      state:       query.state,
      city:        query.city,
      minPrice:    query.minPrice  ? Number(query.minPrice)  : undefined,
      maxPrice:    query.maxPrice  ? Number(query.maxPrice)  : undefined,
      minDiscount: query.minDisc   ? Number(query.minDisc)   : undefined,
      sortBy:      query.sortBy    ?? 'createdAt',
      order:       query.order     ?? 'desc',
      page:        query.page      ? Number(query.page)      : 1,
      limit:       query.limit     ? Number(query.limit)     : 12,
    })
  }

  // GET /api/v1/auctions/favorites
  @Get('favorites')
  @UseGuards(AuthGuard('jwt'))
  getFavorites(@Request() req: any) {
    return this.auctions.getFavorites(req.user.sub)
  }

  // GET /api/v1/auctions/:id
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.auctions.findById(id)
  }

  // GET /api/v1/auctions/:id/similar
  @Get(':id/similar')
  async findSimilar(@Param('id') id: string) {
    const auction = await this.auctions.findById(id)
    if (!auction) return []
    return this.auctions.findSimilar(id, auction.category)
  }

  // POST /api/v1/auctions/:id/view
  @Post(':id/view')
  @UseGuards(AuthGuard('jwt'))
  registerView(@Param('id') id: string, @Request() req: any) {
    return this.auctions.registerView(id, req.user.sub)
  }

  // POST /api/v1/auctions/:id/favorite
  @Post(':id/favorite')
  @UseGuards(AuthGuard('jwt'))
  toggleFavorite(@Param('id') id: string, @Request() req: any) {
    return this.auctions.toggleFavorite(id, req.user.sub)
  }
}