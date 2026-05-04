import { Controller, Get, Post, Delete, Patch, Body, Param, UseGuards, Request } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { AlertsService } from './alerts.service'
import { IsString, IsObject, IsBoolean, IsOptional } from 'class-validator'

class CreateAlertDto {
  @IsString()
  name!: string

  @IsObject()
  filters!: object

  @IsBoolean() @IsOptional()
  notifyByEmail?: boolean

  @IsBoolean() @IsOptional()
  notifyByWhatsApp?: boolean
}

@Controller('alerts')
@UseGuards(AuthGuard('jwt'))
export class AlertsController {
  constructor(private alerts: AlertsService) {}

  // GET /api/v1/alerts
  @Get()
  findAll(@Request() req: any) {
    return this.alerts.findAll(req.user.sub)
  }

  // POST /api/v1/alerts
  @Post()
  create(@Request() req: any, @Body() dto: CreateAlertDto) {
    return this.alerts.create(req.user.sub, dto)
  }

  // PATCH /api/v1/alerts/:id/toggle
  @Patch(':id/toggle')
  toggle(@Param('id') id: string, @Request() req: any) {
    return this.alerts.toggle(id, req.user.sub)
  }

  // DELETE /api/v1/alerts/:id
  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.alerts.remove(id, req.user.sub)
  }

  // GET /api/v1/alerts/notifications
  @Get('notifications')
  getNotifications(@Request() req: any) {
    return this.alerts.getNotifications(req.user.sub)
  }

  // POST /api/v1/alerts/notifications/read
  @Post('notifications/read')
  markAllRead(@Request() req: any) {
    return this.alerts.markAllRead(req.user.sub)
  }
}