import { Controller, Post, Get, Body, UseGuards, Request } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { AuthService } from './auth.service'
import { IsEmail, IsString, MinLength } from 'class-validator'

class RegisterDto {
  @IsString() name: string
  @IsEmail() email: string
  @IsString() @MinLength(6) password: string
}

class LoginDto {
  @IsEmail() email: string
  @IsString() password: string
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto.name, dto.email, dto.password)
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password)
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  me(@Request() req: any) {
    return this.auth.me(req.user.sub)
  }
}