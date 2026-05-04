// src/app.module.ts
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from './prisma/prisma.module'
import { AuthModule } from './auth/auth.module'
import { UsersModule } from './users/users.module'
import { AuctionsModule } from './auctions/auctions.module'
import { AlertsModule } from './alerts/alerts.module'

@Module({
  imports: [
    // Carrega variáveis do .env globalmente
    ConfigModule.forRoot({ isGlobal: true }),

    // Banco de dados
    PrismaModule,

    // Módulos da aplicação
    AuthModule,
    UsersModule,
    AuctionsModule,
    AlertsModule,
  ],
})
export class AppModule {}