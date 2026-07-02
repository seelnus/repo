import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminAuthGuard } from './admin-auth.guard';
import { EvalService } from './eval.service';

@Controller('api/admin/eval')
@UseGuards(AdminAuthGuard)
export class EvalController {
  constructor(private readonly evalService: EvalService) {}

  @Get('cycles')
  listCycles() {
    return this.evalService.listCycles();
  }

  @Post('cycles')
  createCycle(@Req() req: any, @Body() body: any) {
    return this.evalService.createCycle(req.admin.sub, body);
  }

  @Get('cycles/:id')
  getCycle(@Param('id', ParseIntPipe) id: number) {
    return this.evalService.getCycle(id);
  }

  @Put('cycles/:id')
  updateCycle(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.evalService.updateCycle(id, body);
  }

  @Delete('cycles/:id')
  deleteCycle(@Param('id', ParseIntPipe) id: number) {
    return this.evalService.deleteCycle(id);
  }

  @Post('cycles/:id/generate')
  generate(@Param('id', ParseIntPipe) id: number) {
    return this.evalService.generateRelations(id);
  }

  // 复核列表（覆盖度看板 = 异常报告）
  @Get('cycles/:id/review')
  review(@Param('id', ParseIntPipe) id: number) {
    return this.evalService.getReviewList(id);
  }

  // 关系明细 + 人工配置（领导 / 异常补配）
  @Get('cycles/:id/relations')
  listRelations(@Param('id', ParseIntPipe) id: number) {
    return this.evalService.listRelations(id);
  }

  @Post('cycles/:id/relations')
  addRelation(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.evalService.addManualRelation(id, body);
  }

  @Delete('relations/:relationId')
  deleteRelation(@Param('relationId', ParseIntPipe) relationId: number) {
    return this.evalService.deleteRelation(relationId);
  }

  // 结果导出（Excel：自评/他评/领导评价 三分表，答案按题拆列）
  @Get('cycles/:id/export')
  async exportCycle(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const buffer = await this.evalService.exportCycle(id);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="eval-cycle-${id}.xlsx"`,
    });
    res.send(Buffer.from(buffer as any));
  }
}
