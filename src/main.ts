import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
  }))

  app.enableCors({
    origin: true, // permite qualquer origem por enquanto
    credentials: true,
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization'],
  })

  app.setGlobalPrefix('api/v1')

  const port = process.env.PORT || 3001
  await app.listen(port, '0.0.0.0') // 0.0.0.0 é obrigatório no Railway
  console.log(`🚀 API rodando na porta ${port}`)
}
bootstrap()