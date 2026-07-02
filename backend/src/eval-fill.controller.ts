import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { FillAuthGuard } from './fill-auth.guard';
import { EvalService } from './eval.service';

// 填写端（员工）：企微登录后按评价关系拉取"待我填写"并逐份提交
@Controller('api/eval')
@UseGuards(FillAuthGuard)
export class EvalFillController {
  constructor(private readonly evalService: EvalService) {}

  @Get('tasks')
  myTasks(@Req() req: any) {
    return this.evalService.listMyTasks(req.fillUser);
  }

  @Get('tasks/:relationId')
  getTask(@Param('relationId', ParseIntPipe) relationId: number, @Req() req: any) {
    return this.evalService.getTask(relationId, req.fillUser);
  }

  @Post('tasks/:relationId/submit')
  submitTask(@Param('relationId', ParseIntPipe) relationId: number, @Body('answers') answers: Record<string, unknown>, @Req() req: any) {
    return this.evalService.submitTask(relationId, answers || {}, req.fillUser);
  }
}
