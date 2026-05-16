import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from './prisma/prisma.module'
import { AuthModule } from './auth/auth.module'
import { UsersModule } from './users/users.module'
import { AuctionsModule } from './auctions/auctions.module'
import { AlertsModule } from './alerts/alerts.module'
import { ScraperModule } from './scraper/scraper.module'
import { FipeModule } from './fipe/fipe.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    AuctionsModule,
    AlertsModule,
    ScraperModule,
    FipeModule,
  ],
})
export class AppModule {}