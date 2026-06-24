import { Body, Controller, Delete, Get, Header, Param, ParseIntPipe, Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SurveyStatus, SurveyType } from '@prisma/client';
import { diskStorage } from 'multer';
import { extname } from 'path';
import type { Response } from 'express';
import { AdminAuthGuard } from './admin-auth.guard';
import { AppService } from './app.service';

@Controller('api')
export class AppController {
  constructor(private readonly app: AppService) {}

  @Get('health')
  health() {
    return this.app.health();
  }

  @Post('admin/auth/login')
  login(@Body() body: any) {
    return this.app.login(body.phone, body.password);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/members')
  listMembers() {
    return this.app.listMembers();
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/members')
  createMember(@Body() body: any) {
    return this.app.createMember(body);
  }

  @UseGuards(AdminAuthGuard)
  @Delete('admin/members/:id')
  deleteMember(@Param('id', ParseIntPipe) id: number) {
    return this.app.deleteMember(id);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/contacts')
  listContacts(@Query('q') q?: string) {
    return this.app.listContacts(q);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/contacts')
  createContact(@Body() body: any) {
    return this.app.createContact(body);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/contacts/:id')
  updateContact(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.app.updateContact(id, body);
  }

  @UseGuards(AdminAuthGuard)
  @Delete('admin/contacts/:id')
  deleteContact(@Param('id', ParseIntPipe) id: number) {
    return this.app.deleteContact(id);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/contacts/import')
  importContacts(@Body() body: any) {
    return this.app.importContacts(body.rows || []);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/contacts/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportContacts(@Res() res: Response) {
    res.attachment('contacts.csv').send(await this.app.exportContacts());
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/surveys')
  listSurveys(@Query('keyword') keyword?: string, @Query('type') type?: SurveyType) {
    return this.app.listSurveys({ keyword, type });
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/surveys/:id')
  getAdminSurvey(@Param('id', ParseIntPipe) id: number) {
    return this.app.getAdminSurvey(id);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/surveys')
  createSurvey(@Req() req: any, @Body() body: any) {
    return this.app.createSurvey(req.admin.sub, body);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/surveys/:id')
  updateSurvey(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.app.updateSurvey(id, body);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/surveys/:id/publish')
  publishSurvey(@Param('id', ParseIntPipe) id: number) {
    return this.app.publishSurvey(id);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/surveys/:id/status')
  setSurveyStatus(@Param('id', ParseIntPipe) id: number, @Body('status') status: SurveyStatus) {
    return this.app.setSurveyStatus(id, status);
  }

  @UseGuards(AdminAuthGuard)
  @Delete('admin/surveys/:id')
  deleteSurvey(@Param('id', ParseIntPipe) id: number) {
    return this.app.deleteSurvey(id);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/surveys/:id/responses')
  listResponses(@Param('id', ParseIntPipe) id: number) {
    return this.app.listResponses(id);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/surveys/:id/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportSurvey(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    res.attachment(`survey-${id}.csv`).send(await this.app.exportSurvey(id));
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/whitelists')
  listWhitelists() {
    return this.app.listWhitelists();
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/whitelists/match-csv')
  matchWhitelistCsv(@Body() body: any) {
    return this.app.matchWhitelistCsv(body.rows || []);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/whitelists')
  createWhitelist(@Req() req: any, @Body() body: any) {
    return this.app.createWhitelist(req.admin.sub, body);
  }

  @UseGuards(AdminAuthGuard)
  @Get('admin/whitelists/:surveyId')
  getWhitelist(@Param('surveyId', ParseIntPipe) surveyId: number) {
    return this.app.getWhitelist(surveyId);
  }

  @UseGuards(AdminAuthGuard)
  @Put('admin/whitelists/:surveyId')
  updateWhitelist(@Param('surveyId', ParseIntPipe) surveyId: number, @Body() body: any) {
    return this.app.updateWhitelist(surveyId, body);
  }

  @UseGuards(AdminAuthGuard)
  @Delete('admin/whitelists/:surveyId')
  deleteWhitelist(@Param('surveyId', ParseIntPipe) surveyId: number) {
    return this.app.deleteWhitelist(surveyId);
  }

  @UseGuards(AdminAuthGuard)
  @Post('admin/responses/:id/comment')
  commentResponse(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.app.commentResponse(req.admin.sub, id, body);
  }

  @Post('uploads')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads',
        filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extname(file.originalname)}`),
      }),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File) {
    return { url: `/uploads/${file.filename}` };
  }

  @Get('wecom/oauth/url')
  wecomUrl() {
    return { mode: 'mock', url: '' };
  }

  @Get('wecom/oauth/callback')
  wecomCallback() {
    return { mode: 'mock', message: '开发环境使用模拟企微身份' };
  }

  @Get('survey/:shareToken')
  getPublicSurvey(@Param('shareToken') shareToken: string) {
    return this.app.getPublicSurvey(shareToken);
  }

  @Post('survey/:shareToken/submit')
  submitSurvey(@Param('shareToken') shareToken: string, @Body('answers') answers: Record<string, unknown>) {
    return this.app.submitSurvey(shareToken, answers || {});
  }
}
