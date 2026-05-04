import { Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { UsersService } from '../users/users.service'
import * as bcrypt from 'bcryptjs'

@Injectable()
export class AuthService {
  constructor(
    private users: UsersService,
    private jwt: JwtService,
  ) {}

  async register(name: string, email: string, password: string) {
    const user = await this.users.create({ name, email, password })
    const token = this.jwt.sign({ sub: user.id, email: user.email })
    return { token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan } }
  }

  async login(email: string, password: string) {
    const user = await this.users.findByEmail(email)
    if (!user || !user.passwordHash) throw new UnauthorizedException('Credenciais inválidas')

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) throw new UnauthorizedException('Credenciais inválidas')

    const token = this.jwt.sign({ sub: user.id, email: user.email })
    return { token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan } }
  }

  async me(userId: string) {
    const user = await this.users.findById(userId)
    if (!user) throw new UnauthorizedException()
    const { passwordHash, ...rest } = user
    return rest
  }
}