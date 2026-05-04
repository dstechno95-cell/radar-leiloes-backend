import { Injectable, ConflictException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import * as bcrypt from 'bcryptjs'

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } })
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } })
  }

  async create(data: { name: string; email: string; password: string }) {
    const exists = await this.findByEmail(data.email)
    if (exists) throw new ConflictException('E-mail já cadastrado')

    const passwordHash = await bcrypt.hash(data.password, 10)
    return this.prisma.user.create({
      data: { name: data.name, email: data.email, passwordHash },
    })
  }
}