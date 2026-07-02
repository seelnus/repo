import { Body, Controller, Get, Post } from '@nestjs/common';
import { EvalService } from './eval.service';

// 本地测试专用（无鉴权）：仅当 ALLOW_DEV_FILL_LOGIN=true 时后端才放行，否则 403
@Controller('api/eval-dev')
export class EvalDevController {
  constructor(private readonly evalService: EvalService) {}

  @Get('contacts')
  contacts() {
    return this.evalService.devListContacts();
  }

  @Post('login')
  login(@Body('contactId') contactId: number) {
    return this.evalService.devFillLogin(Number(contactId));
  }
}
