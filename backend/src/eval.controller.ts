import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
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

  @Get('templates')
  listTemplates() {
    return this.evalService.listTemplates();
  }

  @Post('templates')
  createTemplate(@Req() req: any, @Body() body: any) {
    return this.evalService.createTemplate(req.admin.sub, body);
  }

  @Put('templates/:id')
  updateTemplate(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.evalService.updateTemplate(id, body);
  }

  @Get('participant-candidates')
  participantCandidates() {
    return this.evalService.getParticipantCandidates();
  }

  @Get('cycles/:id/participants')
  participants(@Param('id', ParseIntPipe) id: number) {
    return this.evalService.listParticipants(id);
  }

  @Post('cycles/:id/participants/preview')
  previewParticipants(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.evalService.previewParticipants(id, body);
  }

  @Put('cycles/:id/participants')
  replaceParticipants(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.evalService.replaceParticipants(id, body, req.admin.sub);
  }

  @Post('cycles/:id/participants/copy')
  copyParticipants(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body('sourceCycleId', ParseIntPipe) sourceCycleId: number,
  ) {
    return this.evalService.copyParticipants(id, sourceCycleId, req.admin.sub);
  }

  @Put('cycles/:id/participants/:participantId')
  updateParticipant(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('participantId', ParseIntPipe) participantId: number,
    @Body() body: any,
  ) {
    return this.evalService.updateParticipant(
      id,
      participantId,
      body,
      req.admin.sub,
    );
  }

  @Put('cycles/:id/participants/:participantId/groups')
  updateParticipantGroups(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('participantId', ParseIntPipe) participantId: number,
    @Body() body: any,
  ) {
    return this.evalService.updateParticipantGroups(
      id,
      participantId,
      body,
      req.admin.sub,
    );
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

  @Post('relations/:relationId/exempt')
  exemptRelation(
    @Req() req: any,
    @Param('relationId', ParseIntPipe) relationId: number,
    @Body('reason') reason: string,
  ) {
    return this.evalService.exemptRelation(relationId, reason, req.admin.sub);
  }

  @Post('cycles/:id/publish')
  publish(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.evalService.publishCycle(id, req.admin.sub);
  }

  @Post('cycles/:id/close')
  close(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.evalService.closeCycle(id, req.admin.sub);
  }

  @Post('cycles/:id/reopen')
  reopen(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body('endAt') endAt: string,
  ) {
    return this.evalService.reopenCycle(id, endAt, req.admin.sub);
  }

  @Post('cycles/:id/lock')
  lock(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.evalService.lockCycle(id, req.admin.sub);
  }

  @Post('cycles/:id/archive')
  archive(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.evalService.archiveCycle(id, req.admin.sub);
  }

  @Get('cycles/:id/overview')
  overview(@Param('id', ParseIntPipe) id: number) {
    return this.evalService.getOverview(id);
  }

  @Get('cycles/:id/results')
  results(@Param('id', ParseIntPipe) id: number) {
    return this.evalService.listResults(id);
  }

  @Get('cycles/:id/progress/:contactId')
  progress(
    @Param('id', ParseIntPipe) id: number,
    @Param('contactId', ParseIntPipe) contactId: number,
  ) {
    return this.evalService.getRaterProgress(id, contactId);
  }

  @Get('cycles/:id/results/:contactId')
  report(
    @Param('id', ParseIntPipe) id: number,
    @Param('contactId', ParseIntPipe) contactId: number,
  ) {
    return this.evalService.getEmployeeReport(id, contactId);
  }

  @Get('cycles/:id/responses')
  rawResponses(@Param('id', ParseIntPipe) id: number) {
    return this.evalService.listRawResponses(id);
  }

  @Post('responses/:responseId/invalidate')
  invalidateResponse(
    @Req() req: any,
    @Param('responseId', ParseIntPipe) responseId: number,
    @Body('reason') reason: string,
  ) {
    return this.evalService.invalidateResponse(
      responseId,
      reason,
      req.admin.sub,
    );
  }

  @Post('responses/:responseId/restore')
  restoreResponse(
    @Req() req: any,
    @Param('responseId', ParseIntPipe) responseId: number,
  ) {
    return this.evalService.restoreResponse(responseId, req.admin.sub);
  }

  // 结果导出（Excel：自评/他评/领导评价 三分表，答案按题拆列）
  @Get('cycles/:id/export')
  async exportCycle(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const buffer = await this.evalService.exportCycle(id);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="eval-cycle-${id}.xlsx"`,
    });
    res.send(Buffer.from(buffer as any));
  }
}
